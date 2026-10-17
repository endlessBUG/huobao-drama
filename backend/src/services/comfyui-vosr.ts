// ComfyUI-VOSR2（`ylchen333/ComfyUI-VOSR2` ⭐274，作者本人 2026-09-01 确认过口径）挂在交付端 merge 之后：
// 720p 直采（下掉 SelfLift）→ VOSR2 ×2 → 2K。零 pip —— 它的 `requirements.txt` 只有 `huggingface_hub`
// （ComfyUI 自带），所以不违反 [[local-comfyui-env-frozen]]；`loader.py` 真用 `comfy.model_patcher` /
// `comfy.model_management` / `comfy.ops`，`models/lightningdit.py` 走 `F.scaled_dot_product_attention`
// ⇒ 不需要 xFormers（官方 issue #5 那个 RTX 5090 上 `memory_efficient_attention` 崩的坑，ComfyUI 路径没有）。
//
// 为什么必须分块（不是可选优化）：
//   · `inference.py` 的 `_resize_to_target` 把整批 IMAGE **先 bicubic 预放大再上 GPU**（上游口径：
//     「模型实际在目标分辨率上工作」），所以 GPU 占用 = 批大小 × 目标像素。362 帧 ×2 到 2560×1440
//     = 16 GB，48 帧 = 2.1 GB（+ 权重 bf16 2.66 GB + DINOv2 fp32 1.2 GB + VAE 0.18 GB ≈ 6.1 GB）
//     ⇒ 8 GB 卡上只能按帧切，这里用 core 的 `ImageFromBatch`(image/batch_index/length) 切、
//     `ImageBatch`(image1/image2) 拼回来。分块路径本身是 `_run_tiled_single`（B=1 逐帧循环），
//     它每解码一帧就 `.cpu()` 并逐帧做色彩对齐 —— 所以 GPU 峰值与批大小无关，但**系统内存**
//     装的是整批输出（2K/362 帧 fp32 = 16 GB），这条是本机真正的天花板，写在这里备查。
//   · `tile_size` 不能是 0：模型只在 512×512 训过（作者原话，issue #10「trained only at 512x512…
//     degrade noticeably… expected limitation of the current checkpoint」），`docs/VOSR2.md` 里作者
//     确认「Tiling is not optional above 512px」。`run_vosr2` 自己也会在 tile_size=0 且 >512 时
//     打 warning。`vae_tile_size` 同理：>1024 输出全图解码实测要 4.9 GB（VOSR2Tool 的 5060 8GB 表），
//     8 GB 卡上必须开。
//   · `upscale` 是 Int（`nodes_vosr.py`：`io.Int.Input("upscale", default=4, min=1, max=sys.maxsize)`）
//     ⇒ 只有 ×1/×2/×3/×4，没有 ×1.7。
//   · 它**没有任何时序模块**：`_generate_noise_batch` 给 batch 第 i 帧 `seed + i` ⇒ 逐帧独立噪声
//     （纹理会逐帧变）。SeedVR2 那套 `SeedVR2TemporalChunk`（4n+1 latent 帧 + Hann crossfade）就是为
//     这个存在的，VOSR2 没有对应物 —— 探针要专门看这条。
import fs from 'node:fs'
import path from 'node:path'
import { baseOf, readReferenceBytes, toInputDir } from './adapters/comfyui-common.js'
import { getJson, postJson } from './comfyui-dlss.js'
import { ffmpeg } from '../utils/ffmpeg.js'
import type { AIConfig } from './adapters/types'
import { DATA_ROOT } from '../utils/paths.js'

export const VOSR2_BUNDLE = 'VOSR2'                       // models/vosr2/<bundle>，args.json 锁架构
export const VOSR2_DTYPES = ['default', 'fp16', 'bf16']   // VAE 永远 fp32（README 原话）
export const VOSR2_COLOR_METHODS = ['wavelet', 'adain', 'none']

// 48 帧/块 = 2.1 GB 预放大批 + ≈4 GB 权重 ≈ 6.1 GB，是 8 GB 卡上唯一不换页的档（见上面注释的算法）
const DEFAULT_CHUNK_FRAMES = 48
const DEFAULT_TILE_SIZE = 512      // 训练原生上限，超过必须分块（作者确认）
const DEFAULT_VAE_TILE_SIZE = 1024 // >1024 输出全图 VAE 解码 4.9 GB ⇒ 8 GB 上必须开
// 1008 改回包的默认 32：我原先加到 64 是「保险」，代价是 tile 面积多付 ~25%（stride 448 vs 480），
// 而实测显示真正的钱在「模型换载 59 次」上，不在 blend 宽度上。要更稳的分块融合再调回去。
const DEFAULT_TILE_OVERLAP = 32

/** 组 VOSR2 修复图（API 格式）。按帧切块是因为整批预放大会直接上 GPU。拆成纯函数是为了能被测试断言形状。 */
export function buildVosrGraph(
  inputFileName: string,
  prefix: string,
  frames: number,
  opts: {
    upscale?: number; chunkFrames?: number; seed?: number; dtype?: string;
    colorAlignment?: string; tileSize?: number; tileOverlap?: number;
    vaeTileSize?: number; vaeTileOverlap?: number;
  } = {},
) {
  const upscale = Number(opts.upscale ?? 2)
  if (!Number.isInteger(upscale) || upscale < 1) throw new Error(`upscale 必须是 ≥1 的整数（nodes_vosr.py 是 Int），got ${upscale}`)
  const chunkFrames = Math.max(1, Number(opts.chunkFrames ?? DEFAULT_CHUNK_FRAMES))
  const dtype = String(opts.dtype || 'bf16')
  if (!VOSR2_DTYPES.includes(dtype)) throw new Error(`dtype 只能是 ${VOSR2_DTYPES.join('/')}，got ${dtype}`)
  const colorAlignment = String(opts.colorAlignment || 'wavelet')
  if (!VOSR2_COLOR_METHODS.includes(colorAlignment)) {
    throw new Error(`color_alignment 只能是 ${VOSR2_COLOR_METHODS.join('/')}，got ${colorAlignment}`)
  }
  const tileSize = Number(opts.tileSize ?? DEFAULT_TILE_SIZE)
  const tileOverlap = Number(opts.tileOverlap ?? DEFAULT_TILE_OVERLAP)
  const vaeTileSize = Number(opts.vaeTileSize ?? DEFAULT_VAE_TILE_SIZE)
  const vaeTileOverlap = Number(opts.vaeTileOverlap ?? 32)
  if (tileSize > 0 && tileOverlap >= tileSize) throw new Error(`tile_overlap(${tileOverlap}) 必须 < tile_size(${tileSize})`)
  if (vaeTileSize > 0 && vaeTileOverlap >= vaeTileSize) throw new Error(`vae_tile_overlap(${vaeTileOverlap}) 必须 < vae_tile_size(${vaeTileSize})`)
  if (!(frames > 0)) throw new Error(`frames 必须 >0（切块要靠它），got ${frames}`)

  const graph: Record<string, { class_type: string; inputs: Record<string, any> }> = {
    '1': { class_type: 'LoadVideo', inputs: { file: inputFileName } },
    '2': { class_type: 'GetVideoComponents', inputs: { video: ['1', 0] } },
    '3': { class_type: 'VOSR2ModelLoader', inputs: { model: VOSR2_BUNDLE, dtype } },
  }
  const chunks = Math.ceil(frames / chunkFrames)
  const baseSeed = Number(opts.seed ?? 0)
  let lastJoin: [string, number] | null = null
  for (let i = 0; i < chunks; i++) {
    const sliceId = String(10 + i)
    const upId = String(20 + i)
    graph[sliceId] = {
      class_type: 'ImageFromBatch',
      inputs: { image: ['2', 0], batch_index: i * chunkFrames, length: Math.min(chunkFrames, frames - i * chunkFrames) },
    }
    graph[upId] = {
      class_type: 'VOSR2Upscale',
      inputs: {
        model: ['3', 0], image: [sliceId, 0], upscale, seed: baseSeed + i * chunkFrames,
        color_alignment: colorAlignment, tile_size: tileSize, tile_overlap: tileOverlap,
        vae_tile_size: vaeTileSize, vae_tile_overlap: vaeTileOverlap,
      },
    }
    if (i === 0) {
      lastJoin = [upId, 0]
    } else {
      const joinId = String(30 + i)
      graph[joinId] = { class_type: 'ImageBatch', inputs: { image1: lastJoin as [string, number], image2: [upId, 0] } }
      lastJoin = [joinId, 0]
    }
  }
  graph['cv'] = { class_type: 'CreateVideo', inputs: { images: lastJoin as [string, number], fps: ['2', 2], audio: ['2', 1] } }
  graph['sv'] = {
    class_type: 'SaveVideo',
    inputs: { video: ['cv', 0], filename_prefix: prefix, format: 'auto', 'format.codec': 'auto' },
  }
  return graph
}

/** 数出待修复视频有多少帧（切块要靠这个）。nb_frames 优先，拿不到就用 duration×fps。 */
export async function probeFrameCount(absPath: string): Promise<number> {
  const info: any = await new Promise((resolve, reject) => {
    ffmpeg.ffprobe(absPath, (err: any, data: any) => (err ? reject(err) : resolve(data)))
  })
  const v = (info?.streams || []).find((s: any) => s.codec_type === 'video')
  if (!v) throw new Error(`ffprobe 找不到视频流: ${absPath}`)
  const nb = Number(v.nb_frames)
  if (nb > 0) return nb
  const [num, den] = String(v.r_frame_rate || '24/1').split('/').map(Number)
  const fps = den > 0 ? num / den : 24
  const dur = Number(info?.format?.duration) || 0
  const frames = Math.round(dur * fps)
  if (!(frames > 0)) throw new Error(`探不到帧数: ${absPath}`)
  return frames
}

/**
 * 把一条已落库的视频（relPath 形如 `static/merged/xxx.mp4`）用 VOSR2 修复后**原地替换**。
 * 只在成功时覆盖，失败保留原片。耗时口径 = history 的 `execution_start → execution_success`
 * （脚本那个数含排队 —— memory trigger-everything-via-platform-api / comfyui-graph-gotchas）。
 */
// 超时的兜底判据：这张图里只有一个 SaveVideo、挂在整条链的末尾 ⇒ 文件出现 = 整条跑完了。
// 前缀是 `vosr_upscale_<交付件名>`（上面 buildVosrGraph 那行），所以扫 ComfyUI 的 output 根目录就够。
function findRescueOutput(root: string, prefix: string, sinceMs: number): { filename: string; subfolder: string; type: string } | null {
  const dir = path.join(root, 'output')
  try {
    for (const name of fs.readdirSync(dir)) {
      if (!name.startsWith(prefix) || !/\.mp4$/i.test(name)) continue
      const st = fs.statSync(path.join(dir, name))
      if (st.mtimeMs >= sinceMs && st.size > 10_000) return { filename: name, subfolder: '', type: 'output' }
    }
  } catch { /* output 目录拿不到 = 没有兜底，照原样抛 */ }
  return null
}

export async function upscaleVideoViaVOSR(
  relPath: string,
  config: AIConfig,
  opts: { upscale?: number; chunkFrames?: number; timeoutMs?: number } = {},
): Promise<{ outFilename: string; elapsedSeconds: number; frames: number; chunks: number }> {
  const upscale = Number(opts.upscale || process.env.VOSR2_UPSCALE_FACTOR || 2)
  const chunkFrames = Math.max(1, Number(process.env.VOSR2_FRAMES_PER_CHUNK || DEFAULT_CHUNK_FRAMES))
  const bytes = await readReferenceBytes(relPath)
  if (!bytes || !bytes.length) throw new Error(`读不到待修复的视频: ${relPath}`)

  const inputDir = toInputDir(config)
  const stem = path.basename(relPath).replace(/\.mp4$/i, '')
  const fname = `huobao_vosr_${stem}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.mp4`
  fs.mkdirSync(inputDir, { recursive: true })
  const inputAbs = path.join(inputDir, fname)
  fs.writeFileSync(inputAbs, bytes)

  const frames = await probeFrameCount(inputAbs)
  const base = baseOf((config as any).baseUrl || '')
  // seed 每次换：同 seed 会命中 ComfyUI 的缓存，量出来的就不是真耗时
  const graph = buildVosrGraph(fname, `vosr_upscale_${stem}`, frames, {
    upscale, chunkFrames, seed: Math.floor(Math.random() * 1e15),
  })
  const submit = await postJson(`${base}/prompt`, { prompt: graph })
  const promptId = submit.prompt_id
  const submitAt = Date.now()
  if (!promptId) throw new Error(`VOSR2 提交失败: ${JSON.stringify(submit).slice(0, 300)}`)

  const deadline = Date.now() + (opts.timeoutMs || 21600_000)   // 6 h。旧的 2 h 是拍脑袋：×2 到 2K 在这台 4060 上实测 44.0 s/帧（未调参、history 口径，merge 21 = 162.9 min / 222 帧）⇒ 362 帧 = 4.4 h
  let entry: any = null
  let missingRounds = 0
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 5000))
    const h = await getJson(`${base}/history/${promptId}`)
    entry = h?.[promptId] || null
    const st = entry?.status?.status_str
    if (st === 'success' || st === 'error') break
    // 被 /interrupt 打断的作业在这版 ComfyUI 里**根本不写 history**（1008 实测：6006 日志
    // `Cancelling running prompt db400df9… ×8` + `Processing interrupted` + `Prompt executed in 588.64 s`，
    // 而 `/history` 始终只有 2 条）⇒ 光盯 history 会一直空转到超时（merge 15 就是这么卡住的）。
    // 判据：既不在 history、也不在 `/queue` 的 running/pending（键名是这两个，读错永远得 0 ——
    // memory comfyui-launch-args 那条），连续 3 轮（15 s）就认「作业已经没了」，早退。
    if (!entry) {
      const q = await getJson(`${base}/queue`)
      const all = [...(q?.queue_running || []), ...(q?.queue_pending || [])]
      const alive = all.some((item: any) => item?.[1] === promptId)
      missingRounds = alive ? 0 : missingRounds + 1
      if (missingRounds >= 3) throw new Error(`VOSR2 作业被中断或不在队列里（prompt ${String(promptId).slice(0, 8)}，history 与 /queue 都查不到）`)
    } else {
      missingRounds = 0
    }
  }
  const status = entry?.status?.status_str
  const root = path.dirname(inputDir)                       // …\ComfyUI\input → …\ComfyUI
  // 超时 ≠ 失败。旧的 2 h 上限到点就抛，而抛错被 merge 那侧的 catch 吞掉（「修复失败只记日志、不抛」），
  // 于是**未超分的 concat 被当成交付件、status completed、error_msg null**，真正的 2K 产物留在 ComfyUI 的
  // output 里没人拷回（merge 21 的整条时间戳链在台账 §二十四·⑧）。兜底先问 `/queue`：还在跑 = 真没完，
  // 不能拿写到一半的文件当交付件；已经不在跑了（含被中断又不写 history 那种）才认盘上的产物。
  let rescue: { filename: string; subfolder: string; type: string } | null = null
  if (status !== 'success') {
    const q = await getJson(`${base}/queue`).catch(() => ({}))
    const alive = [...(q?.queue_running || []), ...(q?.queue_pending || [])]
      .some((item: any) => item?.[1] === promptId)
    rescue = alive ? null : findRescueOutput(root, `vosr_upscale_${stem}`, submitAt)
    if (!rescue) {
      const msgs = (entry?.status?.status_details?.messages || []).map((m: any) => JSON.stringify(m)).join(' | ')
      throw new Error(`VOSR2 修复未成功（status=${status || 'timeout'}）${msgs.slice(0, 300)}`)
    }
  }
  const saved = (entry?.outputs?.['sv']?.videos || entry?.outputs?.['sv']?.images || [])[0] || rescue
  if (!saved?.filename) throw new Error('VOSR2 修复成功但 history 里没有产物')
  const outAbs = path.join(root, String(saved.type || 'output').toLowerCase(), saved.subfolder || '', saved.filename)
  if (!fs.existsSync(outAbs)) throw new Error(`VOSR2 产物不在盘上: ${outAbs}`)
  const targetAbs = path.join(DATA_ROOT, relPath.replace(/^\/+/, ''))
  fs.copyFileSync(outAbs, targetAbs)                        // 成功才覆盖，原成片在此之前不动
  const elapsed = Math.max(0, (Number(entry?.execution_success) - Number(entry?.execution_start)) / 1000)
    || Math.max(0, Math.round((Date.now() - submitAt) / 1000))   // 兜底路径没有 history ⇒ 用墙钟
  return { outFilename: saved.filename, elapsedSeconds: elapsed, frames, chunks: Math.ceil(frames / chunkFrames) }
}
