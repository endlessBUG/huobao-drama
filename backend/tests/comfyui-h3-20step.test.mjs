import { readFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ComfyUIVideoAdapter, effectiveGraph, isSelfContainedGraph } from '../src/services/adapters/comfyui-video.ts'

// 1024 定案（用户「重做 换成不要lora 1采 20步」）：生产回 native 单采 20 步、无 LoRA（PDD 撤回）。
// 实测锚 = 1018 task 542 294 帧整单 864 s（docs/comfyui-h3-configs.md「当前最优」）。锁三处：
//   ① 适配器默认画布 1024×768、body 带 steps:20 + no_lora:true + graph:'native'（ref2v 路径）
//   ② 桥 `_wf_video_native(turbo=)` 只为真时摘节点 2、默认路径逐字节不变（其他调用方共用这座桥）
//   ③ 首尾帧不吃例外（1016 用户「首尾帧也要支持」）：桥把首/尾帧当 MiniMaxH3AddGuide 锚进 7 号
//      conditioning（frame_idx 0 / -1），画布与步数跟定案一致；老 fl2va 图（576×320 / 4 步）
//      只剩 body graph:"jzl" 显式回退，平台适配器不再触达 —— 断了这条锁，首尾帧会在无警告的
//      情况下退回没量过的 576×320 组合。
const bridge = readFileSync('E:/AI/ComfyUI/custom_nodes/ComfyUI-OpenAI-Bridge/__init__.py', 'utf8')
const adapter = readFileSync(new URL('../src/services/adapters/comfyui-video.ts', import.meta.url), 'utf8')
const generation = readFileSync(new URL('../src/services/generation.ts', import.meta.url), 'utf8')

// 首帧 staging 会往 ComfyUI input/ 落文件 —— 测试指到临时目录，别脏了 6006 的 input。
process.env.COMFYUI_INPUT_DIR = mkdtempSync(join(tmpdir(), 'hb-input-'))
const a = new ComfyUIVideoAdapter()
const cfg = { baseUrl: 'http://127.0.0.1:6006' }
const rec = (o) => ({ prompt: 'x', referenceImageUrls: '[]', ...o })
const PNG_1PX = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

// 1108 用户「必须以目前一条龙的方式 这个是目前测试最好的情况」⇒ 无 LoRA 的镜 = 一条龙那份图：
// 0.9 MP / 16:9 = 1280×736、turbo 4 步（no_lora 不发、节点 2 留着）、桥自带 RIFE ×2 + RelayVSR ×2。
test('1108 一条龙：无 LoRA 的镜默认走 native（1280x736、turbo 6 步、桥自带补帧超分）', async () => {
  const { body } = await a.buildGenerateRequest(cfg, rec({ duration: 10, resolution: '720p' }))
  assert.equal(body.size, '1280x736')
  assert.equal(body.steps, 6)
  assert.equal(body.no_lora, undefined)   // 不发 = 桥留着 turbo 节点 2
  assert.equal(body.graph, 'native')
  assert.equal(body.length, 243)
})

test('一条龙画布恒为 0.9 MP：帧数再长也不缩，老生产画布不当显式选择', async () => {
  const { oneShotSize } = await import('../src/services/adapters/comfyui-video.ts')
  assert.equal(oneShotSize(124), '1280x736')
  assert.equal(oneShotSize(294), '1280x736')   // 1108 用户「画布是 0.9」
  assert.equal(oneShotSize(362), '1280x736')
  // 12 秒镜同样送 0.9 MP —— 腾显存靠桥里采样前的 BanZhang_VRAM_Cleaner，不靠缩画布
  const { body } = await a.buildGenerateRequest(cfg, rec({ duration: 12, resolution: '1024x576' }))
  assert.equal(body.length, 294)
  assert.equal(body.size, '1280x736')
})

test('一条龙自带 RIFE+VSR ⇒ isSelfContainedGraph 认它（含默认档），别的图不认', () => {
  assert.equal(isSelfContainedGraph(undefined), true)          // 不传 graph = 默认就是 native 一条龙
  assert.equal(isSelfContainedGraph('native'), true)           // 尾段补帧超分在桥里，平台后处理必须关，否则叠两遍
  assert.equal(isSelfContainedGraph('h3_3pass_1031_probe3_q12.json'), true)
  assert.equal(isSelfContainedGraph('h3_refall_cpuTE.json'), false)
  assert.equal(isSelfContainedGraph(undefined, 'free_pussy.safetensors'), true)
  assert.equal(effectiveGraph(undefined, 'free_pussy.safetensors'), 'native')
})

test('1108 一条龙吃掉有床的镜：reference_audio ⇒ 落到 input/ 的 bed，图走 native（原生参考音频）', async () => {
  // 1 采样点的 WAV（真的音频头，扩展名要按 MIME 判 .wav，不能默认 .png）
  const WAV = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAESsAABErAAABAAgAZGF0YQAAAAA='
  const { body } = await a.buildGenerateRequest(cfg, rec({
    duration: 5, referenceAudioUrls: JSON.stringify([WAV]) }))
  assert.match(String(body.bed), /^huobao_ref_\d+_[a-z0-9]+\.wav$/)
  assert.equal(body.graph, 'native')
  assert.equal(effectiveGraph(undefined, undefined, true), 'native')
  assert.equal(effectiveGraph(undefined, 'free_pussy.safetensors', true), 'native')
  assert.equal(isSelfContainedGraph(undefined, undefined, true), true)
  // 显式 graph 仍是回退档（旧的两采/锁音图都还在盘上）
  assert.equal(effectiveGraph('h3_2pass_12step_int8.json', undefined, true), 'h3_2pass_12step_int8.json')
  assert.equal(effectiveGraph('h3_3pass_lock.json', undefined, true), 'h3_3pass_lock.json')
  assert.equal(isSelfContainedGraph('h3_3pass_lock.json', undefined, true), true)
  assert.equal(effectiveGraph(undefined, undefined, false), 'native')
})

test('1108 桥：fullchain 尾段 = RIFE ×2（保留原音关）→ RelayVSR ×2 detail 0.4 → 音轨取一采', () => {
  assert.match(bridge, /"保留原音": "关"/)
  assert.match(bridge, /"detail": 0\.4/)
  assert.match(bridge, /"audio": \[audio_src, 0\], "fps": \["51", 2\]/)
  assert.match(bridge, /fullchain=\(False if b\.get\("fullchain"\) is False else True\)/)
  // 床走原生参考音频家族（不是 CSGlide 媒体架）
  assert.match(bridge, /cond\["ref_audios\.ref_audio_0"\] = \["47", 0\]/)
  // 采样前净化是 env 门控、默认不进图（用户「必须和一条龙一致」：默认图要与他那份逐节点相同）
  assert.match(bridge, /if os\.environ\.get\("HUOBAO_H3_PURGE"\) in \("1", "true", "True"\):\s*\n\s*g\["48"\] = \{"class_type": "BanZhang_VRAM_Cleaner"/)
  assert.match(bridge, /"卸载模型": True, "清理缓存": True, "入口": cond_src\}/)
})

test('1108 桥：床走媒体架时提示词补 <Audio 1>，锁音图（有 LoadAudio）不补', () => {
  assert.match(bridge, /prompt = _bed_audio_prompt\(prompt\)/)
  assert.match(bridge, /if bed and not any\(n\["class_type"\] == "LoadAudio"/)
  assert.match(bridge, /"\[reference generation \+ audio reuse\]", 1\)/)
})

test('1025：挂 LoRA 的镜仍走 native（桥的 saved 图分支不认 body lora，挂上去会静默丢）', async () => {
  const { body } = await a.buildGenerateRequest(cfg, rec({ duration: 10, lora: 'free_pussy.safetensors' }))
  assert.equal(body.graph, 'native')
  assert.equal(body.lora, 'free_pussy.safetensors')
})

test('定案：显式 480p 仍是 864x480（档位是用户选择，步数/去 LoRA 跟着走）', async () => {
  const { body } = await a.buildGenerateRequest(cfg, rec({ duration: 5, resolution: '480p' }))
  assert.equal(body.size, '864x480')
  assert.equal(body.steps, 6)
  assert.equal(body.no_lora, undefined)
})

test('首尾帧：两张各自 staging、画布/步数跟定案走（不再落 fl2va 的 576×320）', async () => {
  const { body } = await a.buildGenerateRequest(cfg, rec({
    duration: 10, resolution: '720p', firstFrameUrl: PNG_1PX, lastFrameUrl: PNG_1PX }))
  assert.match(String(body.first_frame), /^huobao_ref_\d+_[a-z0-9]+\.png$/)
  assert.match(String(body.last_frame), /^huobao_ref_\d+_[a-z0-9]+\.png$/)
  assert.notEqual(body.first_frame, body.last_frame) // 两次 staging 各落一个文件，不互相覆盖
  assert.equal(body.size, '1280x736')
  assert.equal(body.steps, 6)
  assert.equal(body.no_lora, undefined)
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

test('1025：body 显式 graph 原样透传（1018 写死 PROD_GRAPH 会把它吞掉）', async () => {
  const { body } = await a.buildGenerateRequest(cfg, rec({ duration: 10, graph: 'h3_refall_cpuTE.json' }))
  assert.equal(body.graph, 'h3_refall_cpuTE.json')
})

test('适配器：一条龙生产 = turbo 6 步（无 LoRA）/ no_lora 只在挂分镜 LoRA 时发', () => {
  assert.match(adapter, /const PROD_GRAPH = 'native'/)
  assert.match(adapter, /const PROD_GRAPH_3PASS = 'h3_3pass_1031_probe3_q12\.json'/)
  assert.match(adapter, /const PROD_GRAPH_2PASS = 'h3_2pass_12step_int8\.json'/)
  // 1108：缺省一律 native（显式 graph 仍优先；三采/两采图留在盘上作回退档）
  assert.match(adapter, /graph: effectiveGraph\(record\.graph, record\.lora, Boolean\(bedFile\)\),/)
  assert.match(adapter, /steps: record\.steps \?\? \(record\.lora \? \(LORA_BY_FILE\[record\.lora\]\?\.config\?\.steps \?\? 20\) : 6\),/)
  assert.match(adapter, /no_lora: record\.lora \? true : undefined,/)
  assert.doesNotMatch(adapter, /no_lora: false/)
  assert.doesNotMatch(adapter, /steps: firstFrameFile/) // 首尾帧不再有步数例外
})

// 1108 社区共识「4 步是下限、6–8 步明显更好」⇒ 平台加一个可选 steps 仪表做单变量 A/B。
// 缺省行为必须逐字节不变（不传 = 老口径），且快照/record 两处都要抄到，否则 processTask 读不到。
test('1108 A/B 仪表：显式 steps 覆盖缺省（不传仍 6 步），快照与 record 都抄', async () => {
  const { body } = await a.buildGenerateRequest(cfg, rec({ duration: 10, resolution: '720p', steps: 4 }))
  assert.equal(body.steps, 4)
  const { body: b6 } = await a.buildGenerateRequest(cfg, rec({ duration: 10, resolution: '720p' }))
  assert.equal(b6.steps, 6)
  // 快照一次 + processTask record 一次（同 sparse/graph 的旧病：少抄一边静默丢）
  assert.ok((generation.match(/steps: params\.steps/g) || []).length >= 2)
})

test('挂分镜 LoRA 的镜仍是 1023/1024 定案：摘 turbo、按 LoRA config 的 20 步', async () => {
  const { body } = await a.buildGenerateRequest(cfg, rec({ duration: 10, lora: 'free_pussy.safetensors' }))
  assert.equal(body.no_lora, true)
  assert.equal(body.steps, 20)       // LORA_REGISTRY 的 config.steps
  assert.equal(body.lora, 'free_pussy.safetensors')
})

test('progressHint 跟定案走：1024x768 = 674 s/243 帧实测锚', () => {
  assert.equal(a.progressHint(rec({ duration: 10, resolution: '720p' })), 674)
  assert.equal(a.progressHint(rec({ duration: 5, resolution: '720p' })), 344)
  assert.equal(a.progressHint(rec({ duration: 5, resolution: '480p' })), 364)
})
