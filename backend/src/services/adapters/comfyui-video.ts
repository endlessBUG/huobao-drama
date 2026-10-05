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
// 2026-10-03 用户拍板：改走桥的 SelfLift 二采直出（body 带 selflift:true）。
// 前 2 步在 0.5× 低分辨率跑、构图在那里定，后 2 步在目标分辨率真画 —— 所以「抬生成分辨率会毁站位」
// 那条实测教训（352p/416p 优于 768p）在这里仍然成立：低分前缀保住了站位，高分段只补细节。
// 判据（storyboards.id=19，124 帧，同 prompt/refs/seed，ArcFace 余弦）：F2 0.395 vs 超分臂 0.174，
// 特写段右脸 0.542 > ref_a↔ref_b 基线 0.488（唯一越过噪声地板的臂）。锐度更低（18.2 vs 29.2）——
// 赢在「像」不在「清」，所以不再叠 FlashVSR。
// 代价：961s/条（低分 78s + 提升 4.4s + 高分 2×345s，8 瓦片）vs 旧链路 ≈7 分。
// 回退 = DEFAULT_SIZE 改回 '576x320'、UPSCALE 改回 2、body 去掉 selflift。
// 1003 改：默认 480p，分辨率提升靠 SelfLift 的 latent lift（432x240 前缀 → 864x480），不叠 FlashVSR。
// 之前 adapter 完全不看 record.resolution（写死 1152x640），所以「480p」是空设置 —— 这条把它接上。
const SIZE_480P = '864x480'
// 2026-10-05 用户看片定案：SelfLift 到 1.22 MP（1472x832 / 243 帧）—— 同 prompt/refs/seed 单变量
// 对照里它比 1.03 MP（1344x768）有结构（眼窝和上眼睑线在、鼻梁和嘴分得开、发丝成根），用户判「这次不错」。
// 1 MP 那个上限（MAX_PIXELS=768*1344）只卡参考视频（nodes.py:165），不卡输出画布，所以 1.22 MP 照跑。
// 代价：采样 514s vs 409s（+25.7%，正好是 token 多 22% 的量），整单约 34 min/条（冷跑）。
// 直出这个画布在 243 帧会 OOM（墙是 token 数 = 画布 × 帧数），所以只能靠 SelfLift 的分块拿 —— selflift 必须为 true。
const DEFAULT_SIZE = '1472x832'
const FL2VA_SIZE = '576x320'
const UPSCALE = 0
const FPS = 24
const DEFAULT_LENGTH = 124
// 模型训练区间 124-362 帧（JZL 节点 tooltip：124 ≈ 5s，训练区间约 124-362）；超出就出训练区，取上界。
const MIN_LENGTH = 124
const MAX_LENGTH = 362

/**
 * 分镜时长（秒）→ 模型帧数。两个硬约束：
 *  1. 帧数必须吸附到 17k+5 网格（节点 align_frame_count 是同款向上取整）。喂非对齐帧数**不报错**，
 *     会被 VAE 静默补帧（重复末帧）——表现成「尾巴卡住」，很容易误判成模型问题。
 *  2. 夹进训练区间 124-362（5.2-15.1s）。12s→294 帧(12.25s)，9s→226(9.42s)，8s→192(8.00s)。
 * 给不出秒数时退回默认 124 —— 与旧行为一致。
 */
export function framesForDuration(seconds?: number | null): number {
  if (!seconds || seconds <= 0) return DEFAULT_LENGTH
  let n = Math.round(seconds * FPS)
  while (n % 17 !== 5) n++
  return Math.min(MAX_LENGTH, Math.max(MIN_LENGTH, n))
}

export class ComfyUIVideoAdapter implements VideoProviderAdapter {
  provider = 'comfyui'

  async buildGenerateRequest(config: AIConfig, record: VideoGenerationRecord): Promise<ProviderRequest> {
    const prompt = (record.prompt || '').trim()
    if (!prompt) throw new Error('ComfyUI 视频生成要求必须提供提示词（prompt）')

    const inputDir = toInputDir(config)
    const images = await stageReferenceImages(parseUrlArray(record.referenceImageUrls), inputDir, MAX_IMAGES)
    // 帧锚走桥的 MiniMaxH3AddGuide（不是 ref 槽）：ref_image_0~8 与 keyframe 在同一个
    // cond_video_latents 里并存（comfy/model_base.py:2188-2196），不互斥。
    const guideFile = record.guideUrl ? (await stageReferenceImages([record.guideUrl], inputDir, 1))[0] : undefined
    if (images.length === 0) {
      // 桥会把 images 填默认 qingyi.jpg / xueqi.jpeg；此处显式传空即可，
      // 但为明确起见传 []（桥内部 _wf_video 会对不足 2 张补空串）
    }

    // ponytail: 首帧只 staging 一张；firstFrameUrl 缺失/空则不 staging、body 无 first_frame → bridge 回 ref2v
    const firstFrameFile = record.firstFrameUrl
      ? (await stageReferenceImages([record.firstFrameUrl], inputDir, 1))[0]
      : undefined

    const is480 = (record.resolution || '480p') === '480p'

    return {
      method: 'POST',
      url: `${baseOf(config.baseUrl)}/v1/videos/generations`,
      headers: { 'Content-Type': 'application/json' },
      body: {
        prompt,
        model: (record.model || config.model || 'minimax-h3-ref2v') || 'minimax-h3-ref2v',
        size: firstFrameFile ? FL2VA_SIZE : (is480 ? SIZE_480P : DEFAULT_SIZE),
        length: framesForDuration(record.duration) + (record.trimFrames || 0),
        images,
        ref_scale: 2.0,
        upscale: firstFrameFile ? 2 : UPSCALE,
        selflift: !firstFrameFile,   // 分辨率提升靠 SelfLift 的 latent lift（不是 FlashVSR）；首帧路径保持旧口径 + 超分
        first_frame: firstFrameFile,
        guide: guideFile,
        trim: record.trimFrames || 0,
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
