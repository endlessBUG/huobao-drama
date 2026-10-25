import { test } from 'node:test'
import assert from 'node:assert/strict'
import { wantsFaceRefine } from '../src/services/adapters/face-refine.ts'

// 1025 用户「默认全开、不加开关」：comfyui 的片子默认二采，显式 refine:false 才关；别的 provider 不碰。
test('小脸修复默认全开', () => {
  assert.equal(wantsFaceRefine('comfyui', {}), true)
  assert.equal(wantsFaceRefine('comfyui', null), true)
  assert.equal(wantsFaceRefine('comfyui', { refine: true }), true)
  assert.equal(wantsFaceRefine('comfyui', { refine: false }), false)
  assert.equal(wantsFaceRefine('minimax', {}), false)
})
