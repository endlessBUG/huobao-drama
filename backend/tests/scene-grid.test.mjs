import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const root = new URL('..', import.meta.url)
const read = (p) => readFileSync(new URL(p, root), 'utf8')

test('scenes 新增 grid_prompt/grid_image_url（Drizzle + DDL）', () => {
  const s = read('src/db/schema.ts')
  assert.match(s, /gridPrompt:\s*text\('grid_prompt'\)/)
  assert.match(s, /gridImageUrl:\s*text\('grid_image_url'\)/)
  const ddl = read('src/db/sqlite-schema.ts')
  assert.match(ddl, /grid_prompt\s+TEXT/)
  assert.match(ddl, /grid_image_url\s+TEXT/)
})

test('sqlite-schema 幂等加列 calls scenes.grid_prompt/grid_image_url（复用 Task 1 助手）', () => {
  const s = read('src/db/sqlite-schema.ts')
  assert.match(s, /function addColumnIfMissing/)
  assert.match(s, /addColumnIfMissing\(sqlite, 'scenes', 'grid_prompt'\)/)
  assert.match(s, /addColumnIfMissing\(sqlite, 'scenes', 'grid_image_url'\)/)
})

test('image-prompt-tools 新增 save_scene_grid_prompt（存 gridPrompt，拼风格）', () => {
  const s = read('src/agents/tools/image-prompt-tools.ts')
  assert.match(s, /id:\s*'save_scene_grid_prompt'/)
  assert.match(s, /gridPrompt:\s*finalPrompt/)
})

test('scenes 路由新增 POST /:id/generate-grid-image（1536x1536、sceneGrid）', () => {
  const s = read('src/routes/scenes.ts')
  assert.match(s, /["']\/:id\/generate-grid-image["']/)
  assert.match(s, /sceneGrid:\s*true/)
  assert.match(s, /1536x1536/)
})

test('generation: sceneGrid 字段 + writeBack 回写 gridImageUrl', () => {
  const s = read('src/services/generation.ts')
  assert.match(s, /sceneGrid\?:\s*boolean/)
  assert.match(s, /sceneGrid \?\s*\{ gridImageUrl:\s*localPath \} : \{ imageUrl:\s*localPath \}/)
})
