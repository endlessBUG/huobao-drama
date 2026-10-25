// 小脸修复二采（1024 用户「先做minimax小脸修复…加到平台流程 然后用GPU」）：
// 基片生成完，把它当输入喂 ComfyUI-H3-FaceRefine 图（逐帧脸检测→768² 画布→H3 img2img 重采→贴回），
// 出更清楚的片子替换基片。图走 6006 /prompt（ComfyUI 原生图，不是桥的 /v1 端点 —— 这条是桥外旋钮，
// 由平台任务生命周期触发，不是手搓）。模型用 int8_convrot+turbo_8step+GPU TE（探针验过的档）。
// 代价：二采要在基片之后、同进程再跑一遍 H3（模型与 PDD 基片不同 ⇒ 会换载、付加载税），慢但正确。
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { STORAGE_ROOT } from '../../utils/paths.js'
import { baseOf } from './comfyui-common'
import type { AIConfig } from './types'

const nodeRequire = createRequire(import.meta.url)

export interface RefineInput {
  config: AIConfig
  videoLocalPath: string // 'static/videos/xxx.mp4'（基片，已落盘）
  prompt: string
  length: number // 基片实际帧数（17k+5 网格），必须与 node1 载入的帧数一致
  seed?: number | null
}

/** 跑一发小脸修复，返回修复后成片的相对路径（static/videos/…）；失败返回 null（调用方保留基片）。 */
export async function refineVideoFace(inp: RefineInput): Promise<string | null> {
  const base = baseOf(inp.config.baseUrl) // http://127.0.0.1:6006
  const graph = nodeRequire('./h3-facerefine-workflow.json') as Record<string, { class_type: string; inputs: Record<string, any> }>
  // 基片相对路径 → 绝对（ComfyUI VHS_LoadVideoPath 吃绝对路径；探针实测可读本仓库 static/）
  const absVideo = path.join(STORAGE_ROOT, inp.videoLocalPath.replace(/^static\//, ''))
  graph['1'].inputs.video = absVideo
  graph['9'].inputs.prompt = inp.prompt
  graph['9'].inputs.length = inp.length
  graph['17'].inputs.noise_seed = Number.isFinite(inp.seed as number) ? (inp.seed as number) : Math.floor(Math.random() * 1e9)

  let promptId: string
  try {
    const r = await fetch(`${base}/prompt`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: graph, client_id: 'huobao_refine' }) })
    const j = await r.json()
    if (!j.prompt_id) { console.warn('[face-refine] submit rejected', JSON.stringify(j).slice(0, 300)); return null }
    promptId = j.prompt_id
  } catch (e) { console.warn('[face-refine] submit failed', (e as Error).message); return null }

  // 轮询 history：二采含模型换载，冷跑可达十几分钟；每 10s 一次、上限 40 分钟。
  const deadline = Date.now() + 40 * 60_000
  while (Date.now() < deadline) {
    await new Promise((s) => setTimeout(s, 10_000))
    let h: any
    try { h = await (await fetch(`${base}/history/${promptId}`)).json() } catch { continue }
    const e = h[promptId]
    if (!e) continue
    const st = (e.status?.status_str || '').toLowerCase()
    if (st === 'error') {
      const mm = (e.status?.messages || []).find((x: any) => x[0] === 'execution_error')
      console.warn('[face-refine] exec error', mm?.[1]?.node_id, mm?.[1]?.node_type, '::', mm?.[1]?.exception_message)
      return null
    }
    if (st === 'success') {
      const out = e.outputs?.['23']?.gifs?.[0] || e.outputs?.['23']?.videos?.[0]
      const full = out?.fullpath || (out?.filename ? path.join(process.env.COMFYUI_OUTPUT_DIR || '', out.subfolder || '', out.filename) : '')
      if (!full || !fs.existsSync(full)) { console.warn('[face-refine] output file not found', JSON.stringify(out)); return null }
      const target = `${randomUUID()}${path.extname(full) || '.mp4'}`
      const destDir = path.join(STORAGE_ROOT, 'videos')
      fs.mkdirSync(destDir, { recursive: true })
      fs.copyFileSync(full, path.join(destDir, target))
      return `static/videos/${target}`
    }
  }
  console.warn('[face-refine] timed out waiting for', promptId)
  return null
}
