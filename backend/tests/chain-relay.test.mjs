import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

// 段间接力的接线。不变量：接力走 keyframe 窗口（MiniMaxH3AddGuide），不当 first_frame。
// keyframe 与 ref 槽不互斥 —— model_base.py:2188-2196 里两者进同一个 cond_video_latents；
// 互斥的只是旧的 fl2va 分支（ImageToVideoDual 没有 ref 槽）。窗口段首是照搬的跑道，必须裁。
const gen = readFileSync(new URL('../src/services/generation.ts', import.meta.url), 'utf8')
const view = readFileSync(new URL('../../frontend/app/views/drama/episode.vue', import.meta.url), 'utf8')
const bridge = readFileSync('E:/AI/ComfyUI/custom_nodes/ComfyUI-OpenAI-Bridge/__init__.py', 'utf8')
const adapter = readFileSync(new URL('../src/services/adapters/comfyui-video.ts', import.meta.url), 'utf8')

test('接力走 keyframe 窗口（latent 直传优先），不走 first_frame', () => {
  assert.match(gen, /if \(params\.chain\) \{[\s\S]*?relayContext\(record\.storyboardId\)/)
  assert.match(gen, /guideUrl = await extractLastFrame\(ctx\.source\)/)
  assert.match(bridge, /if first_frame and "fl2va" in model|if first_frame:/)
  assert.doesNotMatch(bridge, /g\["302"\]\["inputs"\]\["first_frame"\]/)
})

test('三态衔接：跨场景不接；同场景按 continuity 决定措辞', () => {
  assert.match(gen, /ctx\?\.source && ctx\.sameScene/)
  assert.match(gen, /const mode = ctx\.continuity === 'same_shot' \? 'lighting, colour and camera position' : 'lighting and colour'/)
  // 桥：guide 存在时 AddGuide 挂在 ref2v conditioning 之后，ref 槽不丢
  assert.match(bridge, /"frame_idx": 0[\s\S]*?"MiniMaxH3AddGuide"/)
  assert.match(bridge, /cond = "312"/)
  assert.match(adapter, /guide: guideFile/)
  // 拼过 continuity 的那个 prompt 必须真的进 adapter：曾经写成 record.prompt，实测队列里
  // 的 prompt 完全没有 continuity 行（1005）
  assert.match(gen, /const req = await adapter\.buildGenerateRequest\(config, \{[\s\S]{0,400}?\r?\n        prompt,\r?\n/)
})

test('衔接走上一段 latent 直传（零 VAE 往返），落盘前只裁窗口 22 帧', () => {
  assert.match(gen, /prevLatent = `sb\$\{ctx\.prevId\}`/)
  assert.match(gen, /trimFrames = SEAM_WINDOW/)
  assert.match(gen, /guideUrl = await extractLastFrame\(ctx\.source\)/)
  assert.match(adapter, /prev_latent: record\.prevLatent/)
  assert.match(adapter, /save_name: record\.saveName/)
  // 窗口在生成长度内（不是额外跑道）：22 帧是 17m+5 ⇒ 必落 token 边界，落盘 = 243 − 22 = 221
  assert.match(adapter, /length: framesForDuration\(record\.duration\),/)
  assert.equal((22 - 5) % 17, 0)
  assert.match(bridge, /BridgeSeamGuideFromLatent/)
  assert.match(bridge, /os\.path\.isfile\(pt\)/)
  assert.match(bridge, /BridgeSaveAVLatent/)
  // 文件不在时回退 pixel 路径（那张 PNG 也是页面显示的那一帧）
  assert.match(bridge, /elif guide:/)
})

test('多帧窗口走视频加载节点，单帧仍走 LoadImage', () => {
  assert.match(bridge, /VHS_LoadVideoPath/)
  assert.match(bridge, /endswith\(\("\.mp4", "\.mov", "\.webm", "\.mkv"\)\)/)
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
  assert.match(gen, /extractLastFrame\(ctx\.source\)/)
})

test('前端的衔接显示与后端同一个判据：跨场景不接', () => {
  assert.match(view, /const sameScene = \(sb\.scene_id \?\? sb\.sceneId\) === \(prev\.scene_id \?\? prev\.sceneId\)/)
  assert.match(view, /c\.mode === 'anchor' \? t\('episode\.sb\.chainAnchor'\)/)
  assert.match(gen, /ctx\?\.source && ctx\.sameScene/)
  // 检查器「绑定参考图」下方也要显示接的那一帧；前端读 _last.png，所以后端接力时必须落它
  // v-for 与 v-if 同元素时 v-if 先求值（拿不到循环变量）⇒ 必须用 filter，别写回 v-if
  assert.match(view, /v-for="c in \[chainInfo\(selectedSb\)\]\.filter\(/)
  assert.doesNotMatch(view, /v-for="c in \[chainInfo\([^)]*\)\]" v-if=/)
  // 视频制作列表的行标题必须是分镜标题，不能是 description（每条 description 都以【镜头1】开头 → 整列看着都是「镜头1」）
  assert.match(view, /title: sb\.title \|\| t\('episode\.vid\.shotN'/)
  // comfyui 档位必须写真实像素：'480p'→864×480、'720p'→1472×832（comfyui-video.ts:42/48），且不给空档位 1080p
  assert.match(view, /comfyui: \['480p', '720p'\]/)
  assert.match(view, /comfyui: \{ '480p': '864×480', '720p': '1472×832' \}/)
  assert.match(gen, /await extractLastFrame\(ctx\.source\)/)
})

// 243 帧 SelfLift 实测 47:26（含解码），300 次 × 10s = 50 分钟正好卡边界：任务 128 就是被
// 「polling attempts exhausted」判失败的，而 ComfyUI 那边其实还在跑。
test('视频轮询上限盖得住 243 帧 SelfLift 的实测时长', () => {
  assert.match(gen, /video: \{ attempts: 600, intervalMs: 10_000/)
})
