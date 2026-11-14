# 双女·长夜调情（drama 6）无人值守流水线 —— 同 drama5 的逻辑，只换 DRAMA/STATE。
# 全部走平台接口（/api/v1），不手搓 ComfyUI 图。状态以 DB 为准，state 文件只记「一次性动作已触发」。
import json, os, sqlite3, sys, time, urllib.request

BASE = 'http://127.0.0.1:5679/api/v1'
DB = r'E:\pycharm\huobao-drama\data\huobao.sqlite3'
STATE = r'E:\pycharm\huobao-drama\backend\.supervise_flirt_state.json'
DRAMA = 6
ACTIVE = ('processing', 'pending', 'queued', 'running')
# 平台侧轮询 600 次 × 10s = 100 分钟就判失败（generation.ts POLL_PROFILES）。
# 一次把 14 镜全塞进队列，后 12 镜排队就超过 100 分钟 → 未开跑先被判死（1109 03:45 实测）。
# 1109 起二采（小脸修复）在生产上：基片跑完立刻提交二采，ComfyUI 是 FIFO 单队列。
# 若还有第二镜的基片在排队/在跑，二采就要在它后面等 30+ 分钟，超过 face-refine.ts 的 40 分钟上限
# → 二采白跑一遍再被丢掉。GPU 本来就是串行跑（两条在飞也不并行），所以在飞改 1 条：
# 基片结束队列为空，二采立刻开跑（约 13 分钟 ≪ 40），吞吐不变（受 30 分钟巡检节奏约束，约 1 镜/小时）。
MAX_INFLIGHT = 1
SLOT_AFTER_SEC = 20 * 60
# 1109 用户「先关掉小脸修复 接pika试试」：
#   REFINE=False ⇒ body 带 refine:false，二采整条不跑（wantsFaceRefine 只认显式 false）。
#   GRAPH ⇒ 显式 body graph 走桥 workflows/h3_pika_flex_1shot.json（Pika 6 步）。
#   回退：GRAPH='' 即回 native 一条龙；REFINE=True 恢复二采。
# 1113：切 native 试过一次，用户「撤回去」⇒ 回 Pika。sb2/task 895 已在 native 上跑，留着当对账。
# 1113 晚 用户「我是说切到 pika」⇒ 生产就用 Pika 图（DiT 本来就是 nvfp4，11.9 GB，步时 150 s）。
GRAPH = 'h3_pika_flex_1shot.json'
REFINE = False


def api(method, path, body=None, timeout=1800):
    data = json.dumps(body, ensure_ascii=False).encode('utf-8') if body is not None else None
    req = urllib.request.Request(BASE + path, data=data, method=method,
                                 headers={'Content-Type': 'application/json'})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode('utf-8'))


def payload(resp):
    return resp.get('data', resp) if isinstance(resp, dict) else resp


def conn():
    c = sqlite3.connect(DB)
    c.row_factory = sqlite3.Row
    return c


def load_state():
    try:
        with open(STATE, encoding='utf-8') as f:
            return json.load(f)
    except Exception:
        return {}


def save_state(s):
    with open(STATE, 'w', encoding='utf-8') as f:
        json.dump(s, f, ensure_ascii=False, indent=1)


def refs_for(c, sb):
    refs = []
    for r in c.execute(
        'select ch.image_url from storyboard_characters sc join characters ch on ch.id=sc.character_id '
        'where sc.storyboard_id=? and ch.deleted_at is null and ch.image_url is not null order by ch.id',
        (sb['id'],)
    ):
        refs.append(r['image_url'])
    sc = c.execute('select grid_image_url,image_url from scenes where id=?', (sb['scene_id'],)).fetchone()
    if sc:
        refs.append(sc['grid_image_url'] or sc['image_url'])
    for r in c.execute(
        'select p.image_url from storyboard_props sp join props p on p.id=sp.prop_id '
        'where sp.storyboard_id=? and p.deleted_at is null and p.image_url is not null order by p.id',
        (sb['id'],)
    ):
        refs.append(r['image_url'])
    return list(dict.fromkeys([x for x in refs if x]))[:9]


def current_episode(c):
    for ep in c.execute('select * from episodes where drama_id=? and deleted_at is null order by episode_number', (DRAMA,)):
        m = c.execute('select status from video_merges where episode_id=? order by id desc limit 1', (ep['id'],)).fetchone()
        if m and m['status'] == 'completed':
            continue
        return ep
    return None


def active_tasks(c, type_, key, ids):
    if not ids:
        return 0
    q = ','.join('?' * len(ids))
    ph = ','.join('?' * len(ACTIVE))
    return c.execute(
        f"select count(*) n from sys_task where type=? and {key} in ({q}) and status in ({ph})",
        [type_, *ids, *ACTIVE]
    ).fetchone()['n']


def linked_assets(c, eid):
    chars = [dict(r) for r in c.execute(
        'select ch.* from episode_characters ec join characters ch on ch.id=ec.character_id '
        'where ec.episode_id=? and ch.deleted_at is null order by ch.id', (eid,))]
    scenes = [dict(r) for r in c.execute(
        'select s.* from episode_scenes es join scenes s on s.id=es.scene_id '
        'where es.episode_id=? and s.deleted_at is null order by s.id', (eid,))]
    props = [dict(r) for r in c.execute(
        'select p.* from episode_props ep join props p on p.id=ep.prop_id '
        'where ep.episode_id=? and p.deleted_at is null order by p.id', (eid,))]
    return chars, scenes, props


def breakdown_message(chars, scenes, props):
    cl = '、'.join(f"{x['name']}(ID:{x['id']})" for x in chars) or '（当前集还没有角色）'
    sl = '、'.join(f"{x.get('location','')} · {x.get('time') or '未设时间'}(ID:{x['id']})" for x in scenes) or '（当前集还没有场景）'
    pl = '、'.join(f"{x['name']}(ID:{x['id']})" for x in props) or '（当前集还没有道具）'
    return f'''请基于当前集剧本拆分分镜，并为每个分镜段落同时生成 video_prompt（视频生成提示词）。
本次视频模型：MiniMax H3 Reference-to-Video，请按该模型的特性与时长限制生成 video_prompt。

当前集已有角色：{cl}
当前集已有场景：{sl}
当前集已有道具：{pl}

绑定要求：
- 每个镜头必须根据剧本内容，从上述当前集已有角色中选出出场的角色绑定 character_ids（ID 必须来自上述列表；有角色出场就必须绑定，不要遗漏）
- 每个镜头尽量匹配上述已有场景填写 scene_id（ID 必须来自上述列表），不要凭空创造新场景
- 每个镜头出现关键道具（被使用、交接、特写或在画面中明显可见）时，从上述当前集已有道具中绑定 prop_ids（ID 必须来自上述列表）；没有道具出现可传空数组
- 只有纯环境空镜头才可以不绑定角色'''


def main():
    c = conn()
    st = load_state()
    ep = current_episode(c)
    if not ep:
        print('DONE 全部 100 集已合并完成')
        return
    eid, no = ep['id'], ep['episode_number']
    sbs = [dict(r) for r in c.execute(
        'select * from storyboards where episode_id=? and deleted_at is null order by storyboard_number', (eid,))]

    if sbs:
        sids = [s['id'] for s in sbs]
        running = active_tasks(c, 'video', 'storyboard_id', sids)
        done = [s for s in sbs if s['video_url']]
        if running >= MAX_INFLIGHT:
            print(f'ep{no} 出片中 {len(done)}/{len(sbs)}，另有 {running} 条在跑/排队')
            return
        if len(done) == len(sbs):
            m = c.execute('select id,status,merged_url from video_merges where episode_id=? order by id desc limit 1', (eid,)).fetchone()
            if m and m['status'] == 'completed':
                print(f'ep{no} 已合并 {m["merged_url"]}')
                return
            if m and m['status'] in ACTIVE:
                print(f'ep{no} 合并中（merge {m["id"]} {m["status"]}）')
                return
            # merge 路由挂在 /merge 前缀下（index.ts:70 `api.route('/merge', merge)`），
            # 真实路径是 /merge/episodes/:id/merge；/episodes/:id/merge 只命中静态 catch-all（POST 404）。
            r = payload(api('POST', f'/merge/episodes/{eid}/merge', {}))
            print(f'ep{no} {len(sbs)} 镜齐 → 触发合并 {r}')
            return
        ph = ','.join('?' * len(ACTIVE))
        busy = {r['storyboard_id'] for r in c.execute(
            f"select distinct storyboard_id from sys_task where type='video' and storyboard_id in "
            f"({','.join('?' * len(sids))}) and status in ({ph})", [*sids, *ACTIVE])}
        missing = [s for s in sbs if not s['video_url'] and s['id'] not in busy]
        noprompt = [s for s in missing if not (s['video_prompt_full_ref'] or '').strip()]
        if noprompt:
            try:
                ps = payload(api('GET', f'/episodes/{eid}/video-prompts-status'))
            except Exception:
                ps = None
            if ps and ps.get('status') == 'running':
                print(f'ep{no} 提示词批量生成中 {ps.get("completed")}/{ps.get("total")}')
                return
            # 批量接口不带 storyboard_ids 时只挑 `video_prompt` 为空的分镜；拆镜 Agent 偶尔会顺手写上
            # `video_prompt` 却不写 `video_prompt_full_ref`（1109 ep2 八镜全这样），于是 total=0 空转。
            # 显式传 id 时接口会连提示词一起重生成（routes/episodes.ts:162-167）。
            r = payload(api('POST', f'/episodes/{eid}/generate-video-prompts', {'storyboard_ids': [s['id'] for s in noprompt]}))
            print(f'ep{no} 缺 {len(noprompt)} 条 full_ref → 触发批量提示词 {r}')
            return
        fired = []
        budget = max(0, MAX_INFLIGHT - running)
        if running == 0:
            budget = 1
        elif running == 1:
            ph = ','.join('?' * len(ACTIVE))
            row = c.execute(
                f"select created_at from sys_task where type='video' and storyboard_id in ({','.join('?' * len(sids))}) "
                f"and status in ({ph}) order by id limit 1", [*sids, *ACTIVE]).fetchone()
            if row:
                from datetime import datetime
                age = time.time() - datetime.fromisoformat(row['created_at'].replace('Z', '+00:00')).timestamp()
                if age < SLOT_AFTER_SEC:
                    budget = 0
        for s in missing[:budget]:
            key = f'retry:{eid}:{s["id"]}'
            n = st.get(key, 0)
            if n >= 10:
                fired.append(f'sb{s["storyboard_number"]}=放弃(已重试{n}次)')
                continue
            refs = refs_for(c, s)
            body = {
                'type': 'video', 'storyboard_id': s['id'], 'drama_id': DRAMA,
                'prompt': s['video_prompt_full_ref'], 'duration': s['duration'],
                'aspect_ratio': '16:9', 'generate_audio': True,
                'model': 'minimax-h3-ref2v', 'config_id': 3,
                'reference_image_urls': refs, 'chain': True,
                'graph': GRAPH or None, 'refine': REFINE,
            }
            try:
                r = payload(api('POST', '/tasks', body, timeout=120))
                st[key] = n + 1
                fired.append(f'sb{s["storyboard_number"]}->task {r.get("id") if isinstance(r, dict) else r}')
            except Exception as e:
                fired.append(f'sb{s["storyboard_number"]}=ERR {str(e)[:80]}')
        save_state(st)
        print(f'ep{no} 补发 {len(fired)} 镜: ' + '; '.join(fired))
        return

    # ---- 无分镜：剧本 → 提取 → 资产图 → 拆镜 ----
    if not (ep['script_content'] or '').strip():
        r = payload(api('POST', '/agent/script_rewriter/chat', {
            'message': '请读取剧本并改写为格式化剧本，然后保存',
            'drama_id': DRAMA, 'episode_id': eid,
        }, timeout=2400))
        print(f'ep{no} 剧本改写返回: {str(r)[:200]}')
        return

    chars, scenes, props = linked_assets(c, eid)
    ekey = f'extract:{eid}'
    if not (chars or scenes or props):
        if not st.get(ekey):
            for target in ('characters', 'scenes', 'props'):
                try:
                    api('POST', f'/episodes/{eid}/extract', {'target': target}, timeout=120)
                except Exception as e:
                    print(f'ep{no} 触发提取 {target} 失败: {e}')
            st[ekey] = 1
            save_state(st)
            print(f'ep{no} 触发角色/场景/道具提取')
            return
        try:
            stat = payload(api('GET', f'/episodes/{eid}/extract-status')) or {}
        except Exception:
            stat = {}
        if any((v or {}).get('status') == 'running' for v in stat.values()):
            print(f'ep{no} 资产提取中: { {k: (v or {}).get("status") for k, v in stat.items()} }')
            return
        print(f'ep{no} 提取已结束但本集没有关联任何角色/场景/道具 —— 停在这里等人工')
        return

    # 资产图
    miss_chars = [x for x in chars if not x.get('image_url')]
    miss_scenes = [x for x in scenes if not (x.get('grid_image_url') or x.get('image_url'))]
    miss_props = [x for x in props if not x.get('image_url')]
    if active_tasks(c, 'image', 'character_id', [x['id'] for x in miss_chars]) or \
       active_tasks(c, 'image', 'scene_id', [x['id'] for x in miss_scenes]) or \
       active_tasks(c, 'image', 'prop_id', [x['id'] for x in miss_props]):
        print(f'ep{no} 资产图生成中（角色缺 {len(miss_chars)} / 场景缺 {len(miss_scenes)} / 道具缺 {len(miss_props)}）')
        return
    fired = []
    if miss_chars:
        try:
            api('POST', '/characters/batch-generate-images', {
                'character_ids': [x['id'] for x in miss_chars], 'episode_id': eid}, timeout=120)
            fired.append(f'角色{len(miss_chars)}')
        except Exception as e:
            fired.append(f'角色ERR {str(e)[:60]}')
    for x in miss_scenes:
        try:
            api('POST', f'/scenes/{x["id"]}/generate-image', {'episode_id': eid}, timeout=120)
            fired.append(f'场景{x["id"]}')
        except Exception as e:
            fired.append(f'场景{x["id"]}ERR {str(e)[:60]}')
    for x in miss_props:
        try:
            api('POST', f'/props/{x["id"]}/generate-image', {'episode_id': eid}, timeout=120)
            fired.append(f'道具{x["id"]}')
        except Exception as e:
            fired.append(f'道具{x["id"]}ERR {str(e)[:60]}')
    if fired:
        print(f'ep{no} 触发资产图: ' + '; '.join(fired))
        return

    bkey = f'breakdown:{eid}'
    if not st.get(bkey):
        r = payload(api('POST', '/agent/storyboard_breaker/chat', {
            'message': breakdown_message(chars, scenes, props),
            'drama_id': DRAMA, 'episode_id': eid,
        }, timeout=2400))
        st[bkey] = 1
        save_state(st)
        print(f'ep{no} 拆镜返回: {str(r)[:200]}')
        return
    print(f'ep{no} 已触发拆镜、分镜还没落库 —— 等下一轮（若连续两轮仍为 0 需人工看拆镜日志）')


if __name__ == '__main__':
    try:
        main()
    except Exception as e:
        print('ERROR', type(e).__name__, str(e)[:300])
        sys.exit(1)
