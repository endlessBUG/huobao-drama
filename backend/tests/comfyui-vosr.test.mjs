// VOSR2（`ylchen333/ComfyUI-VOSR2`）的形状锁 + 接线锁。每条断言都指着源码或本机/社区实测：
//   · 节点名必须对得上 clone 下来的包里的 `node_id=`（memory comfyui-graph-gotchas 第 1 条：
//     自检只比字符串、从不问 ComfyUI，只有真提交那一刻才 node type not found）
//   · `requirements.txt` 只有 huggingface_hub ⇒ 零 pip、不违反 [[local-comfyui-env-frozen]]
//   · 必须按帧切块：`inference.py` 的 `_resize_to_target` 把整批先 bicubic 预放大再上 GPU
//     （362 帧 ×2 到 2560×1440 = 16 GB），所以 GPU 峰值 = 批大小 × 目标像素，与 tile_size 无关
//   · `tile_size` 不许是 0：作者本人确认「Tiling is not optional above 512px」（docs/VOSR2.md，
//     2026-09-01 与 Rongyuan Wu 的往来），`run_vosr2` 自己在 tile_size=0 且 >512 时打 warning
//   · `vae_tile_size` 必须开：>1024 输出走全图 VAE 解码，VOSR2Tool 在 **RTX 5060 8 GB** 上实测
//     1920×1080 解码单项 4.9 GB / 2.42 s（cuDNN benchmark 后 1.41 s）
//   · `upscale` 是 Int（`nodes_vosr.py`）⇒ 只有 ×1/×2/×3/×4，没有 ×1.7
//   · 它没有任何时序模块：`_generate_noise_batch` 给 batch 第 i 帧 `seed + i` ⇒ 逐帧独立噪声
//     （SeedVR2 的 `SeedVR2TemporalChunk` 就是为这个存在的，VOSR2 没有对应物）⇒ 探针要专门看闪烁
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const src = (p) => fs.readFileSync(path.join(root, 'src', p), 'utf-8')
const vosr = src('services/comfyui-vosr.ts')
const merge = src('services/ffmpeg-merge.ts')
const adapter = src('services/adapters/comfyui-video.ts')

const pkgDir = 'E:/AI/ComfyUI/custom_nodes/ComfyUI-VOSR2'
const pkg = (f) => fs.readFileSync(path.join(pkgDir, f), 'utf-8')

test('包已装、节点名对得上包里的 node_id（不是类名），且零 pip', () => {
  assert.ok(fs.existsSync(path.join(pkgDir, 'nodes_vosr.py')), 'ComfyUI-VOSR2 没 clone 到 custom_nodes')
  const registered = new Set([...pkg('nodes_vosr.py').matchAll(/node_id="([A-Za-z0-9_]+)"/g)].map(m => m[1]))
  assert.ok(registered.has('VOSR2ModelLoader') && registered.has('VOSR2Upscale'), '包里的 node_id 变了，图要跟着改')
  const used = [...vosr.matchAll(/class_type: '([A-Za-z0-9_]+)'/g)].map(m => m[1])
  for (const n of ['VOSR2ModelLoader', 'VOSR2Upscale']) {
    assert.ok(used.includes(n), `图里必须用注册名 ${n}`)
  }
  const deps = pkg('requirements.txt').split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'))
  assert.deepEqual(deps, ['huggingface_hub'], '依赖一变就要重新过「会不会撞冻结 torch」这一关（memory local-comfyui-env-frozen）')
})

test('图用 API 的 inputs 形状、有 output 节点、动态组合用点号键', () => {
  assert.ok(vosr.includes("class_type: 'LoadVideo', inputs:"), 'LoadVideo 必须走 inputs（comfy_execution/graph.py:131）')
  assert.ok(!/buildVosrGraph[\s\S]*?widgets_values/.test(vosr), '图里不该出现 widgets_values')
  assert.ok(vosr.includes("class_type: 'SaveVideo'"), '必须有 output 节点，否则 /prompt 报 prompt_no_outputs')
  assert.ok(vosr.includes("'format.codec': 'auto'"), 'SaveVideo 的 format 是 DynamicCombo ⇒ 点号键（memory comfyui-graph-gotchas 第 4 条）')
  assert.ok(vosr.includes("fps: ['2', 2], audio: ['2', 1]"), 'GetVideoComponents 的槽序是 IMAGE/AUDIO/FLOAT…（本机官方 blueprint 实测）')
})

test('必须按帧切块：整批预放大是 GPU 账，不是 tile 账', () => {
  assert.ok(vosr.includes("class_type: 'ImageFromBatch'"), 'core 的 ImageFromBatch(image/batch_index/length) 是切块器')
  assert.ok(vosr.includes("batch_index: i * chunkFrames, length: Math.min(chunkFrames, frames - i * chunkFrames)"), '切块要按帧号算，最后一块短也要对')
  assert.ok(vosr.includes("class_type: 'ImageBatch'") && vosr.includes('image1:') && vosr.includes('image2:'), '拼回来用 ImageBatch(image1/image2)')
  assert.ok(vosr.includes('Math.ceil(frames / chunkFrames)'), '块数由帧数算（362 帧 / 48 = 8 块）')
  assert.ok(vosr.includes('DEFAULT_CHUNK_FRAMES = 48'), '48 帧/块 = 2.1 GB 预放大 + ≈4 GB 权重 ≈ 6.1 GB，8 GB 卡上唯一不换页的档')
  assert.ok(vosr.includes('probeFrameCount'), '帧数要靠 ffprobe 探（切块要靠它）')
  assert.ok(vosr.includes('v.nb_frames') && vosr.includes('r_frame_rate'), 'nb_frames 优先，拿不到才用 duration×fps')
})

test('tile 不许是 0（模型只在 512×512 训过），VAE 也必须分块', () => {
  assert.ok(vosr.includes('DEFAULT_TILE_SIZE = 512'), '作者确认「Tiling is not optional above 512px」（docs/VOSR2.md 的 Author confirmation）')
  assert.ok(vosr.includes('DEFAULT_VAE_TILE_SIZE = 1024'), '>1024 输出全图 VAE 解码实测 4.9 GB（VOSR2Tool 的 RTX 5060 8GB 表）⇒ 8 GB 上必须开')
  assert.ok(vosr.includes('DEFAULT_TILE_OVERLAP = 32'), '1008 改回包的默认 32（我原先加到 64 = tile 面积多付 ~25%，而真正的钱在换载上）')
  assert.ok(vosr.includes('tile_size: tileSize') && vosr.includes('vae_tile_size: vaeTileSize'), '两个 tile 开关都要真传进图')
  assert.ok(/tile_overlap\(\$\{tileOverlap\}\) 必须 < tile_size/.test(vosr), 'overlap ≥ size 在提交前拦（nodes_vosr.py 的 validate_inputs 同口径）')
  assert.ok(vosr.includes("color_alignment: colorAlignment"), '色彩对齐默认 wavelet（包自己的推荐值）')
  assert.ok(vosr.includes('upscale < 1'), 'upscale 是 Int、只有 ×1/×2/×3/×4（没有 ×1.7）')
})

test('只在成功之后才原地覆盖，耗时用 history 的两个时间戳', () => {
  const guard = vosr.indexOf("status !== 'success'")
  const copy = vosr.indexOf('fs.copyFileSync(outAbs, targetAbs)')
  assert.ok(guard > 0 && copy > guard, 'copyFileSync 必须排在 status 校验之后：失败要保留原成片')
  assert.ok(vosr.includes('产物不在盘上'), '产物落盘位置要校验，不能假设 history 里有名字就存在')
  assert.ok(vosr.includes('execution_success') && vosr.includes('execution_start'), '耗时口径 = history 的 execution_start→success（脚本那个数含排队）')
  assert.ok(vosr.includes('Math.random() * 1e15'), 'seed 每次换：同 seed 会命中 ComfyUI 缓存、量不到真耗时')
  assert.ok(vosr.includes('baseSeed + i * chunkFrames'), '每块 seed 错开：包自己的语义是 batch 第 i 帧 seed+i（逐帧独立噪声，探针要看闪烁）')
  // 1008 实测：被 /interrupt 打断的作业在这版 ComfyUI 里根本不写 history（6006 日志有
  // `Cancelling running prompt … ×8` + `Processing interrupted` + `Prompt executed in 588.64 s`，
  // 而 /history 始终只有 2 条）⇒ 只盯 history 会空转到超时（merge 15 就是这么卡住的）。
  assert.ok(vosr.includes('queue_running') && vosr.includes('queue_pending'), '必须同时查 /queue 的这两个键（读错键永远得 0 —— memory comfyui-launch-args）')
  assert.ok(vosr.includes('missingRounds >= 3'), 'history 和 /queue 都查不到就早退，不许空转到 2 h 超时')
  // 1010：merge 21 被旧的 2 h 上限误判 —— ComfyUI 侧 162.9 min 成功、2K 产物在 output 里，后端却把
  // 未超分的 concat 当交付件（同形状实测 44.0 s/帧 ⇒ 362 帧 4.4 h，上限必须给到 6 h）
  assert.ok(vosr.includes('21600_000'), '轮询上限给到 6 h（×2 到 2K 实测 44.0 s/帧 = 362 帧 4.4 h）')
  assert.ok(vosr.includes('findRescueOutput') && /alive \? null : findRescueOutput/.test(vosr), '超时先问 /queue：还在跑就不认半成品，不在跑了就用盘上的产物兜底')
})

test('接线：body.upscale="vosr2" 走 VOSR2、默认关、失败吞掉；SelfLift 已下掉', () => {
  assert.ok(merge.includes('const vosrMode = /^vosr/i.test(upscaleMode)'), '分叉靠请求体（要能走平台端点触发，不能只靠 env）')
  assert.ok(merge.includes('SEEDVR2_UPSCALE'), '默认关：不设 env / 不传 body = 行为与之前一致')
  assert.ok(merge.includes('const feed = vosrMode'), 'VOSR2 模式不在交付端先放大（放大是模型的活）')
  assert.ok(merge.includes('parseSize(opts?.inputSize)'), '1k→2k 靠 input_size 预缩：模型工作尺寸 = 交付尺寸 ÷ 倍率')
  const vosrCall = merge.indexOf('upscaleVideoViaVOSR(')
  const seedvrCall = merge.indexOf('upscaleVideoViaSeedVR(')
  const interp = merge.indexOf('interpolateVideoViaDLSS(')
  const dur = merge.indexOf('getVideoDuration(outputPath)')
  assert.ok(vosrCall > 0 && vosrCall < interp && seedvrCall < interp, '修复都在补帧之前（补帧读的是覆盖后的文件）')
  assert.ok(dur > vosrCall && dur > seedvrCall, '时长必须在修复之后测（库里要记最终交付件）')
  assert.ok(/catch \(err: any\)[\s\S]{0,240}logTaskError\('MergeTask', 'episode-merge-upscale'/.test(merge),
    '修复失败只记日志、不抛 —— 不能让它拖垮导出')
  const route = src('routes/merge.ts')
  assert.ok(route.includes('body?.upscale') && route.includes('upscale: upscaleMode'), '路由必须把 body.upscale 传到 mergeEpisodeVideos')
  assert.ok(route.includes('body?.upscale_factor') && merge.includes('opts?.upscaleFactor ||'), '倍率也要能走请求体（×1 是 8 GB 上唯一跑得完 362 帧的形态）')
  assert.ok(route.includes('body?.input_size') && route.includes('upscaleFactor, inputSize }'), '喂给模型的尺寸也要能走请求体（1280x720 + ×2 = 直出 2560x1440）')
  assert.ok(adapter.includes('selflift: false,'), '1008 定案：二采不再做（回退 = 改回 !firstFrameFile）')
  assert.ok(adapter.includes("const rawSize = /^\\d+x\\d+$/.test("), '画布可直写（1280x720 这档靠它，不用改代码）')
})
