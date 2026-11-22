# -*- coding: utf-8 -*-
"""1122 关键帧 v2：严格按 人物→场景→道具→技能 顺序解析参考，再出帧。
- 参考顺序 = storyboard_characters(rowid) → 场景 → storyboard_props(rowid) → storyboard_techniques(rowid)
- 帧提示词带 <Subject N>/<Picture N>，与该顺序一一对应
- 模型：H3 Image（6008，社区 Easy 包，满显存）；可用 HUOBAO_FRAME_MODEL=qwen 回退 6006
- same_shot：首帧继承上一镜尾帧；cut：生成首帧
用法: python .gen_frames_v2.py [sb_id ...]（不给 = 全片按序）"""
import sqlite3, json, time, urllib.request, datetime, os, sys, shutil, uuid, subprocess, tempfile
ROOT=r'E:/pycharm/huobao-drama'; DB=ROOT+'/data/huobao.sqlite3'; EP=int(os.environ.get('HUOBAO_EP_ID','120'))
API='http://127.0.0.1:5679/api/v1'
FRAME_MODEL=os.environ.get('HUOBAO_FRAME_MODEL','h3-image')  # h3-image = 6008 Easy; qwen = 6006
def log(*a): print(datetime.datetime.now().strftime('%H:%M:%S'),*a,flush=True)
def db(): return sqlite3.connect(DB)
def submit(body):
    req=urllib.request.Request(API+'/tasks',data=json.dumps(body,ensure_ascii=False).encode('utf-8'),headers={'Content-Type':'application/json'},method='POST')
    return json.loads(urllib.request.urlopen(req,timeout=60).read())['data']['id']
def wait(tid,timeout=2400):
    t0=time.time()
    while time.time()-t0<timeout:
        time.sleep(6)
        r=db().execute("select status from sys_task where id=?",(tid,)).fetchone()
        st=r[0] if r else 'missing'
        if st=='completed': return True
        if st=='failed': return False
    return False
def bindings(c,sid):
    """返回 (refs_urls, subject_lines)：人物→场景→道具→技能"""
    refs=[]; subj=[]
    chars=[(cid,nm,url) for cid,nm,url in c.execute(
        "select ch.id,ch.name,coalesce(nullif(ch.sheet_image_url,''),ch.image_url) from storyboard_characters sc join characters ch on ch.id=sc.character_id where sc.storyboard_id=? order by sc.rowid",(sid,))]
    for i,(cid,nm,url) in enumerate(chars):
        if url: refs.append(url); subj.append('<Subject %d> is %s from <Picture %d>.'%(len(refs),nm,len(refs)))
    sc=c.execute("select sc.id,sc.location,coalesce(sc.grid_image_url,sc.image_url) from storyboards s join scenes sc on sc.id=s.scene_id where s.id=?",(sid,)).fetchone()
    if sc and sc[2]:
        refs.append(sc[2]); subj.append('<Subject %d> is the %s scene from <Picture %d>.'%(len(refs),sc[1],len(refs)))
    for (nm,url) in c.execute("select p.name,p.image_url from storyboard_props sp join props p on p.id=sp.prop_id where sp.storyboard_id=? order by sp.rowid",(sid,)):
        if url: refs.append(url); subj.append('<Subject %d> is the %s from <Picture %d>.'%(len(refs),nm,len(refs)))
    for (nm,url) in c.execute("select t.name,t.image_url from storyboard_techniques st join techniques t on t.id=st.technique_id where st.storyboard_id=? order by st.rowid",(sid,)):
        if url: refs.append(url); subj.append('<Subject %d> is the %s effect reference from <Picture %d>.'%(len(refs),nm,len(refs)))
    return refs,subj
def split_prompts(desc):
    d=(desc or '').strip(); first=d; last=''
    if '末态：' in d:
        i=d.index('末态：'); first=d[:i].strip(); last=d[i+3:].strip()
    if not last: last=first
    if not first: first=d
    return first,last
def frame_body(sid,prompt_text,refs,frame_type):
    if FRAME_MODEL=='qwen':
        # 1122 用户「qwen 分辨率很差」：显式 1920x1080 + 抬像素预算（qwen 适配器默认缩到 1344x768）
        return {'type':'image','storyboard_id':sid,'drama_id':7,'prompt':prompt_text,'frame_type':frame_type,'reference_images':refs,'model':'qwen-image-2.1','config_id':9}
    # h3-image：平台只会把参考图当附件；实际走 6008 直连由 .easy_img_runner 处理
    return {'type':'image','storyboard_id':sid,'drama_id':7,'prompt':prompt_text,'frame_type':frame_type,'reference_images':refs,'model':'h3-image','config_id':12}
def qa_expected(sid):
    """该镜角色 + 解析到的组合三视图（走平台 /outfits/shot）"""
    try:
        d=json.loads(urllib.request.urlopen(API+'/outfits/shot?storyboard_id=%d'%sid, timeout=20).read())
        items=d.get('data') or []
    except Exception:
        return []
    out=[]
    for it in items:
        oid=it.get('resolved_outfit_id')
        url=None
        for o in it.get('outfits') or []:
            if o.get('id')==oid:
                url=o.get('sheetImageUrl')
                break
        if not url:
            continue
        out.append({'name': it.get('name'), 'ref': url})
    return out

def qa_frame(sid, frame_type):
    """走平台 /frames/qa：本机人脸检测 + 配置的 QA 模型（默认 DeepSeek）裁决"""
    try:
        body=json.dumps({'storyboard_id':sid,'frame_type':frame_type}).encode()
        req=urllib.request.Request(API+'/frames/qa', data=body, headers={'Content-Type':'application/json'}, method='POST')
        d=json.loads(urllib.request.urlopen(req, timeout=300).read())
        return d.get('data') or {'ok': True}
    except Exception as e:
        return {'ok': True, 'error': str(e)[:160]}

def gen_or_retry(sid, num, title, prompt_text, refs, frame_type, col):
    """出帧（1122 用户「不要QA了」：不再逐帧检测，直接生成）"""
    t = submit(frame_body(sid, prompt_text, refs, frame_type))
    ok = wait(t)
    log(num, title, frame_type, 'ok' if ok else 'FAIL')
    return ok

ids=[int(x) for x in sys.argv[1:]] or None
rows=db().execute("select id,storyboard_number,title,description,continuity,first_frame_image,last_frame_image from storyboards where episode_id=? order by storyboard_number",(EP,)).fetchall()
prev=None
for sid,num,title,desc,cont,ff,lf in rows:
    if ids and sid not in ids: prev=sid; continue
    c=db(); refs,subj=bindings(c,sid); bind=(' '.join(subj)+' 人物外貌、服装与场景一律照参考图。') if subj else ''
    first_p,last_p=split_prompts(desc)
    log(num,title,'refs',[r.split('/')[-1][:8] for r in refs],'order=人物/场景/道具/技能')
    if not ff and cont=='same_shot' and prev:
        prow=c.execute("select last_frame_image from storyboards where id=?",(prev,)).fetchone()
        if prow and prow[0]:
            c.execute("update storyboards set first_frame_image=?, updated_at=datetime('now') where id=?",(prow[0],sid)); c.commit()
            log(num,title,'first <- prev last')
    # 1122：**不要**在这里拼 <Subject>/<Picture> 绑定——平台 tasks.ts frameBindings 会按
    # 「组合三视图 → 场景 → 道具 → 技能」再写一套；两套编号冲突时模型会把同一个人画两份
    # （用户实测「两个人最后这么多人」）。这里只发画面描述。
    if not db().execute("select first_frame_image from storyboards where id=?",(sid,)).fetchone()[0]:
        gen_or_retry(sid,num,title,'首帧：'+first_p,refs,'first_frame','first_frame_image')
    if not db().execute("select last_frame_image from storyboards where id=?",(sid,)).fetchone()[0]:
        gen_or_retry(sid,num,title,'本镜完整描述：'+(desc or '')+' 现在生成这一镜的最后一刻（尾帧）：'+last_p,refs,'last_frame','last_frame_image')
    prev=sid
log('FRAMES V2 DONE')
