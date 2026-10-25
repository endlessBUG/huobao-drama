import { test } from 'node:test'
import assert from 'node:assert/strict'
import { wantsUpscale } from '../src/services/adapters/vsr-upscale.ts'

// 1025 用户「分辨率能在高点吗」：comfyui 的片子默认 VSR ×2；显式 upscale:false 才关；别的 provider 不碰。
test('RTX VSR ×2 默认全开', () => {
  assert.equal(wantsUpscale('comfyui', {}), true)
  assert.equal(wantsUpscale('comfyui', null), true)
  assert.equal(wantsUpscale('comfyui', { upscale: true }), true)
  assert.equal(wantsUpscale('comfyui', { upscale: false }), false)
  assert.equal(wantsUpscale('minimax', {}), false)
})
