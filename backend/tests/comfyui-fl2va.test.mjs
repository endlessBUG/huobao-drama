import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const bridge = readFileSync('E:/AI/ComfyUI/custom_nodes/ComfyUI-OpenAI-Bridge/__init__.py', 'utf8')
const adapter = readFileSync(new URL('../src/services/adapters/comfyui-video.ts', import.meta.url), 'utf8')

test('bridge 的 _wf_fl2va（fl2va 节点 + first/last 接线 + upscale_scale=1.0）', () => {
  assert.match(bridge, /def _wf_fl2va\(/)
  assert.match(bridge, /"class_type":\s*"JZL_MiniMaxH3ImageToVideoDual"/)
  assert.match(bridge, /g\["302"\]\["inputs"\]\["first_frame"\] = \["300", 0\]/)
  assert.match(bridge, /g\["302"\]\["inputs"\]\["last_frame"\] = \["301", 0\]/)
  assert.match(bridge, /"upscale_scale":\s*1\.0/)
})

test('videos 路由：首尾帧默认走 native，只有显式 graph:"jzl" 才落 _wf_fl2va', () => {
  assert.match(bridge, /first_frame = b\.get\("first_frame"\) or None/)
  assert.match(bridge, /last_frame = b\.get\("last_frame"\) or None/)
  assert.match(bridge, /if \(first_frame or last_frame\) and \(b\.get\("graph"\) or "native"\)\.lower\(\) != "native":/)
  assert.match(bridge, /_wf_fl2va\(prompt, w, h, int\(b\.get\("length",\s*124\)\),\s*first_frame/)
  assert.match(bridge, /last_frame=last_frame/)
  assert.match(bridge, /first_frame=first_frame, last_frame=last_frame/)
  assert.match(bridge, /h3_fl2va_/)
})

test('_selftest 覆盖 fl2va 悬空连线检查', () => {
  assert.match(bridge, /f = _wf_fl2va\("a cat", 576, 320, 124/)
  assert.match(bridge, /f\["302"\]\["inputs"\]\["upscale_scale"\]\s*==\s*1\.0/)
  // 悬空连线检查覆盖全部工作流（a=base, im=image, rf=ref image, v=video, f=fl2va, v2=video+超分,
  // tp/hf=1013 换桥的 native+Veda / hisfull 两条 —— 新图加进来就要同时进这个元组，否则这条红）
  assert.match(bridge, /for g in \(a, im, rf, v, f, fz, ff, lf, v2, v5, v6, v7, v8, tp, hf\):/)
})

test('adapter：firstFrameUrl/lastFrameUrl 各自 staging 并按桥的键名传出', () => {
  assert.match(adapter, /record\.firstFrameUrl/)
  assert.match(adapter, /record\.lastFrameUrl/)
  assert.match(adapter, /first_frame:\s*firstFrameFile/)
  assert.match(adapter, /last_frame:\s*lastFrameFile/)
})
