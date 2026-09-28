// 本机 ComfyUI · Qwen-Image-2.1 角色三视图 —— **参考图驱动**，原生 API Adapter（绕开 OpenAI-Bridge）。
//
// 为什么不走桥：桥给 Krea-2 的两条参考图路都做不了身份迁移（桥把参考图当画面内容画出来，
// 见 comfyui-image.ts 头注释）。Qwen-Image-2.1 的 TextEncodeQwenImage21 有真正的
// reference latents 通道（参考图 → VAE → 追加进 positive/negative conditioning），
// 身份与服装都跟着参考图走。2026-09-27 实测：把文字描述全清空、只留"照参考图"和构图指令，
// 出图仍是参考图那个人、那套衣服；反过来文字与参考图冲突时，出图**跟着文字走**
// （写"米色家居服"就出家居服）——带参考图时提示词别跟图打架。
// 参考图是可选的：不带图就退化成本模型的纯文生图（场景/道具用），两条路同一个 provider。
//
// ⚠️ 参考图键必须写成 `images.image_1`（ComfyUI 0.37 的 Autogrow 子输入 finalized id）：
//   写成 {"images":{"image_1":[...]}} 会被服务端**静默丢弃** —— 无报错、prompt 正常 success，
//   但出图退化成纯文生图（就是"参考图怎么都不生效"的根因）；写成裸 image_1 则报
//   TypeError: execute() got an unexpected keyword argument 'image_1'。
//   模板 qwen-workflow.json 里已按正确形式写死，改模板时别动这一行。
//
// 采样走 **6 步 turbo 蒸馏**：底座换成 `qwen_image_2.1_turbo_Q4_K_M.gguf`
//   （Viggle v0.2.1 六步蒸馏的 GGUF 量化），不用 KSampler —— 蒸馏光有步数不够，
//   必须配作者指定的 sigma 日程，所以改用 SamplerCustomAdvanced 链：
//   RandomNoise → BasicGuider(无 CFG) + KSamplerSelect(euler) + ManualSigmas。
//   别把 ManualSigmas 换成 KSampler 的 steps=6 / simple：**不等价**，出图会发灰发软。
//
// 模板（qwen-workflow.json）：POST /prompt 的 prompt 格式，节点按 class_type 找，
//   runtime 只注入「每次生成都变」的四样：LoadImage.image（参考图文件名）/ prompt /
//   尺寸 / RandomNoise.noise_seed。模型文件名、采样参数都在模板里改。
//   要在 ComfyUI 前端改这张图：改完用 **Export (API)** 导出（不是 Save —— Save 是
//   nodes 数组格式，本 adapter 不吃），覆盖 qwen-workflow.json 即可。
//
// 端点（ComfyUI 0.37 server.py 实测）：
//   POST {base}/prompt {"prompt":{...},"client_id":".."} -> {"prompt_id":".."}
//   GET  {base}/history/{id} ；GET {base}/view?filename=&subfolder=&type=
import type {
  ImageProviderAdapter,
  ProviderRequest,
  AIConfig,
  ImageGenerationRecord,
  ImageGenResponse,
  ImagePollResponse,
} from './types'
import { toInputDir, stageReferenceImages, baseOf } from './comfyui-common'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const TEMPLATE_PATH = path.join(__dirname, 'qwen-workflow.json')
const CLIENT_ID = 'huobao-qwen'

// 出图档位：1344x768 / 6 步 turbo / 无 CFG / euler + 作者 sigma 表。
// 角色流恒传 1920x1080（2.07MP），超预算就等比缩到这个档（1.03MP）——前端按「宽图」
// 对半切三视图，比例不变照样拆格；不缩就是 2 倍像素，实测显存与耗时都吃不消。
const DEFAULT_WIDTH = 1344
const DEFAULT_HEIGHT = 768
const MAX_PIXELS = DEFAULT_WIDTH * DEFAULT_HEIGHT
const MIN_SIDE = 256
const SAVE_PREFIX = 'huobao_qwen_sheet'

function loadTemplate(): Record<string, any> {
  let txt: string
  try {
    txt = fs.readFileSync(TEMPLATE_PATH, 'utf8')
  } catch {
    throw new Error(`找不到 Qwen 三视图工作流模板: ${TEMPLATE_PATH}`)
  }
  // 每次调用都要一份独立副本：注入会改 inputs，共享对象会把上次的注入带进下次
  return JSON.parse(txt)
}

function requireNode(graph: Record<string, any>, classType: string): any {
  for (const n of Object.values(graph)) {
    if (n && n.class_type === classType) return n
  }
  throw new Error(`qwen-workflow.json 缺 ${classType} 节点——请用 ComfyUI 的 Export (API) 重新导出覆盖`)
}

/** 入参 WxH 超预算就等比缩到 MAX_PIXELS；非法/过小回落到默认档。边长对齐 16。 */
function fitSize(size?: string | null): { width: number; height: number } {
  const DEFAULT = { width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT }
  const m = /^(\d+)\s*x\s*(\d+)$/.exec((size || '').trim())
  if (!m) return DEFAULT
  const w = Number(m[1])
  const h = Number(m[2])
  if (w < MIN_SIDE || h < MIN_SIDE) return DEFAULT
  if (w * h <= MAX_PIXELS) return { width: w, height: h }
  // 三视图构图是技能钉死的，角色流恒传的 1920x1080 和默认档只差 1.6% 的宽高比零头——
  // 没必要为这点零头另开一档，直接落回与脚本一致的 1344x768。
  if (Math.abs(w / h - DEFAULT_WIDTH / DEFAULT_HEIGHT) < 0.05) return DEFAULT
  const k = Math.sqrt(MAX_PIXELS / (w * h))
  return {
    width: Math.max(MIN_SIDE, Math.round((w * k) / 16) * 16),
    height: Math.max(MIN_SIDE, Math.round((h * k) / 16) * 16),
  }
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

export class QwenImageAdapter implements ImageProviderAdapter {
  provider = 'qwen'
  private base?: string

  async buildGenerateRequest(config: AIConfig, record: ImageGenerationRecord): Promise<ProviderRequest> {
    const base = baseOf(config.baseUrl)
    this.base = base
    const graph = loadTemplate()

    // 参考图：DB 里的 static/... 或 data URL（generation.ts 已统一压成 ≤768px data URL）
    // → 落到 ComfyUI input/，模板里的 LoadImage 只认文件名。
    // 带图 = 参考图模式（角色三视图）；不带图 = 纯文生图（场景/道具）。两条路都走这里。
    const refs = await stageReferenceImages(
      record.referenceImages ? JSON.parse(record.referenceImages as string) : [],
      toInputDir(config),
      1,
    )
    const loadId = Object.keys(graph).find((k) => graph[k]?.class_type === 'LoadImage')
    if (!loadId) throw new Error('qwen-workflow.json 缺 LoadImage 节点——请用 ComfyUI 的 Export (API) 重新导出覆盖')
    if (refs[0]) {
      graph[loadId].inputs.image = refs[0]
    } else {
      // 无参考图 = 纯文生图（场景/道具走这条）。参考图那条线要**整个摘掉**，不能留空：
      // LoadImage 收到空文件名会去列 input/ 目录，报
      //   [Errno 13] Permission denied: 'E:\AI\ComfyUI\input'
      // —— 看着像权限问题，真因是没图。顺手删节点，服务端就不会执行到它。
      delete graph[loadId]
      delete requireNode(graph, 'TextEncodeQwenImage21').inputs['images.image_1']
    }

    requireNode(graph, 'TextEncodeQwenImage21').inputs.prompt = record.prompt || ''
    const { width, height } = fitSize(record.size)
    const latent = requireNode(graph, 'EmptySD3LatentImage')
    latent.inputs.width = width
    latent.inputs.height = height
    // ponytail: seed 随机，与脚本唯一的**有意**差异——脚本写死 8888 只为复现同一张图，
    // 生产里固定 seed 会让「重新生成」永远吐同一张。
    // 6 步 turbo 路线没有 KSampler，seed 的落点是 SamplerCustomAdvanced 上链的 RandomNoise。
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
    // ComfyUI 只在作业结束（成功/报错）后才往 /history 落条目，空 = 还在跑
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
