import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { initSqliteSchema } from '../src/db/sqlite-schema.js'

// 提示词库：全局、纯文字、无图，agent 靠 read_prompt_library 按需拉（不整本注入）。
// 这条测试守三件事：① 建表+种子真能跑通 ② 库文本没被抄进 instructions ③ 四种语言的界面文案齐了
const ddl = readFileSync(new URL('../src/db/sqlite-schema.ts', import.meta.url), 'utf8')
const schemaTs = readFileSync(new URL('../src/db/schema.ts', import.meta.url), 'utf8')
const route = readFileSync(new URL('../src/routes/promptLibrary.ts', import.meta.url), 'utf8')
const indexTs = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')
const agents = readFileSync(new URL('../src/agents/index.ts', import.meta.url), 'utf8')
const tool = readFileSync(new URL('../src/agents/tools/prompt-library-tools.ts', import.meta.url), 'utf8')
const settings = readFileSync(new URL('../../frontend/app/pages/settings.vue', import.meta.url), 'utf8')
const useApi = readFileSync(new URL('../../frontend/app/composables/useApi.ts', import.meta.url), 'utf8')

test('建表 + 话题级种子真跑通，且幂等（再跑一遍不翻倍）', () => {
  const sqlite = new Database(':memory:')
  initSqliteSchema(sqlite)
  const rows = sqlite.prepare('select group_name, title, text, hits, is_active from prompt_library').all()
  assert.equal(rows.length, 14, `种子条数 ${rows.length} —— 库要的是话题级条目（名字 = 话题，正文 = 整段口径），不是碎片`)
  assert.equal(rows[0].group_name, '穴') // 组名不带「解剖」（用户明确不要那个词），标题就是话题名
  assert.equal(rows[0].title, '女性生殖器')
  const text = rows[0].text
  assert.ok((text.match(/【/g) || []).length >= 8, '正文不是一段整块口径')
  assert.ok(/cleft of venus/i.test(text) && /seam/.test(text) && /cameltoe/.test(text), '缺关键用词')
  assert.ok(rows[0].hits === 0 && rows[0].is_active === 1, '种子默认值不对')
  initSqliteSchema(sqlite)
  assert.equal(sqlite.prepare('select count(*) c from prompt_library').get().c, 14)
  sqlite.close()
})

// 1016 社区技法收割（用户「场景skill要做的很精致…做成一个大的skill 然后引用其他skill，主的skill 做索引」，
// 「人物也要这样…做成一个大skill」）。源 = zenstory-ai/drama-skills（MIT ★2922，pushed 10-15）与
// eternityspring/shuohao-skills（Apache-2.0 ★4606，pushed 10-15）—— 两个都是昨天还在更新的短剧 skill 合集。
// 正文原样搬进 workspace/skills/prompt-generator/{scene,character,prop}-prompt/references/*.md，
// 启动时读文件幂等进库（文件是唯一源、可 git 可编辑；库里是索引 + 正文）。
test('社区技法种子：场景技法 6 / 人物技法 6 / 道具技法 1，正文带出处行', () => {
  const sqlite = new Database(':memory:')
  initSqliteSchema(sqlite)
  const byGroup = Object.fromEntries(sqlite.prepare(
    "select group_name g, count(*) n from prompt_library where group_name <> '穴' group by group_name").all().map(r => [r.g, r.n]))
  assert.deepEqual(byGroup, { '场景技法': 6, '人物技法': 6, '道具技法': 1 }, `分组不对 ${JSON.stringify(byGroup)}`)
  const rows = sqlite.prepare("select title, text from prompt_library where group_name <> '穴'").all()
  for (const r of rows) assert.match(r.text, /^> \*\*火宝短剧接入说明\*\*[\s\S]*出处：(zenstory-ai\/drama-skills|eternityspring\/shuohao-skills)/, `${r.title} 缺接入说明或出处行`)
  assert.ok(rows.every(r => r.text.length > 600), '有条目正文太薄，不像话题级')
  initSqliteSchema(sqlite)
  assert.equal(sqlite.prepare('select count(*) c from prompt_library').get().c, 14)
  sqlite.close()
})

test('主 skill = 索引：scene/character 的 SKILL.md 各带社区技法索引段', () => {
  const scene = readFileSync(new URL('../workspace/skills/prompt-generator/scene-prompt/SKILL.md', import.meta.url), 'utf8')
  const char = readFileSync(new URL('../workspace/skills/prompt-generator/character-prompt/SKILL.md', import.meta.url), 'utf8')
  for (const [name, s] of [['scene', scene], ['character', char]]) {
    assert.match(s, /社区技法索引/, `${name} 主 skill 缺索引段`)
    assert.match(s, /read_prompt_library/, `${name} 主 skill 没指到取正文的工具`)
    assert.match(s, /最多取 1-2 条|最多读 1-2/, `${name} 索引没设按需上限`)
  }
  assert.match(scene, /Location\/View|location-and-view/) // 索引必须点名 Location/View 这条
  assert.match(char, /Character\/Look|character-and-look/) // 人物索引必须点名 Character/Look 分层
  // optimizer 不挂库工具（1016 实测：挂上就 60 步死循环、正文只剩一排点）—— 技法库由 prompt_generator 取
  assert.match(agents, /character_prompt_optimizer: \{\}/)
  assert.doesNotMatch(agents, /character_prompt_optimizer: \{[\s\S]{0,200}?readPromptLibrary/)
  assert.match(agents, /scene_prompt_optimizer: \{\}/)
})

test('场景/道具不再被排除在库外（口径翻转，四语言 prompt 同步）', () => {
  assert.doesNotMatch(agents, /写场景或道具的最终提示词不用调用它/)
  assert.doesNotMatch(tool, /场景 \/ 道具的最终提示词不需要它/)
  for (const lang of ['', '.en', '.ja', '.ko']) {
    const f = readFileSync(new URL(`../workspace/prompts/prompt_generator${lang}.md`, import.meta.url), 'utf8')
    assert.doesNotMatch(f, /写场景或道具的最终提示词不用调用它/)
  }
})

test('库是全局的、没有图：表里既没有 drama_id/episode_id 也没有图片列', () => {
  const block = schemaTs.match(/export const promptLibrary = sqliteTable\('prompt_library', \{[\s\S]*?\n\}\)/)
  assert.ok(block, 'schema.ts 里找不到 promptLibrary 定义')
  assert.doesNotMatch(block[0], /drama_id|episode_id|image_url|local_path|deleted_at/)
  assert.match(ddl, /CREATE TABLE IF NOT EXISTS prompt_library/)
  assert.match(ddl, /UNIQUE \(group_name, title\)/)
})

test('两步取：先不带参数拿清单，再按 id 取详情；每次写提示词前都要走', () => {
  assert.match(tool, /ids: z\.array\(z\.number\(\)\)\.optional\(\)/)
  assert.match(tool, /第一次不带任何参数调用/)
  assert.match(tool, /第二次/)
  assert.match(tool, /bumpHits/)
  assert.match(agents, /readPromptLibrary: promptLibraryTools\.readPromptLibrary/)
  // 口径（1016 翻转）：视频提示词、场景/道具最终提示词、人物提示词优化都先拿清单、按需取 1-2 条
  assert.match(agents, /先不带参数调用拿条目清单/)
  assert.doesNotMatch(agents, /labia majora|cleft_of_venus/) // 规范只有一份：在种子里，不在 prompt 里
  const STEP = { '': /需要哪条就按它的 id 再调用一次取详情/, '.en': /call it again with an entry's ids when that entry is relevant/,
    '.ja': /必要な条はその id で 2 回目に呼んで詳細/, '.ko': /필요한 항목은 그 id 로 한 번 더 호출해 상세/ }
  const SCOPE = { '': /写分镜的视频提示词（video_prompt \/ video_prompt_full_ref）时才用/, '.en': /only when writing a storyboard's video prompt/,
    '.ja': /を書く時だけ read_prompt_library を使う/, '.ko': /를 쓸 때만 read_prompt_library 를 사용/ }
  for (const lang of Object.keys(STEP)) {
    const f = readFileSync(new URL(`../workspace/prompts/prompt_generator${lang}.md`, import.meta.url), 'utf8')
    assert.match(f, STEP[lang], `prompt_generator${lang}.md 缺两步取详情这句`)
    assert.match(f, SCOPE[lang], `prompt_generator${lang}.md 缺「什么时候才用」这句`)
    assert.doesNotMatch(f, /labia majora/)
  }
})

test('四种语言的设置页文案齐了（tab + 面板 + dialog + 删除确认）', () => {
  for (const lang of ['zh', 'en', 'ja', 'ko']) {
    const j = JSON.parse(readFileSync(new URL(`../../frontend/app/locales/${lang}.json`, import.meta.url), 'utf8'))
    assert.ok(j.settings.tabs.library, `${lang} 缺 tab`)
    assert.ok(j.settings.library?.title && j.settings.library.desc && j.settings.library.hits, `${lang} 缺面板文案`)
    assert.ok(j.settings.library.expand?.includes('{n}'), `${lang} 缺「看全文」文案（话题级正文上千字符，必须能展开）`)
    assert.ok(j.settings.libDialog?.group && j.settings.libDialog?.text, `${lang} 缺 dialog 文案`)
    assert.ok(j.settings.libDelete?.message, `${lang} 缺删除确认`)
    assert.ok(j.settings.library.count.includes('{active}') && j.settings.library.hits.includes('{n}') &&
      j.settings.libDelete.message.includes('{name}'), `${lang} 占位符不对`)
  }
})

test('路由挂上、前端接口与面板接上', () => {
  assert.match(indexTs, /api\.route\('\/prompt-library', promptLibrary\)/)
  assert.match(route, /app\.get\('\/'/)
  assert.match(route, /sort\(\(a, b\) => \(b\.hits \|\| 0\) - \(a\.hits \|\| 0\)/)
  assert.match(useApi, /export const promptLibraryAPI = \{/)
  assert.match(settings, /tab === 'library'/)
  assert.match(settings, /libraryRows = computed/)
  // 话题级条目正文很长：列表只给第一行，必须能点开看全文（pre-wrap）
  assert.match(settings, /libOpenId = libOpenId === e\.id \? null : e\.id/)
  assert.match(settings, /white-space:pre-wrap/)
  assert.match(settings, /e\.text\.split\('\\n'\)\[0\]/)
  assert.match(settings, /loadStylePresets\(\); loadLibrary\(\)/)
})
