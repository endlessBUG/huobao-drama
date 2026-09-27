import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const root = new URL('..', import.meta.url)
const read = (path) => readFileSync(new URL(path, root), 'utf8')

test('characters and scenes tables store the final prompt', () => {
  const schema = read('src/db/schema.ts')
  const ddl = read('src/db/sqlite-schema.ts')

  // Drizzle 表定义
  assert.match(schema, /export const characters = sqliteTable\('characters'[\s\S]*?finalPrompt: text\('final_prompt'\)/)
  assert.match(schema, /export const scenes = sqliteTable\('scenes'[\s\S]*?finalPrompt: text\('final_prompt'\)/)
  // 建表 DDL
  assert.match(ddl, /CREATE TABLE IF NOT EXISTS characters \([\s\S]*?final_prompt TEXT/)
  assert.match(ddl, /CREATE TABLE IF NOT EXISTS scenes \([\s\S]*?final_prompt TEXT/)
})

test('grid prompt agent tools save agent-written final prompts with style injection', () => {
  const tools = read('src/agents/tools/image-prompt-tools.ts')

  assert.match(tools, /save_scene_final_prompt/)
  // 保存时注入项目视觉风格并落库
  assert.match(tools, /getDramaStylePrompt/)
  assert.match(tools, /set\(\{ finalPrompt, updatedAt: now\(\) \}\)/)
  // 提示词由 Agent 创作，不再由工具机械拼接
  assert.doesNotMatch(tools, /generate_character_prompt/)
  assert.doesNotMatch(tools, /generate_scene_prompt/)
})

test('prompt agent instructions reference per-asset skills; skill files define the specs', () => {
  const agents = read('src/agents/index.ts')
  // 系统提示词默认值已从 settings.vue 外提到 workspace/prompts/*.md（可 i18n）
  const promptMd = read('workspace/prompts/prompt_generator.md')
  const charSkill = read('workspace/skills/prompt-generator/character-prompt/SKILL.md')
  const sceneSkill = read('workspace/skills/prompt-generator/scene-prompt/SKILL.md')

  for (const src of [agents, promptMd]) {
    // 两类图片规范入口（具体创作规则在各自 SKILL.md 中）
    assert.match(src, /场景固定视角/)
    assert.match(src, /道具白底单品/)
    // 保存工具约定
    assert.match(src, /save_scene_final_prompt/)
    // 角色提示词不归 Agent 管：没有角色读取/保存工具，也没有三视图规范入口
    assert.doesNotMatch(src, /read_characters/)
    assert.doesNotMatch(src, /save_character_final_prompt/)
    assert.doesNotMatch(src, /角色三视图/)
  }
  // 角色三视图 / 场景固定视角的必备要素由技能文件承载（输出语言跟随会话语言指令）
  assert.match(charSkill, /正脸特写/)
  assert.match(charSkill, /正面、90 度侧面、背面/)
  assert.match(charSkill, /三个视图的脸、发型和服装完全一致/)
  assert.match(charSkill, /语言跟随会话语言指令/)
  assert.match(sceneSkill, /固定机位广角镜头/)
  assert.match(sceneSkill, /前景（\[前景元素\]）、中景（\[中景主体空间\]）、后景（\[后景纵深\]）/)
  assert.match(sceneSkill, /出入口/)
  assert.match(sceneSkill, /语言跟随会话语言指令/)
})

test('scenes keep agent generation with legacy fallback; characters are user-written only', () => {
  const service = read('src/services/final-prompt.ts')
  const characters = read('src/routes/characters.ts')
  const scenes = read('src/routes/scenes.ts')
  const tools = read('src/agents/tools/image-prompt-tools.ts')

  assert.match(service, /export async function ensureSceneFinalPrompt/)
  assert.match(service, /getAgent\('prompt_generator'/)
  // 已有最终提示词直接复用（force 时忽略强制重新生成）
  assert.match(service, /if \(scene\.finalPrompt && !force\) return scene\.finalPrompt/)
  assert.match(service, /force = false/)

  assert.match(scenes, /ensureSceneFinalPrompt\(scene, ep\.id, /)
  // 手动编辑最终提示词以传入值为准；未传入则保留原值（改描述不再自动置空）
  assert.match(scenes, /updates\.finalPrompt = body\.final_prompt \|\| null/)

  // 角色：服务层没有 ensureCharacterFinalPrompt，工具层没有角色读写，路由层不调 Agent
  assert.doesNotMatch(service, /ensureCharacterFinalPrompt/)
  assert.doesNotMatch(tools, /save_character_final_prompt|read_characters/)
  assert.doesNotMatch(characters, /ensureCharacterFinalPrompt|generate-prompt/)
  assert.match(characters, /updates\.finalPrompt = body\.final_prompt \|\| null/)
})
