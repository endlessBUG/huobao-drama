import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const bridge = readFileSync('E:/AI/ComfyUI/custom_nodes/ComfyUI-OpenAI-Bridge/__init__.py', 'utf8')
const adapter = readFileSync(new URL('../src/services/adapters/comfyui-video.ts', import.meta.url), 'utf8')

test('bridge _wf_video 默认 ref_scale=2.0 且路由可覆盖', () => {
  assert.match(bridge, /def _wf_video\(prompt, w, h, length, refs, seed, prefix, ref_scale=2\.0, upscale=0, selflift=False, sparse=False, guide=None, trim=0, prev_latent=None, save_name=None, window=22\):/)
  assert.match(bridge, /"ref_scale": ref_scale/)
  assert.match(bridge, /ref_scale = b\.get\("ref_scale"\) or 2\.0/)
})

test('bridge _selftest 断言 ref_scale==2.0', () => {
  assert.match(bridge, /v\["302"\]\["inputs"\]\["ref_scale"\]\s*==\s*2\.0/)
})

test('adapter body 含 ref_scale: 2.0', () => {
  assert.match(adapter, /ref_scale:\s*2\.0/)
})
