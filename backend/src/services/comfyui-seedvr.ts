// ComfyUI **core 自带**的 SeedVR2 一步式视频修复（`comfy_extras/nodes_seedvr.py`，已在 `nodes.py:2487` 注册）
// —— 挂在交付端 merge 之后，把「低分直采 + 放大到交付尺寸」的片子修回应有的细节。零 pip、不碰冻结 torch。
//
// 为什么不是 DLSS NR（1007 23:30 结案，见 docs/comfyui-h3-configs.md §二十二）：
//   · 判据 `verify_feature_18`（`dlss_engine/core/runtime.py:682-684`）要的是 `ReShade.log` 里三条字面串，
//     而这台机上那个文件从未产生过（多路径多深度全搜，零）；`require_neural_upscaling=false` 重跑仍然 error。
//   · 更要命的是作者自己的口径：`custom_nodes/ComfyUI-NVIDIA-DLSS/README.md` L108-110 写他们测的 **RTX 5090**
//     那两条 upscale 报的是 `nr_native_fallback: true`、「Direct NR upscaling was not active」
//     ⇒ **换 Blackwell 也不保证**，所以这条不押 DLSS。
//
// 配方不是猜的，照本机官方 blueprint `E:/AI/ComfyUI/blueprints/Upscale Video (SeedVR2 3B Int8).json`
// 的内层 18 节点抄：`KSampler steps=1 / cfg=1 / euler / simple / denoise=1`，VAE 走
// `VAEEncodeTiled / VAEDecodeTiled (tile_size 512, overlap 128, temporal_size 64, temporal_overlap 8)`。
// blueprint 里的 `ResizeImageMaskNode` 在本机 `/object_info` 查无此类（这版 ComfyUI 没有）⇒ 放大由调用方
// 预先做完（merge 的 ffmpeg 已经把片子放到 1920×1080），本图只做 1× 修复。
//
// `chunking_mode` 必须 manual：`nodes_seedvr.py:484` 的 auto 公式是
//   budget = free_GiB − SEEDVR2_CHUNK_RESERVED_GIB(8.5) − 4×SEEDVR2_CHUNK_SIGMA_GIB(0.55) = 先扣 10.7 GiB
// 而标定注释（`comfy/ldm/seedvr/constants.py:3-7`）自己写明是「17-cell resolution sweep + T bisection,
// **RTX 5090**, 3b fp16」⇒ 8 GB 卡算出来是负数、`max(1,…)` 退化成 1 latent 帧/块（等于没有时间上下文）。
// `frames_per_chunk` 必须是 4n+1（`nodes_seedvr.py:493-497` 会抛 ValueError），这里提前拦并给可读错误。
import fs from 'node:fs'
import path from 'node:path'
import { baseOf, readReferenceBytes, toInputDir } from './adapters/comfyui-common.js'
import { getJson, postJson } from './comfyui-dlss.js'
import type { AIConfig } from './adapters/types'
import { DATA_ROOT } from '../utils/paths.js'

// HF `Comfy-Org/SeedVR2`（gated=False、downloads 546,259）：3b_fp8_e4m3fn = 3.39 GB、
// 3b_int8_convrot = 3.46 GB（blueprint 用的那个）、7b_fp8 = 8.24 GB、VAE = 0.50 GB。
// 选 fp8_e4m3fn 不选 GGUF：`numz/ComfyUI-SeedVR2_VideoUpscaler` issue #400 的用户在 **RTX 2060 6 GB、无 bf16**
// 上实测「the GGUF models had artifacts, and the fp16 version gave a black output」而 fp8_e4m3fn「results were very good」。
export const SEEDVR2_UNET = 'seedvr2_3b_fp8_e4m3fn.safetensors'
export const SEEDVR2_VAE = 'seedvr2_ema_vae_fp16.safetensors'
export const SEEDVR2_COLOR_METHODS = ['lab', 'wavelet', 'adain', 'none']   // 实读 object_info 的 options

/** 4n+1 判定（`nodes_seedvr.py:493` 的硬约束：1, 5, 9, 13, 17, 21, ...） */
export function isFourNPlusOne(n: number): boolean {
  return Number.isInteger(n) && n >= 1 && (n - 1) % 4 === 0
}

/** 组 SeedVR2 修复图（API 格式）。拆成纯函数是为了能被测试断言形状 —— 提交前自检防不住这些坑。 */
export function buildUpscaleGraph(
  inputFileName: string,
  prefix: string,
  opts: { framesPerChunk?: number; temporalOverlap?: number; seed?: number; colorMethod?: string } = {},
) {
  const framesPerChunk = Number(opts.framesPerChunk ?? 5)          // 5 像素帧 = 2 latent 帧；8 GB 上唯一稳的档
  if (!isFourNPlusOne(framesPerChunk)) {
    throw new Error(`frames_per_chunk 必须是 4n+1（1/5/9/13/17/21…，nodes_seedvr.py:493 会抛），got ${framesPerChunk}`)
  }
  const temporalOverlap = Number(opts.temporalOverlap ?? 1)
  const colorMethod = String(opts.colorMethod || 'lab')
  if (!SEEDVR2_COLOR_METHODS.includes(colorMethod)) {
    throw new Error(`color_correction_method 只能是 ${SEEDVR2_COLOR_METHODS.join('/')}，got ${colorMethod}`)
  }
  return {
    '1': { class_type: 'LoadVideo', inputs: { file: inputFileName } },
    '2': { class_type: 'GetVideoComponents', inputs: { video: ['1', 0] } },
    '3': { class_type: 'SeedVR2Preprocess', inputs: { resized_images: ['2', 0] } },
    '4': { class_type: 'VAELoader', inputs: { vae_name: SEEDVR2_VAE } },
    '5': { class_type: 'UNETLoader', inputs: { unet_name: SEEDVR2_UNET, weight_dtype: 'default' } },
    '6': {
      class_type: 'VAEEncodeTiled',
      inputs: { pixels: ['3', 0], vae: ['4', 0], tile_size: 512, overlap: 128, temporal_size: 64, temporal_overlap: 8 },
    },
    '7': {
      class_type: 'SeedVR2TemporalChunk',
      // chunking_mode 是 DynamicCombo ⇒ prompt API 里子键必须写成点号键（和 SaveVideo 的 format/format.codec
      // 同一族，memory comfyui-graph-gotchas 第 4 条）。写平铺的 frames_per_chunk 会被判
      // required_input_missing / chunking_mode.frames_per_chunk（本机 1007 23:58 实测 HTTP 400）。
      inputs: { latent: ['6', 0], temporal_overlap: temporalOverlap, chunking_mode: 'manual', 'chunking_mode.frames_per_chunk': framesPerChunk },
    },
    '8': { class_type: 'SeedVR2Conditioning', inputs: { model: ['5', 0], vae_conditioning: ['7', 0] } },
    '9': {
      class_type: 'KSampler',
      inputs: {
        model: ['5', 0], seed: Number(opts.seed ?? 0), steps: 1, cfg: 1.0,
        sampler_name: 'euler', scheduler: 'simple',
        positive: ['8', 0], negative: ['8', 1], latent_image: ['7', 0], denoise: 1.0,
      },
    },
    '10': { class_type: 'SeedVR2TemporalMerge', inputs: { latents: ['9', 0], temporal_overlap: ['7', 1] } },
    '11': {
      class_type: 'VAEDecodeTiled',
      inputs: { samples: ['10', 0], vae: ['4', 0], tile_size: 512, overlap: 128, temporal_size: 64, temporal_overlap: 8 },
    },
    '12': {
      class_type: 'SeedVR2PostProcessing',
      // 参照 = 放大后、Preprocess pad 前 的那一份（blueprint 里接的是 ResizeImageMaskNode 的输出，
      // 不是 Preprocess 的输出）⇒ 这里用 GetVideoComponents 的 IMAGE 流（node 2 slot 0）。
      inputs: { images: ['11', 0], original_resized_images: ['2', 0], color_correction_method: colorMethod },
    },
    '13': { class_type: 'CreateVideo', inputs: { images: ['12', 0], fps: ['2', 2], audio: ['2', 1] } },
    '14': { class_type: 'SaveVideo', inputs: { video: ['13', 0], filename_prefix: prefix, format: 'auto', 'format.codec': 'auto' } },
  }
}

/**
 * 把一条已落库的视频（relPath 形如 `static/merged/xxx.mp4`）用 SeedVR2 修复后**原地替换**。
 * 只在成功时覆盖，失败保留原片。耗时口径 = history 的 `execution_start → execution_success`
 * （脚本那个数含排队，不能用 —— memory comfyui-graph-gotchas / trigger-everything-via-platform-api）。
 */
export async function upscaleVideoViaSeedVR(
  relPath: string,
  config: AIConfig,
  opts: { framesPerChunk?: number; timeoutMs?: number } = {},
): Promise<{ outFilename: string; elapsedSeconds: number }> {
  const framesPerChunk = Number(opts.framesPerChunk || process.env.SEEDVR2_FRAMES_PER_CHUNK || 5)
  const bytes = await readReferenceBytes(relPath)
  if (!bytes || !bytes.length) throw new Error(`读不到待修复的视频: ${relPath}`)

  const inputDir = toInputDir(config)
  const stem = path.basename(relPath).replace(/\.mp4$/i, '')
  const fname = `huobao_seedvr_${stem}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.mp4`
  fs.mkdirSync(inputDir, { recursive: true })
  fs.writeFileSync(path.join(inputDir, fname), bytes)

  const base = baseOf((config as any).baseUrl || '')
  // seed 每次换：同 seed 会命中 ComfyUI 的缓存，量出来的就不是真耗时
  const graph = buildUpscaleGraph(fname, `seedvr_upscale_${stem}`, {
    framesPerChunk, seed: Math.floor(Math.random() * 1e15),
  })
  const submit = await postJson(`${base}/prompt`, { prompt: graph })
  const promptId = submit.prompt_id
  if (!promptId) throw new Error(`SeedVR2 提交失败: ${JSON.stringify(submit).slice(0, 300)}`)

  const deadline = Date.now() + (opts.timeoutMs || 7200_000)   // 整集 ~1900 帧，默认给 2 h
  let entry: any = null
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 5000))
    const h = await getJson(`${base}/history/${promptId}`)
    entry = h?.[promptId] || null
    const st = entry?.status?.status_str
    if (st === 'success' || st === 'error') break
  }
  const status = entry?.status?.status_str
  if (status !== 'success') {
    const msgs = (entry?.status?.status_details?.messages || []).map((m: any) => JSON.stringify(m)).join(' | ')
    throw new Error(`SeedVR2 修复未成功（status=${status || 'timeout'}）${msgs.slice(0, 300)}`)
  }
  const saved = (entry.outputs?.['14']?.videos || entry.outputs?.['14']?.images || [])[0]
  if (!saved?.filename) throw new Error('SeedVR2 修复成功但 history 里没有产物')
  const root = path.dirname(inputDir)                       // …\ComfyUI\input → …\ComfyUI
  const outAbs = path.join(root, String(saved.type || 'output').toLowerCase(), saved.subfolder || '', saved.filename)
  if (!fs.existsSync(outAbs)) throw new Error(`SeedVR2 产物不在盘上: ${outAbs}`)
  const targetAbs = path.join(DATA_ROOT, relPath.replace(/^\/+/, ''))
  fs.copyFileSync(outAbs, targetAbs)                        // 成功才覆盖，原成片在此之前不动
  const elapsed = Math.max(0, (Number(entry.execution_success) - Number(entry.execution_start)) / 1000)
  return { outFilename: saved.filename, elapsedSeconds: elapsed }
}
