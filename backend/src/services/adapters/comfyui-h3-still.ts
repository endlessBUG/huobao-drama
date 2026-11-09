// 本机 ComfyUI · MiniMax-H3 **fl2va NVFP4 首帧图** —— 原生 API Adapter（绕开 OpenAI-Bridge）。
//
// 1018 用户定案：「需要首帧图的时候用 fl2va 的 NVFP 版本」。首帧的常态来源是**上一条成片的精确末帧**
// （驱动 `data/generated/.ep7_remake.mjs` 里 `prevFrame`），这个 adapter 只负责「没有上一条可接、
// 又必须凭空出一张首帧」的那一格 —— 比如整集第一个镜头、或用户手动点「生成首帧图」。
//
// 为什么是 fl2va 而不是 ref2va / qwen：fl2va 就是官方图生视频（keyframe）那条权重，
// 社区同款做法（astropuzzo/ComfyUI-MiniMax-H3-Image-Studio）也是拿 FL2VA 采一张 latent 帧解码成静帧。
// 这里用核心 `MiniMaxH3ImageToVideo`（不挂 first/last keyframe）走 5 帧（模型最短长度，17k+5 网格），
// VAEDecode 后 `ImageFromBatch` 只留第 0 帧。20 步单采、无 turbo LoRA —— 与 1016/1017 视频定案同口径。
//
// 不接参考图：`MiniMaxH3ImageToVideo` 没有 reference 通道（`nodes_minimax_h3.py:125-134` 只有
// first_frame/last_frame 两个可选 image 输入）。身份连续性靠链式首帧，不靠这个 adapter。
//
// 模板（h3-still-workflow.json）：改完用 ComfyUI 的 Export (API) 覆盖。
// 端点同 qwen-image.ts：POST /prompt -> prompt_id；GET /history/{id}；GET /view?...
import type {
  ImageProviderAdapter,
  ProviderRequest,
  AIConfig,
  ImageGenerationRecord,
  ImageGenResponse,
  ImagePollResponse,
} from './types'
import { baseOf } from './comfyui-common'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const TEMPLATE_PATH = path.join(__dirname, 'h3-still-workflow.json')
const CLIENT_ID = 'huobao-h3-still'

// 与视频画布同档：首帧会被 `MiniMaxH3AddGuide` 按 1024×768 硬锚，出别的尺寸只是多一次缩放。
const DEFAULT_WIDTH = 1024
const DEFAULT_HEIGHT = 768
const MIN_SIDE = 256
const SAVE_PREFIX = 'huobao_h3still'

function loadTemplate(): Record<string, any> {
  let txt: string
  try {
    txt = fs.readFileSync(TEMPLATE_PATH, 'utf8')
  } catch {
    throw new Error(`找不到 H3 首帧工作流模板: ${TEMPLATE_PATH}`)
  }
  return JSON.parse(txt)
}

function requireNode(graph: Record<string, any>, classType: string): any {
  for (const n of Object.values(graph)) {
    if (n && n.class_type === classType) return n
  }
  throw new Error(`h3-still-workflow.json 缺 ${classType} 节点——请用 ComfyUI 的 Export (API) 重新导出覆盖`)
}

/** 入参 WxH；非法/过小回落到 1024×768，边长对齐 32（`MiniMaxH3ImageToVideo` 的 step） */
function fitSize(size?: string | null): { width: number; height: number } {
  const m = /^(\d+)\s*x\s*(\d+)$/.exec((size || '').trim())
  if (!m) return { width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT }
  const w = Number(m[1])
  const h = Number(m[2])
  if (w < MIN_SIDE || h < MIN_SIDE) return { width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT }
  return { width: Math.round(w / 32) * 32, height: Math.round(h / 32) * 32 }
}

function buildViewUrl(base: string, img: { filename: string; subfolder?: string; type?: string }): string {
  const params = new URLSearchParams({
    filename: img.filename,
    subfolder: img.subfolder ?? '',
    type: img.type || 'output',
  })
  return `${base}/view?${params.toString()}`
}

function pickImageUrl(base: string, outputs: any): string | null {
  for (const out of Object.values(outputs ?? {}) as any[]) {
    for (const img of (out?.images ?? []) as any[]) {
      if (img?.type === 'output' || img?.type === 'image') return buildViewUrl(base, img)
    }
  }
  return null
}

export class H3StillImageAdapter implements ImageProviderAdapter {
  provider = 'h3-still'
  private base?: string

  buildGenerateRequest(config: AIConfig, record: ImageGenerationRecord): ProviderRequest {
    const base = baseOf(config.baseUrl)
    this.base = base
    const graph = loadTemplate()

    requireNode(graph, 'MiniMaxH3ImageToVideo').inputs.prompt = record.prompt || ''
    const { width, height } = fitSize(record.size)
    const i2v = requireNode(graph, 'MiniMaxH3ImageToVideo')
    i2v.inputs.width = width
    i2v.inputs.height = height
    // ponytail: seed 随机，同 qwen adapter —— 「重新生成」不该永远吐同一张
    requireNode(graph, 'RandomNoise').inputs.noise_seed = Math.floor(Math.random() * 2 ** 31)
    requireNode(graph, 'SaveImage').inputs.filename_prefix = SAVE_PREFIX

    return {
      method: 'POST',
      url: `${base}/prompt`,
      headers: { 'Content-Type': 'application/json' },
      body: { prompt: graph, client_id: CLIENT_ID },
    }
  }

  parseGenerateResponse(result: any): ImageGenResponse {
    if (result.prompt_id) return { isAsync: true, taskId: String(result.prompt_id) }
    throw new Error('ComfyUI /prompt 响应异常：缺少 prompt_id')
  }

  buildPollRequest(config: AIConfig, taskId: string): ProviderRequest {
    return {
      method: 'GET',
      url: `${baseOf(config.baseUrl)}/history/${taskId}`,
      headers: {},
      body: undefined,
    }
  }

  parsePollResponse(result: any): ImagePollResponse {
    const entry = (Object.values(result ?? {}) as any[])[0]
    if (!entry) return { status: 'processing' }
    const status = entry.status ?? {}
    if (status.status_str === 'error' || status.messages?.find((m: any) => m[0] === 'execution_error')) {
      return { status: 'failed', error: status.error || 'execution_error' }
    }
    if (status.completed || status.done) {
      const url = pickImageUrl(this.base || '', entry.outputs ?? {})
      return { status: 'completed', imageUrl: url ?? undefined }
    }
    return { status: 'processing' }
  }

  extractImageUrl(result: any): string | null {
    const entry = (Object.values(result ?? {}) as any[])[0]
    return pickImageUrl(this.base || '', entry?.outputs ?? {})
  }

  extractImageBase64(): { data: string; mimeType: string } | null {
    return null
  }
}
