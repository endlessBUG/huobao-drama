/**
 * 图片生成 Provider Adapter 接口
 */
export interface ImageProviderAdapter {
  /** 厂商标识 */
  provider: string

  /**
   * 构建图片生成请求
   * @param config AI 配置 { baseUrl, apiKey, model }
   * @param record 图片生成记录
   */
  buildGenerateRequest(config: AIConfig, record: ImageGenerationRecord): ProviderRequest | Promise<ProviderRequest>

  /**
   * 解析生成响应，判断是同步还是异步
   */
  parseGenerateResponse(result: any): ImageGenResponse

  /**
   * 构建轮询请求
   * @param config AI 配置
   * @param taskId 任务 ID
   */
  buildPollRequest(config: AIConfig, taskId: string): ProviderRequest

  /**
   * 解析轮询响应
   */
  parsePollResponse(result: any): ImagePollResponse

  /**
   * 从响应中提取图片 URL（用于直接下载）
   * 返回 null 表示图片数据是 base64 格式，需要用 extractImageBase64 处理
   */
  extractImageUrl(result: any): string | null

  /**
   * 从响应中提取 base64 图片数据
   * 仅用于 Gemini 等只返回 base64 的厂商
   */
  extractImageBase64(result: any): { data: string; mimeType: string } | null
}

/**
 * 视频生成 Provider Adapter 接口
 */
export interface VideoProviderAdapter {
  provider: string

  /** 允许返回 Promise（ComfyUI 桥需先把参考图落盘），同步返回则 await 后无副作用 */
  buildGenerateRequest(config: AIConfig, record: VideoGenerationRecord): ProviderRequest | Promise<ProviderRequest>

  parseGenerateResponse(result: any): VideoGenResponse

  buildPollRequest(config: AIConfig, taskId: string): ProviderRequest

  parsePollResponse(result: any): VideoPollResponse

  extractVideoUrl(result: any): string | null

  /** 可选：返回「这条预计要跑多少秒」（暖跑口径），轮询侧据此算进度百分比。给不出就返回 undefined（不显示进度） */
  progressHint?(record: VideoGenerationRecord): number | undefined
}

// ============ 通用类型 ============

export interface ProviderRequest {
  url: string
  method: string
  headers: Record<string, string>
  /**
   * 普通请求为可 JSON 序列化的对象（generation.ts 统一 JSON.stringify）；
   * multipart 上传（如 OpenAI /v1/images/edits）直接返回 FormData，
   * 此时 headers 不要设置 Content-Type，边界由 fetch 自动生成。
   */
  body: any
}

export interface AIConfig {
  provider: string
  baseUrl: string
  apiKey: string
  model: string
  // 本机 ComfyUI 专用：input 目录（落盘参考图）
  comfyuiInputDir?: string
}

export interface ImageGenerationRecord {
  id: number
  model?: string | null
  prompt?: string | null
  size?: string | null
  frameType?: string | null
  referenceImages?: string | null
  // ... 其他字段
}

export interface VideoGenerationRecord {
  id: number
  model?: string | null
  prompt?: string | null
  referenceMode?: string | null
  imageUrl?: string | null
  firstFrameUrl?: string | null
  lastFrameUrl?: string | null
  graph?: string | null   // 1017：saved 工作流文件名（桥 `_wf_saved`），空 = 桥默认 native
  referenceImageUrls?: string | null
  referenceVideoUrls?: string | null
  referenceAudioUrls?: string | null
  referenceFileUrl?: string | null
  referenceLinkUrl?: string | null
  // 帧锚（官方 §2.2 keyframe completion）：同一张图既当 <Picture N> 参考，又锚在目标视频的第 0 帧。
  // 只有「同一个镜头继续」才成立 —— 见 generation.ts 的 relayContext。
  guideUrl?: string | null
  // 上一段的 AV latent 文件名（桥的 output/latents/<name>.pt）。存在则走零往返衔接；
  // 不存在时桥回退到 guideUrl 的 pixel 路径。
  prevLatent?: string | null
  // 本段 latent 落盘名，供下一段用
  saveName?: string | null
  // 段首跑道帧数（窗口 + 过渡）：生成侧加它，落盘前裁掉，交付帧数才等于设定值
  trimFrames?: number | null
  // 第二层 LoRA（桥 _wf_video 里挂在 turbo 之后、注意力后端之前的那层）：只给文件名，空 = 不挂。
  // 社区治「特写解剖丑」用的是权重不是措辞 —— 见台账 docs/comfyui-h3-configs.md
  lora?: string | null
  loraStrength?: number | null
  // false = 不塞/不换触发词（只要权重）。归因实验要这个开关：C 臂换了 6 处 pussy→inniepussy，
  // 不关掉它就没法把「权重」和「措辞」分开。
  loraTrigger?: number | boolean | null
  // 桥的块稀疏注意力（sol-attn，comfy_kitchen CUDA 内核）。只在 cu130 venv 上那个门才开着
  // （comfy/quant_ops.py:26-28 在 torch<cu130 时把 CUDA 后端整个禁用 → 每次都回退 dense）。
  // 1004 在 cu124 + 1MP/243 帧那档实测是净亏（1080s vs 961s、身份 0.379→0.332），
  // 且上游 issue #16382 = 挂 LoRA + sol-attn 出伪影 —— 我们每条都带 turbo LoRA，所以这条只能当 A/B 仪表，默认关。
  sparse?: boolean | null
  generateAudio?: number | boolean | null
  duration?: number | null
  aspectRatio?: string | null
  resolution?: string | null
  seed?: number | null
  promptExtend?: number | boolean | null
  watermark?: number | boolean | null
  // ... 其他字段
}

export interface ImageGenResponse {
  isAsync: boolean
  taskId?: string
  /** 同步模式下直接返回的图片 URL */
  imageUrl?: string
}

export interface ImagePollResponse {
  status: 'pending' | 'processing' | 'completed' | 'failed'
  imageUrl?: string
  error?: string
}

export interface VideoGenResponse {
  isAsync: boolean
  taskId?: string
  videoUrl?: string
}

export interface VideoPollResponse {
  status: 'pending' | 'processing' | 'completed' | 'failed'
  videoUrl?: string
  duration?: number
  error?: string
  /** 上游透出的真进度（comfyui 桥 1012 起从 ws 抓 step，0-99）；没有就靠 progressHint 估 */
  progress?: number
}
