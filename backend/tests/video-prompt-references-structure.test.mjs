import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const root = new URL('..', import.meta.url)
const read = (path) => readFileSync(new URL(path, root), 'utf8')

test('prompt_generator video prompt format uses @name references instead of XML tags', () => {
  const agents = read('src/agents/index.ts')
  const skill = read('workspace/skills/prompt-generator/video-prompt/SKILL.md')
  // 系统提示词默认值已从 settings.vue 外提到 workspace/prompts/*.md（可 i18n）
  const promptMd = read('workspace/prompts/prompt_generator.md')

  // 场景/角色用 @名字 引用（名字必须与场景/角色列表完全一致）
  assert.match(agents, /@场景名/)
  assert.match(agents, /@角色名/)
  assert.match(agents, /@小明 → @图片1小明/)
  assert.doesNotMatch(agents, /<location>/)
  assert.doesNotMatch(agents, /<role>/)

  // SKILL.md 同步
  assert.match(skill, /@场景名/)
  assert.match(skill, /@角色名/)
  assert.match(skill, /@小明.*@图片1小明/)
  assert.doesNotMatch(skill, /<location>/)
  assert.doesNotMatch(skill, /<role>/)

  // workspace/prompts 副本同样包含新格式规范
  assert.match(promptMd, /@场景名/)
  assert.match(promptMd, /@角色名/)
  assert.match(promptMd, /@小明 → @图片1小明/)
  assert.doesNotMatch(promptMd, /<location>/)
  assert.doesNotMatch(promptMd, /<role>/)
})

test('video prompt skill 不让 agent 给 <Subject N> 编外貌（角色妆造只来自角色图）', () => {
  // agent 看不到参考图（read_storyboard_context 只回文字），它编的「外貌描述」必然与角色三视图打架
  // ——实测同一分镜两个角色的衣服/发型全被编错。角色 Subject 只写名字，妆造交给 <Picture N>。
  for (const f of ['SKILL.md', 'SKILL.en.md', 'SKILL.ja.md', 'SKILL.ko.md']) {
    const skill = read(`workspace/skills/prompt-generator/video-prompt/${f}`)
    assert.doesNotMatch(skill, /\[外貌描述\]/, `${f}: 模板仍有外貌槽位`)
    assert.match(skill, /<Subject 1> is \[角色名\] from <Picture 1>, on the left of frame by the \[固定陈设\]\./, f)
    assert.match(skill, /看不到|cannot see|見られない|볼 수 없/, `${f}: 标签规则未说明 agent 看不到参考图`)
  }
})

test('站位：拆解层写死走位，提示词层复述左右（否则每条独立生成的视频各摆一次）', () => {
  // 实测：同一场戏 5 条独立生成的视频里 sb9 把两个角色摆反了 —— 全链路没有任何一层写过谁在左谁在右。
  for (const f of ['SKILL.md', 'SKILL.en.md', 'SKILL.ja.md', 'SKILL.ko.md']) {
    const breaker = read(`workspace/skills/storyboard-breaker/${f}`)
    assert.match(breaker, /空间与走位|Space and Blocking|空間と立ち位置|공간과 위치/, `${f}: 拆解层缺空间/走位规则`)
    assert.match(breaker, /造型|styling|스타일링/, `${f}: 未声明只写位置不写造型`)
    // 只写画面左右不够：换成正反打左右会翻，「床头灯那一侧」不会翻 —— 相对陈设是跨镜不变的那一半
    assert.match(breaker, /固定陈设|fixed furnishing|固定調度品|고정 집기/, `${f}: 站位未绑定相对陈设`)
  }
  for (const f of ['SKILL.md', 'SKILL.en.md', 'SKILL.ja.md', 'SKILL.ko.md']) {
    const vp = read(`workspace/skills/prompt-generator/video-prompt/${f}`)
    assert.match(vp, /on the left of frame/, `${f}: 六段式模板未带站位`)
    assert.match(vp, /left \/ right of frame/, `${f}: 未规定左右用画面视角`)
    assert.match(vp, /固定陈设|fixed furnishing|固定調度品|고정 집기/, `${f}: 站位规则未要求相对陈设锚点`)
    assert.match(vp, /on the left of frame by the \[固定陈设\]\./, `${f}: 六段式模板缺相对陈设槽位`)
    assert.match(vp, /1 号|No\.1|1番|1번/, `${f}: description 没写站位时没有确定性的兜底序号`)
  }
})

test('镜间衔接锁：上一镜末态喂给下一条，且只在同场景内承接', () => {
  // 实测：同一批 5 条独立生成的 full_ref，#2/#4 直接把站位漏光，其余三条各写各的。
  // 独立调用根本执行不了「同一场戏不许换边」这类跨镜规则 —— 必须把上一镜末态喂给下一条。
  const svc = read('src/services/video-prompts.ts')
  assert.match(svc, /prevTail/, '批量生成没保留上一镜末态')
  assert.match(svc, /sb\.sceneId !== prevScene/, '换景没断链——会把卧室的走位传给客厅')
  assert.match(svc, /上一镜（分镜 #\$\{prevTail\.no\}/, '消息里没把末态交给下一条')
  // 末态必须取「真实渲染结尾所在的那一段」：prompt 会写到 9 秒，但模型只出得到 5.2 秒
  // （comfyui-video.ts DEFAULT_LENGTH=124），末段永不渲染 —— 拿它当末态是把不存在的画面喂给下一条
  assert.match(svc, /Math\.min\(segCount, segs\.length\) - 1/, '末态取了最后一段（可能永远不会被渲染）')
  // 末段写作 `3-5.2秒`（真实时长 5.17s）——整数正则只认得 `0-3秒`，末态会退化成首段
  assert.match(svc, /\\d\+\(\?:\\\.\\d\+\)\?-\\d\+\(\?:\\\.\\d\+\)\?秒/, '段落正则不认小数，末态会退化成首段')
  assert.match(svc, /本镜视频时长 \$\{sec\.toFixed\(1\)\} 秒/, '没把真实时长告诉 agent —— 会按 8-15 秒惯性写到 9 秒')

  for (const f of ['SKILL.md', 'SKILL.en.md', 'SKILL.ja.md', 'SKILL.ko.md']) {
    const vp = read(`workspace/skills/prompt-generator/video-prompt/${f}`)
    assert.match(vp, /上一镜末态|ending state|終了状態|종료 상태/, `${f}: 技能未要求承接上一镜`)
    assert.match(vp, /逐字|verbatim|逐語|그대로 반복/, `${f}: 技能未要求场景锚点逐字复用`)
  }
})

test('系统提示词同步了站位硬规则', () => {
  assert.match(read('workspace/prompts/storyboard_breaker.md'), /在画面哪一侧/, '拆解系统提示词缺站位')
  assert.match(read('workspace/prompts/prompt_generator.md'), /画面站位/, '提示词系统提示词缺站位')
})

test('full_ref 面板有自己的重新生成入口，且不碰用户手写的 video_prompt', () => {
  const vue = read('../frontend/app/views/drama/episode.vue')

  // 面板原先 v-if 只在已有 full_ref 时才渲染 → 没生成的分离镜前端根本没入口，只能走整集批量。
  assert.match(vue, /video-inspector-section video-fullref-panel">/)
  assert.match(vue, /@click="genVideoPromptFullRef\(selectedSb\)"/)

  const start = vue.indexOf('async function genVideoPromptFullRef')
  assert.notEqual(start, -1, 'episode.vue 缺 genVideoPromptFullRef')
  const fn = vue.slice(start, vue.indexOf('\nfunction sleep(ms)', start))

  // 与 genVideoPrompt 的「只更新 video_prompt」对称：这个只点 full_ref 一份菜，
  // 免得模型顺手把用户手改过的中文 video_prompt 一起覆盖了。
  assert.match(fn, /只传 storyboard_id 和 video_prompt_full_ref 两个键/)
  assert.doesNotMatch(fn, /(?<!_)video_prompt(?!_)/, 'full_ref 入口提到了裸 video_prompt')

  // 模型真正收到的那份：comfyui 走 full_ref，不是 video_prompt。
  assert.match(vue, /sb\.video_prompt_full_ref \|\| sb\.videoPromptFullRef/)

  // 空态文案要有键，否则面板直接显示 key 本身。
  for (const l of ['zh', 'en', 'ja', 'ko']) {
    const json = JSON.parse(read(`../frontend/app/locales/${l}.json`))
    assert.equal(typeof json.episode?.sb?.fullRefEmpty, 'string', `${l}.json 缺 episode.sb.fullRefEmpty`)
    assert.equal(typeof json.episode?.sb?.fullRefGenerated, 'string', `${l}.json 缺 episode.sb.fullRefGenerated`)
  }
})
