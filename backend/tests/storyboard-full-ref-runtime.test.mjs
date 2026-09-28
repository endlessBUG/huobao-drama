import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const root = new URL('..', import.meta.url)
const read = (p) => readFileSync(new URL(p, root), 'utf8')

test('language.ts exceptions 加 video_prompt_full_ref 恒英文例外', () => {
  const s = read('src/agents/language.ts')
  assert.match(s, /video_prompt_full_ref/)
  assert.match(s, /MUST ALWAYS be written in English/i)
})

test('update_storyboard 接受 video_prompt_full_ref 并映射 videoPromptFullRef', () => {
  const s = read('src/agents/tools/storyboard-tools.ts')
  assert.match(s, /video_prompt_full_ref: z\.string\(\)\.optional/)
  assert.match(s, /if \(\'video_prompt_full_ref\' in fields\) updates\.videoPromptFullRef = fields\.video_prompt_full_ref/)
})

test('genVid：comfyui 时优先 videoPromptFullRef；非 comfyui 路径仍走 resolveVideoPromptRefs（回归 Review Focus #1）', () => {
  const s = read('../frontend/app/views/drama/episode.vue')
  assert.match(s, /selectedVideoConfig\.value\?\.\s*provider\s*===\s*['"]comfyui['"]/)
  // 驼峰与下划线都认：接口回的常是 snake_case，只读驼峰会拿到空串 → 后端「必须提供提示词」直接拒
  assert.match(s, /sb\.video_prompt_full_ref \|\| sb\.videoPromptFullRef \|\| sb\.video_prompt \|\| sb\.videoPrompt/)
  assert.match(s, /: resolveVideoPromptRefs\(sb\)/)
})

test('前端只读 full_ref 面板存在', () => {
  const s = read('../frontend/app/views/drama/episode.vue')
  assert.match(s, /video-fullref-panel/)
  assert.match(s, /spellcheck="false"/)
})
