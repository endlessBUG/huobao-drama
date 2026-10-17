import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

// PUT /storyboards/:id 的白名单：不在 fieldMap 里的键会被静默丢掉（回 200、库里没写）。
// video_prompt_full_ref 曾不在表里 —— 脚本和以后想让用户直接编辑全参考的前端都会中招。
const route = readFileSync(new URL('../src/routes/storyboards.ts', import.meta.url), 'utf8')

test('storyboards PUT 白名单带上全参考提示词（漏了就回 200 但静默不写）', () => {
  const block = route.match(/const fieldMap: Record<string, string> = \{([\s\S]*?)\n  \}/)?.[1] || ''
  assert.ok(block, '找不到 fieldMap')
  assert.match(block, /video_prompt_full_ref: 'videoPromptFullRef'/)
  assert.match(block, /video_prompt: 'videoPrompt'/)
  assert.match(block, /image_prompt: 'imagePrompt'/)
})
