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
  // 版式不归它：骨架由产品在生成时追加。首句锚句最容易被当成「忠实还原规则」抄回来，
  // 而生成侧必带 → 实测原样追加过一遍，必须点名禁掉
  assert.match(agents, /不写版式：技能「输出结构」那两段模板\*\*整段\*\*都是\*\*产品在生成时自动追加\*\*/)
  assert.match(agents, /以参考图中的同一人物为准，脸型、五官、发型、肤色、妆容、服装与配饰一律照参考图原样保留，只改变角度与构图/)
  assert.match(agents, /它读起来像忠实还原规则，其实是骨架的一部分/)
  // 用户自己写的版式词也删（生成侧必带，留着就是重复）
  assert.doesNotMatch(agents, /用户自己写了版式（三视图、白底、正面\/侧面\/背面等）就原样留着/)
  // 消息里不再带角色与上下文（只发框里那段字）
  assert.doesNotMatch(agents, /【角色】角色名/)
  assert.doesNotMatch(agents, /【上下文】/)

  const skill = read('workspace/skills/prompt-generator/character-prompt/SKILL.md')
  assert.match(skill, /版式不归你/)
  assert.match(skill, /不要抄进结果/)
  assert.doesNotMatch(skill, /骨架不可省/)

  // 前端兜住：空框按钮灰掉 + 点了给提示（不白跑一次 LLM）
  const buttons = read('../frontend/app/components/PromptOptimizeButtons.vue')
  assert.match(buttons, /disabled: \{ type: Boolean, default: false \}/)
  assert.match(buttons, /:disabled="!!active \|\| disabled"/)

  const fe = episode()
  for (const field of ['appearance', 'styling', 'final']) {
    assert.match(fe, new RegExp(`field="${field}"[\\s\\S]{0,200}:disabled="isPromptDraftEmpty\\('${field}'\\)"`))
  }
  assert.match(fe, /function isPromptDraftEmpty\(field\)/)
  // 只发框里那段字 + 参考图有/无：不带角色、不带其他字段
  assert.match(fe, /`【字段】\$\{label\}`,/)
  assert.match(fe, /【参考图】\$\{hasRef \? '有' : '无'\}/)
  assert.doesNotMatch(fe, /【角色】\$\{char\.name/)
  assert.doesNotMatch(fe, /【上下文】/)
  assert.match(fe, /toast\.error\(t\('episode\.asset\.optimizeNeedText'\)\)/)
  // 模型会把「空文本」照抄回来，别当结果填进框
  assert.match(fe, /空文本\|空\|（空）\|\\\(空\\\)\|无\|none\|null/)

  for (const l of ['zh', 'en', 'ja', 'ko']) {
    const j = JSON.parse(read(`../frontend/app/locales/${l}.json`))
    assert.ok(j.episode.asset.optimizeNeedText, `${l} 缺 optimizeNeedText`)
  }
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
