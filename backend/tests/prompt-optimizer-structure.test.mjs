import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const root = new URL('..', import.meta.url)
const read = (path) => readFileSync(new URL(path, root), 'utf8')
const episode = () => read('../frontend/app/views/drama/episode.vue')

test('提示词优化只作用于用户写下的字，空框不产出任何内容', () => {
  const agents = read('src/agents/index.ts')

  assert.match(agents, /【当前文本】为空（或只有空白）时什么都不输出/)
  // 旧行为：空框时凭角色/上下文造初稿、按技能模板组装版式 —— 都删掉
  assert.doesNotMatch(agents, /给一版中性可用的初稿/)
  assert.doesNotMatch(agents, /哪怕【当前文本】是空的/)
  assert.doesNotMatch(agents, /按技能的输出结构组装/)
  assert.doesNotMatch(agents, /技能的构图骨架那几句必须原样保留/)
  // 版式句原样保留、缺了也不补写（1016 改版）：框里的字就是最终提示词，产品不再追加。
  // 默认值里自带整套版式句 + 风格，优化器删掉它们 = 产物真的没有版式；没带的也不许它补。
  assert.doesNotMatch(agents, /不写版式：技能「输出结构」那两段模板/)
  assert.match(agents, /版式句原样保留、缺了也不补写/)
  assert.match(agents, /以参考图中的同一人物为准，脸型、五官、发型、肤色、妆容、服装与配饰一律照参考图原样保留，只改变角度与构图/)
  assert.match(agents, /一个字都别删、别改写、别挪位/)
  assert.doesNotMatch(agents, /用户自己写的版式词（三视图、白底、正面\/侧面\/背面）也删掉/)
  // 消息里不再带角色与上下文（只发框里那段字）
  assert.doesNotMatch(agents, /【角色】角色名/)
  assert.doesNotMatch(agents, /【上下文】/)

  const skill = read('workspace/skills/prompt-generator/character-prompt/SKILL.md')
  assert.match(skill, /版式不归你/)
  assert.match(skill, /原样保留 —— 别删、别改写、别挪位/)
  assert.match(skill, /也不要补写/)
  assert.doesNotMatch(skill, /骨架不可省/)

  // 前端兜住：空框按钮灰掉 + 点了给提示（不白跑一次 LLM）
  const buttons = read('../frontend/app/components/PromptOptimizeButtons.vue')
  assert.match(buttons, /disabled: \{ type: Boolean, default: false \}/)
  assert.match(buttons, /:disabled="!!active \|\| disabled"/)

  const fe = episode()
  // 角色的三框 + 场景的两框（场景描述 / 场景光影）共用同一套按钮与草稿读写
  for (const field of ['appearance', 'styling', 'final', 'sceneDesc', 'sceneLight']) {
    assert.match(fe, new RegExp(`field="${field}"[\\s\\S]{0,200}:disabled="isPromptDraftEmpty\\('${field}'\\)"`))
  }
  assert.match(fe, /function isPromptDraftEmpty\(field\)/)
  // 场景两框必须在 v-if="scene" 那一支里渲染：曾误放进 v-else 的 asset-detail-shell（对场景永假 = 按钮看不见，测试却绿）
  assert.doesNotMatch(fe, /v-if="assetDetail\.type === 'scene'" class="asset-detail-edit-field"/)
  assert.match(fe, /asset-detail-scene-grid"[\s\S]*field="sceneDesc"[\s\S]*field="sceneLight"/)
  // 场景描述只保留「提示词优化」：曾有的「生成场景描述」按钮走 agent 生成、结果是把 … 写进框里
  assert.doesNotMatch(fe, /genSceneDescription/)
  // 场景两个字段：取值/写回都落在 assetDetailDraft.prompt / .lighting 上
  assert.match(fe, /if \(field === 'sceneDesc'\) return assetDetailDraft\.value\.prompt/)
  assert.match(fe, /if \(field === 'sceneLight'\) return assetDetailDraft\.value\.lighting/)
  assert.match(fe, /else if \(field === 'sceneDesc'\) assetDetailDraft\.value\.prompt = text/)
  assert.match(fe, /else if \(field === 'sceneLight'\) assetDetailDraft\.value\.lighting = text/)
  // 场景也要能进优化（此前只看 character）；【参考图】只有角色字段才带
  assert.match(fe, /\['character', 'scene'\]\.includes\(detail\.type\)/)
  assert.match(fe, /sceneDesc: '场景描述', sceneLight: '场景光影'/)
  // 角色与场景两条 Agent（1016 用户定案「要求不一样」）：角色只改不许补，场景把简报写满
  assert.match(agents, /【字段】样貌 \/ 妆造 \/ 最终三视图（要优化的那个框）/)
  assert.match(agents, /【字段】场景描述 \/ 场景光影/)
  // 场景那条按【字段】分流：场景两框是素材、不是最终提示词 —— 反过来不许它写版式句
  assert.match(agents, /场景光影：光源方向与样式 → 色温冷暖 → 明暗对比 → 氛围/)
  assert.match(agents, /别往里写版式句和机位句/)
  // 场景要写满：用户给的是简报。1016 用户实测「生成一个500字的场景」只回 262 字（旧规矩只让改写/重排，不让扩写）
  assert.match(agents, /期望你写满、写具体/)
  assert.match(agents, /字数要求是指令，不要抄进正文/)
  // 只发框里那段字 + 参考图有/无：不带角色、不带其他字段
  assert.match(fe, /`【字段】\$\{label\}`,/)
  assert.match(fe, /【参考图】\$\{hasRef \? '有' : '无'\}/)
  // 端点按字段分流：场景两框走 scene_prompt_optimizer，其余走角色的那条
  assert.match(fe, /field === 'sceneDesc' \|\| field === 'sceneLight' \? 'scene_prompt_optimizer' : 'character_prompt_optimizer'/)
  assert.match(fe, /api\.post\(`\/agent\/\$\{agentType\}\/chat`/)
  assert.doesNotMatch(fe, /【角色】\$\{char\.name/)
  assert.doesNotMatch(fe, /【上下文】/)
  assert.match(fe, /toast\.error\(t\('episode\.asset\.optimizeNeedText'\)\)/)
  // 模型会把「空文本」照抄回来，别当结果填进框
  assert.match(fe, /空文本\|空\|（空）\|\\\(空\\\)\|无\|none\|null/)
  // 关思考补丁的伴生现象：模型先吐一排句点（实测正文前 9 个 / 整段 177 个），别写进用户的框
  assert.match(fe, /\.replace\(\/\^\[\.．…\]\+\/, ''\)/)
  assert.match(fe, /\/\^\[\.．…。\]\+\$\/\.test\(text\)/)

  for (const l of ['zh', 'en', 'ja', 'ko']) {
    const j = JSON.parse(read(`../frontend/app/locales/${l}.json`))
    assert.ok(j.episode.asset.optimizeNeedText, `${l} 缺 optimizeNeedText`)
  }
})

test('素材库编辑弹窗（detail.vue）的场景两框同样能优化，草稿语义一致', () => {
  const d = read('../frontend/app/views/drama/detail.vue')

  for (const field of ['sceneDesc', 'sceneLight']) {
    assert.match(d, new RegExp(`field="${field}"[\\s\\S]{0,220}:disabled="!\\(editDraft\\.\\w+ \\|\\| ''\\)\\.trim\\(\\)"`))
  }
  assert.match(d, /const sceneFieldKeys = \{ sceneDesc: 'prompt', sceneLight: 'lighting' \}/)
  assert.match(d, /async function optimizeSceneField\(field\)/)
  // 只发【字段】+【当前文本】：场景不吃参考图，这条 Agent 的报文里压根没有【参考图】这一行
  assert.match(d, /【字段】\$\{field === 'sceneDesc' \? '场景描述' : '场景光影'\}/)
  assert.doesNotMatch(d, /【参考图】/)
  assert.match(d, /function undoOptimize\(field\)/)
  assert.match(d, /api\.post\('\/agent\/scene_prompt_optimizer\/chat'/)
  // 与 episode.vue 同一套清洗：句点填充物两处都要剥
  assert.match(d, /\.replace\(\/\^\[\.．…\]\+\/, ''\)/)
  assert.match(d, /\/\^\[\.．…。\]\+\$\/\.test\(text\)/)
})

test('生成中的按钮一律带转圈：pending 优先于「重新生成」', () => {
  const fe = episode()

  // 详情页三个生成按钮此前只有「生成中…」文字，没有转圈
  for (const kind of ['Char', 'Scene', 'Prop']) {
    assert.match(fe, new RegExp(`<Loader2 v-if="isPending${kind}Image\\(assetDetail\\.item\\.id\\)" :size="11" class="animate-spin" />`))
    assert.match(fe, new RegExp(`\\{\\{ isPending${kind}Image\\(assetDetail\\.item\\.id\\) \\? t\\('episode\\.asset\\.generating'\\)`))
  }
  // 列表卡片：重生成时也得看得见在跑，不能只剩个灰按钮
  for (const v of ['c', 's', 'p']) {
    assert.match(fe, new RegExp(`\\{\\{ isPending\\w+Image\\(${v}\\.id\\) \\? t\\('episode\\.asset\\.generating'\\) : \\(\\(${v}\\.image_url \\|\\| ${v}\\.imageUrl\\)`))
  }
})
