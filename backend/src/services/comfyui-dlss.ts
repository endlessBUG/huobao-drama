// NVIDIA DLSS 补帧（`NvidiaDLSSFrameInterpolation`）—— 直接打 6006 的 `/prompt` API，
// 因为桥（ComfyUI-OpenAI-Bridge）没有补帧端点，只有 /v1/videos/generations 那条生成链。
//
// 1007 22:19 本机实测（2 s / 48 帧 / 1920×1072 片段，从 task 277 产物切的）：
//   ✅ 补帧 success：48 帧 24 fps → 120 帧 60/1、时长 2.000 s 不变、encoder h264_nvenc、elapsed 30.946 s
//      capabilities {"available":true,"gpu":"RTX 4060","driver":"617.14","hags_enabled":false,"cascade_available":true}
//      plan {"path":"Cascade","grid_multiplier":8,"cascade_stages":3}  ← 24→60 = 2.5×，不是 2 的幂，所以走 cascade
//   ❌ 超分 error：`The carrier render completed, but signed DLSSNR feature-18 execution was not verified.`
//      ⇒ 这台 4060 8 GB + HAGS 关上只有补帧能用，所以本文件只接补帧。
//
// 三条形状约束（都是这次踩出来的，别再踩）：
//   1. `/prompt` 要 {"class_type":…, "inputs":{…}}，不是 UI 的 widgets_values
//      （comfy_execution/graph.py:131 读 get_node(id)["inputs"]，错了报 Exception when validating node: 'inputs'）
//   2. 图里必须有 output 节点（SaveVideo 是 output_node=True），且它的动态组合 `format` 在 prompt API 里
//      要用点号键："format":"auto" + "format.codec":"auto"（见 memory comfyui-graph-gotchas 第 4 条）
//   3. 这个节点要求外部 ffprobe 支持 `stream_side_data` section —— 仓库自带的 ffprobe-static 是 4.0.2（2018）
//      会炸，所以 6006 必须用 DLSS_FFMPEG_PATH / DLSS_FFPROBE_PATH 指到新版（E:\AI\ffmpeg-9.0.2-...，
//      已写进 E:\AI\ComfyUI\_restart_6006_dlss.ps1 和 start_clean.ps1）
import fs from 'node:fs'
import path from 'node:path'
import { baseOf, readReferenceBytes, toInputDir } from './adapters/comfyui-common.js'
import type { AIConfig } from './adapters/types'
import { DATA_ROOT } from '../utils/paths.js'

// 实测 object_info 的 FPS_CHOICES —— 注意没有 48（24 fps 的料只能补到 25/30/50/60/90/120）
export const DLSS_FPS_CHOICES = ['23.976', '25', '29.97', '30', '50', '59.94', '60', '90', '120']

/** 组补帧图（API 格式）。拆成纯函数是为了能被测试断言形状 —— 提交前自检防不住这些坑。 */
export function buildInterpolateGraph(inputFileName: string, fps: string, prefix: string) {
  return {
    '1': { class_type: 'LoadVideo', inputs: { file: inputFileName } },
    '2': {
      class_type: 'NvidiaDLSSFrameInterpolation',
      inputs: {
        video: ['1', 0], output_fps: fps, dlss_engine: 'Auto', encoding_quality: 'Good',
        video_codec: 'H.264 (NVIDIA NVENC)', container: 'MP4', rename: 'Auto',
        custom_suffix: '_DLSSFG', hdr_mode: false,
      },
    },
    '3': { class_type: 'SaveVideo', inputs: { video: ['2', 0], filename_prefix: prefix, format: 'auto', 'format.codec': 'auto' } },
  }
}

/**
 * 把一条已落库的视频（relPath 形如 `static/merged/xxx.mp4`）补帧后**原地替换**。
 * 只在成功时覆盖，失败保留原 24 fps 文件。返回 'ok' 或抛错（调用方决定是记警告还是失败）。
 */
export async function interpolateVideoViaDLSS(
  relPath: string,
  config: AIConfig,
  opts: { fps?: string; timeoutMs?: number } = {},
): Promise<{ framesOut: number; elapsedSeconds: number }> {
  const fps = String(opts.fps || '60').trim()
  if (!DLSS_FPS_CHOICES.includes(fps)) {
    throw new Error(`DLSS 不支持 target_fps=${fps}（可选：${DLSS_FPS_CHOICES.join('/')}；注意没有 48）`)
  }
  const bytes = await readReferenceBytes(relPath)
  if (!bytes || !bytes.length) throw new Error(`读不到待补帧的视频: ${relPath}`)

  const inputDir = toInputDir(config)
  const stem = path.basename(relPath).replace(/\.mp4$/i, '')
  const fname = `huobao_interpolate_${stem}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.mp4`
  fs.mkdirSync(inputDir, { recursive: true })
  fs.writeFileSync(path.join(inputDir, fname), bytes)

  const base = baseOf((config as any).baseUrl || '')
  const graph = buildInterpolateGraph(fname, fps, `dlss_interpolate_${stem}`)
  const submit = await postJson(`${base}/prompt`, { prompt: graph })
  const promptId = submit.prompt_id
  if (!promptId) throw new Error(`DLSS 提交失败: ${JSON.stringify(submit).slice(0, 300)}`)

  const deadline = Date.now() + (opts.timeoutMs || 3600_000)   // 整集成片 ~24.5 min，默认给 60 min
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
    throw new Error(`DLSS 补帧未成功（status=${status || 'timeout'}）${msgs.slice(0, 300)}`)
  }
  // 取 SaveVideo（node 3）的产物；type=output 时落在 ComfyUI 的 output/，temp 会被清所以不用它。
  const saved = (entry.outputs?.['3']?.videos || entry.outputs?.['3']?.images || [])[0]
  if (!saved?.filename) throw new Error('DLSS 补帧成功但 history 里没有产物')
  const root = path.dirname(inputDir)                       // …\ComfyUI\input → …\ComfyUI
  const outAbs = path.join(root, String(saved.type || 'output').toLowerCase(), saved.subfolder || '', saved.filename)
  if (!fs.existsSync(outAbs)) throw new Error(`DLSS 产物不在盘上: ${outAbs}`)
  const targetAbs = path.join(DATA_ROOT, relPath.replace(/^\/+/, ''))
  fs.copyFileSync(outAbs, targetAbs)                        // 成功才覆盖，原 24 fps 文件在此之前不动
  const report = (entry.outputs?.['2']?.reports?.[0]) || ''
  const framesOut = Number(String(report).match(/"output_frames"\s*:\s*(\d+)/)?.[1]) || 0
  const elapsed = Number(String(report).match(/"elapsed_seconds"\s*:\s*([\d.]+)/)?.[1]) || 0
  return { framesOut, elapsedSeconds: elapsed }
}

export async function postJson(url: string, body: any): Promise<any> {
  const resp = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const text = await resp.text().catch(() => '')
  if (!resp.ok) throw new Error(`${url} -> ${resp.status} ${text.slice(0, 300)}`)
  try { return JSON.parse(text) } catch { return {} }
}
export async function getJson(url: string): Promise<any> {
  try {
    const resp = await fetch(url)
    return resp.ok ? JSON.parse(await resp.text()) : null
  } catch { return null }
}
