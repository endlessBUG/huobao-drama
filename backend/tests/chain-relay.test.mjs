import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

// 段间接力（连续拍）的接线。真正的不变量是「接力只能当参考图，不能当 first_frame」——
// JZL ref2v 节点没有 first_frame 输入、fl2va 节点没有 ref 槽位，两者互斥（实测一收到首帧
// 就丢参考行、角色完全重生成）。这里锁的是这层口径没被改回去。
const gen = readFileSync(new URL('../src/services/generation.ts', import.meta.url), 'utf8')
const view = readFileSync(new URL('../../frontend/app/views/drama/episode.vue', import.meta.url), 'utf8')
const bridge = readFileSync('E:/AI/ComfyUI/custom_nodes/ComfyUI-OpenAI-Bridge/__init__.py', 'utf8')

test('接力走参考图，不走 first_frame', () => {
  assert.match(gen, /if \(params\.chain\) \{[\s\S]*?relayLastFrame\(record\.storyboardId\)/)
  assert.match(gen, /resolvedReferenceImageUrls\.push\(relay\)/)
  // 桥侧：first_frame 仍然只进 fl2va 图（ref2v 图里没有 first_frame 输入）
  assert.match(bridge, /if first_frame and "fl2va" in model|if first_frame:/)
  assert.doesNotMatch(bridge, /g\["302"\]\["inputs"\]\["first_frame"\]/)
})

test('槽位超 9 时不追加、也不在提示词里引一个不存在的 <Picture N>', () => {
  assert.match(gen, /resolvedReferenceImageUrls\.length < 9/)
  assert.match(gen, /continuity: <Picture \$\{resolvedReferenceImageUrls\.length\}>/)
})

test('段必须按顺序跑：按集串队列，不是并发', () => {
  assert.match(gen, /const videoChains = new Map<number, Promise<void>>\(\)/)
  assert.match(gen, /videoChains\.set\(key, prev\.then\(run\)\)/)
  assert.match(view, /for \(const sb of targets\) await genVid\(sb, \{ silent: true \}\)/)
})

test('接力帧来自上一段「已完成」的视频任务，按 storyboard_number 找上一段', () => {
  assert.match(gen, /eq\(schema\.storyboards\.storyboardNumber, cur\.n - 1\)/)
  assert.match(gen, /eq\(schema\.sysTask\.status, 'completed'\)/)
  assert.match(gen, /extractLastFrame\(t\.localPath\)/)
})

// 243 帧 SelfLift 实测 47:26（含解码），300 次 × 10s = 50 分钟正好卡边界：任务 128 就是被
// 「polling attempts exhausted」判失败的，而 ComfyUI 那边其实还在跑。
test('视频轮询上限盖得住 243 帧 SelfLift 的实测时长', () => {
  assert.match(gen, /video: \{ attempts: 600, intervalMs: 10_000/)
})
