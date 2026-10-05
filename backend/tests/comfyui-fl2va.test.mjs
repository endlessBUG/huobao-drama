import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const bridge = readFileSync('E:/AI/ComfyUI/custom_nodes/ComfyUI-OpenAI-Bridge/__init__.py', 'utf8')
const adapter = readFileSync(new URL('../src/services/adapters/comfyui-video.ts', import.meta.url), 'utf8')

test('bridge 新增 _wf_fl2va（fl2va 节点 + first_frame 接线 + upscale_scale=1.0）', () => {
  assert.match(bridge, /def _wf_fl2va\(/)
  assert.match(bridge, /"class_type":\s*"JZL_MiniMaxH3ImageToVideoDual"/)
  assert.match(bridge, /"first_frame":\s*\["300", 0\]/)
  assert.match(bridge, /"upscale_scale":\s*1\.0/)
})

test('videos 路由：body 有 first_frame 时用 _wf_fl2va', () => {
  assert.match(bridge, /first_frame = b\.get\("first_frame"\) or None/)
  assert.match(bridge, /_wf_fl2va\(prompt, w, h, int\(b\.get\("length",\s*124\)\),\s*first_frame/)
  assert.match(bridge, /h3_fl2va_/)
})

test('_selftest 覆盖 fl2va 悬空连线检查', () => {
  assert.match(bridge, /f = _wf_fl2va\("a cat", 576, 320, 124/)
  assert.match(bridge, /f\["302"\]\["inputs"\]\["upscale_scale"\]\s*==\s*1\.0/)
  // 悬空连线检查覆盖全部工作流（a=base, im=image, rf=ref image, v=video, f=fl2va, v2=video+超分）
  assert.match(bridge, /for g in \(a, im, rf, v, f, v2, v5, v6, v7\):/)
})

test('adapter：firstFrameUrl 时 staging 首帧并传 first_frame', () => {
  assert.match(adapter, /record\.firstFrameUrl/)
  assert.match(adapter, /first_frame:\s*firstFrameFile/)
})
