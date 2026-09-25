import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const root = new URL('..', import.meta.url)
const read = (path) => readFileSync(new URL(path, root), 'utf8')

test('storyboards 表新增 video_prompt_full_ref（Drizzle 字段 + DDL 列 + 幂等 ADD COLUMN）', () => {
  assert.match(read('src/db/schema.ts'), /videoPromptFullRef:\s*text\('video_prompt_full_ref'\)/)
  const ddl = read('src/db/sqlite-schema.ts')
  assert.match(ddl, /video_prompt_full_ref\s+TEXT/)
  assert.match(ddl, /video_prompt_full_ref TEXT/i)
})
