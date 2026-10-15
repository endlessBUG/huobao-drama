import { readFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ComfyUIVideoAdapter } from '../src/services/adapters/comfyui-video.ts'

// 1016 定案（用户看片拍板「就用这个」）：生产 = 20 步单采 @1024×768，无 turbo LoRA，nvfp4 + Veda sp24。
// 实测锚 = x2432s20 674 s（docs/comfyui-h3-configs.md「1016 定案」）。锁三处：
//   ① 适配器默认画布 1024×768、body 带 steps:20 + no_lora:true（ref2v 路径）
//   ② 桥 `_wf_video_native(turbo=)` 只为真时摘节点 2、默认路径逐字节不变（其他调用方共用这座桥）
//   ③ 首尾帧不吃例外（1016 用户「首尾帧也要支持」）：桥把首/尾帧当 MiniMaxH3AddGuide 锚进 7 号
//      conditioning（frame_idx 0 / -1），画布与步数跟定案一致；老 fl2va 图（576×320 / 4 步）
//      只剩 body graph:"jzl" 显式回退，平台适配器不再触达 —— 断了这条锁，首尾帧会在无警告的
//      情况下退回没量过的 576×320 组合。
const bridge = readFileSync('E:/AI/ComfyUI/custom_nodes/ComfyUI-OpenAI-Bridge/__init__.py', 'utf8')
const adapter = readFileSync(new URL('../src/services/adapters/comfyui-video.ts', import.meta.url), 'utf8')

// 首帧 staging 会往 ComfyUI input/ 落文件 —— 测试指到临时目录，别脏了 6006 的 input。
process.env.COMFYUI_INPUT_DIR = mkdtempSync(join(tmpdir(), 'hb-input-'))
const a = new ComfyUIVideoAdapter()
const cfg = { baseUrl: 'http://127.0.0.1:6006' }
const rec = (o) => ({ prompt: 'x', referenceImageUrls: '[]', ...o })
const PNG_1PX = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

test('定案：ref2v 默认 = 1024x768 满画布 + 20 步 + no_lora', async () => {
  const { body } = await a.buildGenerateRequest(cfg, rec({ duration: 10, resolution: '720p' }))
  assert.equal(body.size, '1024x768')
  assert.equal(body.steps, 20)
  assert.equal(body.no_lora, true)
  assert.equal(body.length, 243)
})

test('定案：显式 480p 仍是 864x480（档位是用户选择，步数/去 LoRA 跟着走）', async () => {
  const { body } = await a.buildGenerateRequest(cfg, rec({ duration: 5, resolution: '480p' }))
  assert.equal(body.size, '864x480')
  assert.equal(body.steps, 20)
  assert.equal(body.no_lora, true)
})

test('首尾帧：两张各自 staging、画布/步数跟定案走（不再落 fl2va 的 576×320）', async () => {
  const { body } = await a.buildGenerateRequest(cfg, rec({
    duration: 10, resolution: '720p', firstFrameUrl: PNG_1PX, lastFrameUrl: PNG_1PX }))
  assert.match(String(body.first_frame), /^huobao_ref_\d+_[a-z0-9]+\.png$/)
  assert.match(String(body.last_frame), /^huobao_ref_\d+_[a-z0-9]+\.png$/)
  assert.notEqual(body.first_frame, body.last_frame) // 两次 staging 各落一个文件，不互相覆盖
  assert.equal(body.size, '1024x768')
  assert.equal(body.steps, 20)
  assert.equal(body.no_lora, true)
})

test('只给一张（尾帧）时另一键不出现 —— 桥那边就不进那一段 AddGuide', async () => {
  const { body } = await a.buildGenerateRequest(cfg, rec({ duration: 5, resolution: '480p', lastFrameUrl: PNG_1PX }))
  assert.equal(body.first_frame, undefined)
  assert.match(String(body.last_frame), /^huobao_ref_\d+_[a-z0-9]+\.png$/)
  assert.equal(body.size, '864x480')
})

test('桥：turbo 只为真时摘节点 2；no_lora body 键默认缺省（老行为逐字节不变）', () => {
  assert.match(bridge, /steps=4, turbo=True,/)
  assert.match(bridge, /if turbo:\s*\n\s*model = \["2", 0\]\s*\n\s*else:\s*\n\s*g\.pop\("2"\)\s*\n\s*model = \["1", 0\]/)
  assert.match(bridge, /turbo=\(False if b\.get\("no_lora"\) is True else True\)/)
})

test('适配器只发 no_lora:true 这一种写法，且 20 步没有分支', () => {
  assert.match(adapter, /const DEFAULT_SIZE = '1024x768'/)
  assert.match(adapter, /^\s+steps: 20,$/m)
  assert.match(adapter, /no_lora: true/)
  assert.doesNotMatch(adapter, /no_lora: false/)
  assert.doesNotMatch(adapter, /steps: firstFrameFile/) // 首尾帧不再有步数例外
})

test('progressHint 跟定案走：1024x768 = 674 s/243 帧实测锚', () => {
  assert.equal(a.progressHint(rec({ duration: 10, resolution: '720p' })), 674)
  assert.equal(a.progressHint(rec({ duration: 5, resolution: '720p' })), 344)
  assert.equal(a.progressHint(rec({ duration: 5, resolution: '480p' })), 364)
})
