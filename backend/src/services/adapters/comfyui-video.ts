// ponytail: 复制自 minimax-video.parseUrlArray — record.referenceImageUrls 是 generation.ts 的 JSON 串
function parseUrlArray(raw?: string | null): string[] {
  if (!raw) return []
  try {
    const arr = JSON.parse(raw)
    return Array.isArray(arr) ? arr.filter((u) => typeof u === 'string' && u.trim()) : []
  } catch {
    return []
  }
}
// 端点（本机 ComfyUI + ComfyUI-OpenAI-Bridge，OpenAI 兼容）:
//   POST {base}/v1/videos/generations    -> {"id":"..","status":"queued"}     (202，视频默认异步，约 3 分钟)
//   GET  {base}/v1/videos/generations/{id} -> {"id","status","file","url","error"}
//   GET  {base}/v1/files/{path}          -> mp4 字节
//
// 模型: minimax-h3-ref2v（参考图生视频，576x320，默认 124 帧 ≈ 5.2s @24fps）
// 关键差异 vs 官方 MiniMax：images 是「文件名」（落在 ComfyUI input/ 目录），不是 image_url。
// 故本 Adapter 生成前把每个参考图下载/读取进 ComfyUI input/ 目录，再传文件名。
// ponytail: 本地单机够用 —— 作业状态存 ComfyUI 内存，进程重启丢作业；但 mp4 产物仍在 output/。
import type {
  VideoProviderAdapter,
  ProviderRequest,
  AIConfig,
  VideoGenerationRecord,
  VideoGenResponse,
  VideoPollResponse,
} from './types'
import { baseOf, stageReferenceImages, toInputDir } from './comfyui-common'

// 工作流本身动态（JZL ref2v 支持 ref_image_0~8 / Autogrow max=9），不人为截断
const MAX_IMAGES = 9
const DEFAULT_SIZE = '576x320'
const FPS = 24
const DEFAULT_LENGTH = 124

export class ComfyUIVideoAdapter implements VideoProviderAdapter {
  provider = 'comfyui'

  async buildGenerateRequest(config: AIConfig, record: VideoGenerationRecord): Promise<ProviderRequest> {
    const prompt = (record.prompt || '').trim()
    if (!prompt) throw new Error('ComfyUI 视频生成要求必须提供提示词（prompt）')

    const inputDir = toInputDir(config)
    const images = await stageReferenceImages(parseUrlArray(record.referenceImageUrls), inputDir, MAX_IMAGES)
    if (images.length === 0) {
      // 桥会把 images 填默认 qingyi.jpg / xueqi.jpeg；此处显式传空即可，
      // 但为明确起见传 []（桥内部 _wf_video 会对不足 2 张补空串）
    }

    // ponytail: 首帧只 staging 一张；firstFrameUrl 缺失/空则不 staging、body 无 first_frame → bridge 回 ref2v
    const firstFrameFile = record.firstFrameUrl
      ? (await stageReferenceImages([record.firstFrameUrl], inputDir, 1))[0]
      : undefined

    return {
      method: 'POST',
      url: `${baseOf(config.baseUrl)}/v1/videos/generations`,
      headers: { 'Content-Type': 'application/json' },
      body: {
        prompt,
        model: (record.model || config.model || 'minimax-h3-ref2v') || 'minimax-h3-ref2v',
        size: DEFAULT_SIZE,
        length: DEFAULT_LENGTH,
        images,
        ref_scale: 2.0,
        first_frame: firstFrameFile,
        seed: record.seed ?? undefined,
      },
    }
  }

  parseGenerateResponse(result: any): VideoGenResponse {
    if (result.id) return { isAsync: true, taskId: String(result.id) }
    if (result.url) return { isAsync: false, videoUrl: result.url }
    throw new Error('ComfyUI 视频响应异常：缺少 job id')
  }

  buildPollRequest(config: AIConfig, taskId: string): ProviderRequest {
    return {
      method: 'GET',
      url: `${baseOf(config.baseUrl)}/v1/videos/generations/${taskId}`,
      headers: {},
      body: undefined,
    }
  }

  parsePollResponse(result: any): VideoPollResponse {
    const status = (result.status || '').toLowerCase()
    if (status === 'queued' || status === 'running' || status === 'pending') {
      return { status: 'processing' }
    }
    if (status === 'succeeded') {
      return { status: 'completed', videoUrl: result.url, duration: (result.length || DEFAULT_LENGTH) / FPS }
    }
    return { status: 'failed', error: result.error || `ComfyUI 视频生成失败（status: ${status}）` }
  }

  extractVideoUrl(result: any): string | null {
    return result.url || null
  }
}
