import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

// 段间接力（连续拍）的接线。真正的不变量是「接力只能当参考图，不能当 first_frame」——
// JZL ref2v 节点没有 first_frame 输入、fl2va 节点没有 ref 槽位，两者互斥（实测一收到首帧
// 就丢参考行、角色完全重生成）。这里锁的是这层口径没被改回去。
const gen = readFileSync(new URL('../src/services/generation.ts', import.meta.url), 'utf8')
const view = readFileSync(new URL('../../frontend/app/views/drama/episode.vue', import.meta.url), 'utf8')
const bridge = readFileSync('E:/AI/ComfyUI/custom_nodes/ComfyUI-OpenAI-Bridge/__init__.py', 'utf8')
const adapter = readFileSync(new URL('../src/services/adapters/comfyui-video.ts', import.meta.url), 'utf8')

test('接力走参考图，不走 first_frame', () => {
  assert.match(gen, /if \(params\.chain\) \{[\s\S]*?relayContext\(record\.storyboardId\)/)
  assert.match(gen, /resolvedReferenceImageUrls\.push\(ctx\.url\)/)
  // 桥侧：first_frame 仍然只进 fl2va 图（ref2v 图里没有 first_frame 输入）
  assert.match(bridge, /if first_frame and "fl2va" in model|if first_frame:/)
  assert.doesNotMatch(bridge, /g\["302"\]\["inputs"\]\["first_frame"\]/)
})

test('三态衔接：same_shot 锚第 0 帧、同场景的 cut 只当参考、跨场景不带尾帧', () => {
  assert.match(gen, /ctx\?\.url && ctx\.sameScene && resolvedReferenceImageUrls\.length < 9/)
  assert.match(gen, /if \(ctx\.continuity === 'same_shot'\) \{[\s\S]*?guideUrl = ctx\.url/)
  // cut 的措辞不含 camera position
  assert.match(gen, /match its lighting and colour\.`/)
  assert.doesNotMatch(gen, /if \(ctx\.continuity === 'cut'\)[\s\S]{0,200}camera position/)
  // 桥：guide 存在时 AddGuide 挂在 ref2v conditioning 之后，ref 槽不丢
  assert.match(bridge, /"MiniMaxH3AddGuide"[\s\S]*?"frame_idx": 0/)
  assert.match(bridge, /cond = "312"/)
  assert.match(adapter, /guide: guideFile/)
})

test('槽位超 9 时不追加、也不在提示词里引一个不存在的 <Picture N>', () => {
  assert.match(gen, /resolvedReferenceImageUrls\.length < 9/)
  assert.match(gen, /continuity: <Picture \$\{n\}>/)
})

test('段必须按顺序跑：按集串队列，不是并发', () => {
  assert.match(gen, /const videoChains = new Map<number, Promise<void>>\(\)/)
  assert.match(gen, /videoChains\.set\(key, prev\.then\(run\)\)/)
  assert.match(view, /for \(const sb of targets\) await genVid\(sb, \{ silent: true \}\)/)
})

test('接力帧来自上一段「实际交付的成片」，按 storyboard_number 找上一段', () => {
  assert.match(gen, /eq\(schema\.storyboards\.storyboardNumber, cur\.n - 1\)/)
  assert.match(gen, /eq\(schema\.sysTask\.status, 'completed'\)/)
  assert.match(gen, /const source = prev\.videoUrl \|\| \(/)
  assert.match(gen, /extractLastFrame\(source\)/)
})

// 243 帧 SelfLift 实测 47:26（含解码），300 次 × 10s = 50 分钟正好卡边界：任务 128 就是被
// 「polling attempts exhausted」判失败的，而 ComfyUI 那边其实还在跑。
test('视频轮询上限盖得住 243 帧 SelfLift 的实测时长', () => {
  assert.match(gen, /video: \{ attempts: 600, intervalMs: 10_000/)
})
