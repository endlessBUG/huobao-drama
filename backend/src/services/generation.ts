/**
 * 统一生成任务服务 — 图片/视频生成共用 sys_task 表与同一条生命周期：
 * 创建(processing) → 适配器构建请求 → 同步完成或异步轮询 → 下载落盘 → 回写业务表
 */
import fs from 'node:fs'
import path from 'node:path'
import sharp from 'sharp'
import { db, getInsertId, schema } from '../db/index.js'
import { DATA_ROOT } from '../utils/paths.js'
import { and, eq } from 'drizzle-orm'
import { getActiveConfig, getConfigById } from './ai.js'
import { now } from '../utils/response.js'
import { downloadFile, fetchImageAsCompressedDataUrl, generateImageThumb, readImageAsCompressedDataUrl, saveBase64Image } from '../utils/storage.js'
import { extractVideoPoster, extractLastFrame } from '../utils/video-poster.js'
import { getImageAdapter, getVideoAdapter } from './adapters/registry'
import { getDramaStylePrompt } from './style-preset.js'
import { characterSheetDefaultPrompt } from './character-sheet.js'
import { refineVideoFace, wantsFaceRefine } from './adapters/face-refine'
import { upscaleVideoVSR, wantsUpscale } from './adapters/vsr-upscale'
import { deflickerVideo } from './video-deflicker'
import { effectiveGraph, framesForDuration, isSelfContainedGraph, PROD_GRAPH } from './adapters/comfyui-video'
import type { AIConfig } from './adapters/types'
import { logTaskError, logTaskPayload, logTaskProgress, logTaskStart, logTaskSuccess, logTaskWarn, redactUrl } from '../utils/task-logger.js'

type TaskType = 'image' | 'video'

const taskLabel = (type: TaskType) => (type === 'image' ? 'ImageTask' : 'VideoTask')

// 段间衔接窗口（社区 SEAM_DEFAULT_WINDOW=22 = 17m+5，落在 token 边界上）。
const SEAM_WINDOW = 22

// 轮询节奏：图片 5s×120（上限 10 分钟）；视频 10s×300
// 图片 360×5s = 30 分钟。原来卡死 10 分钟（120×5s），而本机 qwen 三视图单张实测跑过
// 10 分钟（任务 55：后端判 failed、ComfyUI 还在算，算完的图没人取）。原因在本机的
// 8G 显存扛不住 qwen 的模型（日志里 unet 只装进 4.5G / 12G，text encoder 8.9G 全在 CPU），
// 一直在 host↔device 搬运 —— python 进程烧 CPU、步速 7~30s/it，单张 6.6 分钟到 20+ 分钟不等。
// 视频本来就没有墙钟上限。
/** 链式生成按集串起来（段 N 依赖段 N-1 的成片） */
const videoChains = new Map<number, Promise<void>>()

const POLL_PROFILES: Record<TaskType, { attempts: number; intervalMs: number; maxDurationMs: number | null }> = {
  // 1119：角色三视图是级联出来的，常常排在一条 40 分钟的 H3 视频任务后面 → 30 分钟窗口不够（1252 实际判死过）
  image: { attempts: 900, intervalMs: 5000, maxDurationMs: null },
  // 243 帧的 SelfLift 实测 47:26（含解码），300 次 × 10s = 50 分钟正好卡在边界上：
  // 任务 128 就是被「polling attempts exhausted」判失败的，而 ComfyUI 那边其实还在跑。
  // 1119：内存压缩下单镜可达 90–120 分钟，100 分钟窗口不够（1289/1281 都被误判超时）
  video: { attempts: 1800, intervalMs: 10_000, maxDurationMs: null },
}

interface GenerateImageParams {
  storyboardId?: number
  dramaId?: number
  sceneId?: number
  characterId?: number
  propId?: number
  prompt: string
  model?: string
  size?: string
  referenceImages?: string[]
  frameType?: string
  configId?: number
  sceneGrid?: boolean
  /** 1119 技能（招式）资产图：产物写 techniques.image_url */
  techniqueId?: number
  /** 1119 三视图补跑单：产物写 sheet_image_url，不再级联下一轮 */
  sheetPass?: boolean
  /** 1122：本次图片请求允许的最大像素（服饰图要更大时抬，不传 = provider 默认档） */
  maxPixels?: number
  /** 1122 服饰候选：产物写 character_outfits.image_url */
  outfitId?: number
  /** 1122 饰品网格：产物写 character_outfits.accessory_image_url */
  outfitAccessoryId?: number
  /** 1122 角色×服饰组合三视图：产物写 character_outfits.sheet_image_url */
  outfitSheetId?: number
}

interface GenerateVideoParams {
  storyboardId?: number
  dramaId?: number
  prompt: string
  model?: string
  referenceMode?: string
  imageUrl?: string
  firstFrameUrl?: string
  lastFrameUrl?: string
  graph?: string   // 1017：桥里那份 saved 工作流的文件名（`.json`）；空 = 走默认 native
  referenceImageUrls?: string[]
  referenceVideoUrls?: string[]
  referenceAudioUrls?: string[]
  referenceFileUrl?: string
  referenceLinkUrl?: string
  generateAudio?: boolean
  duration?: number
  aspectRatio?: string
  resolution?: string
  seed?: number
  /** 1108 A/B 仪表：显式采样步数，覆盖无 LoRA 的 4 步 / 挂 LoRA 的 config.steps。不传 = 老口径 */
  steps?: number
  promptExtend?: boolean
  watermark?: boolean
  configId?: number
  /** 段间接力：把上一段成片的末帧当额外参考带进本段（见 relayLastFrame） */
  chain?: boolean
  /** [1117] chain 的衔接方式：true = 段间 latent 直传（零 VAE 往返，图里需 BridgeSaveAVLatent）；不传 = 像素末帧锚 */
  latentChain?: boolean
  /** 第二层 LoRA 文件名（comfyui 桥专属，空 = 不挂）+ 强度，默认 1.0；loraTrigger=false = 只要权重不碰触发词 */
  lora?: string | null
  loraStrength?: number | null
  loraTrigger?: boolean | null
  /** 桥的块稀疏注意力 sol-attn（comfyui 桥专属，见 adapters/types.ts 的注释：cu130 才有内核、挂 LoRA 出伪影） */
  sparse?: boolean | null
  /** 1115 去 turbo LoRA（native 裸权重，20 步；用户「换成不要lora 1采20步」那档的单变量仪表） */
  noLora?: boolean | null
  /** 1119 技能整条流程参考视频：产物写 techniques.video_url */
  techniqueId?: number
  /** 1024 小脸修复二采：基片生成后再跑一发 ComfyUI-H3-FaceRefine（comfyui 专属，见 adapters/face-refine.ts） */
  refine?: boolean
  /** 1025 分辨率后处理 RTX VSR ×2：默认全开，显式 false 关（见 adapters/vsr-upscale.ts 的 wantsUpscale）。
   *  以前只有 `wantsUpscale` 认这个参数、route 没透传 ⇒ body 写 upscale:false 是空设置 */
  upscale?: boolean
}

export async function generateImage(params: GenerateImageParams): Promise<number> {
  // 指定配置（集锁定）可能已停用/删除/厂商收敛，失效时回退到当前启用配置，避免生成被旧引用卡死
  const config = params.configId
    ? (await getConfigById(params.configId)) ?? await getActiveConfig('image')
    : await getActiveConfig('image')
  if (!config) throw new Error('未配置图片模型，请先到「设置」页添加并启用 AI 服务')

  const id = await createTask('image', config, {
    storyboardId: params.storyboardId,
    dramaId: params.dramaId,
    sceneId: params.sceneId,
    characterId: params.characterId,
    propId: params.propId,
    prompt: params.prompt,
    model: params.model || config.model,
  }, {
    size: params.size || '1920x1080',
    maxPixels: params.maxPixels,
    frameType: params.frameType,
    referenceImages: params.referenceImages,
    sceneGrid: params.sceneGrid,
    techniqueId: params.techniqueId,
    sheetPass: params.sheetPass,
    outfitId: params.outfitId,
    outfitAccessoryId: params.outfitAccessoryId,
    outfitSheetId: params.outfitSheetId,
  })

  logTaskStart('ImageTask', 'enqueue', {
    id,
    provider: config.provider,
    storyboardId: params.storyboardId,
    sceneId: params.sceneId,
    characterId: params.characterId,
    frameType: params.frameType,
    model: params.model || config.model,
  })
  logTaskPayload('ImageTask', 'enqueue params', {
    id,
    config: { provider: config.provider, model: config.model, baseUrl: config.baseUrl },
    params,
  })
  return id
}

export async function generateVideo(params: GenerateVideoParams): Promise<number> {
  // 指定配置（集锁定）可能已停用/删除/厂商收敛，失效时回退到当前启用配置
  const config = params.configId
    ? (await getConfigById(params.configId)) ?? await getActiveConfig('video')
    : await getActiveConfig('video')
  if (!config) throw new Error('未配置视频模型，请先到「设置」页添加并启用 AI 服务')

  const id = await createTask('video', config, {
    storyboardId: params.storyboardId,
    dramaId: params.dramaId,
    prompt: params.prompt,
    model: params.model || config.model,
  }, {
    referenceMode: params.referenceMode || 'reference',
    imageUrl: params.imageUrl,
    firstFrameUrl: params.firstFrameUrl,
    lastFrameUrl: params.lastFrameUrl,
    graph: params.graph,
    referenceImageUrls: params.referenceImageUrls,
    referenceVideoUrls: params.referenceVideoUrls,
    referenceAudioUrls: params.referenceAudioUrls,
    techniqueId: params.techniqueId,
    referenceFileUrl: params.referenceFileUrl,
    referenceLinkUrl: params.referenceLinkUrl,
    generateAudio: params.generateAudio === false ? 0 : 1,
    duration: params.duration,
    aspectRatio: params.aspectRatio,
    // 统一存为项目内部格式，各适配器再转换为官方大小写与枚举。
    resolution: normalizeStoredVideoResolution(params.resolution),
    seed: params.seed,
    steps: params.steps,   // 必须进快照：processTask 读 DB params，不进 = 这条从没传过
    promptExtend: params.promptExtend,
    watermark: params.watermark,
    // chain 必须进快照：processTask 读的是 DB 里的 params，不落盘接力就永远不触发（1003 A/B 实测 arm B 只有 3 张参考图）
    chain: params.chain,
    // [1117] latent 衔接开关也要进快照（processTask 读 DB）
    latentChain: params.latentChain,
    lora: params.lora,
    loraStrength: params.loraStrength,
    loraTrigger: params.loraTrigger,
    sparse: params.sparse,   // 必须进快照：processTask 读的是 DB 里的 params，不进就等于从没传过
    noLora: params.noLora,   // 同上：no_lora 必须进快照，否则 processTask 读不到
    refine: params.refine,   // 小脸修复二采开关：handleVideoComplete 读 DB params.refine 决定是否跑二采
    upscale: params.upscale, // VSR ×2 开关（同上，读 DB params.upscale）
  })

  logTaskStart('VideoTask', 'enqueue', {
    id,
    provider: config.provider,
    storyboardId: params.storyboardId,
    dramaId: params.dramaId,
    referenceMode: params.referenceMode || 'reference',
    duration: params.duration || 5,
  })
  logTaskPayload('VideoTask', 'enqueue params', {
    id,
    config: { provider: config.provider, model: config.model, baseUrl: config.baseUrl },
    params,
  })
  return id
}

async function createTask(
  type: TaskType,
  config: AIConfig,
  fields: {
    storyboardId?: number
    dramaId?: number
    sceneId?: number
    characterId?: number
    propId?: number
    prompt: string
    model?: string | null
  },
  params: Record<string, unknown>,
): Promise<number> {
  const ts = now()
  const res = await db.insert(schema.sysTask).values({
    type,
    ...fields,
    provider: config.provider,
    params: JSON.stringify(params),
    status: 'processing',
    createdAt: ts,
    updatedAt: ts,
  })

  const id = getInsertId(res)
  const run = () => processTask(id, config).catch(err => {
    logTaskError(taskLabel(type), 'process', { id, error: err.message })
    console.error(`${taskLabel(type)} ${id} failed:`, err)
  })

  // 链式（连续拍）要求段按顺序跑：段 N 的接力帧来自段 N-1 的成片，不排队就会在上一段完成前取到 null。
  // 桥那边本来就是一条条执行，这里补的是 params 快照的时序。
  if (type === 'video' && params.chain && params.storyboardId) {
    const sbId = Number(params.storyboardId)
    const [sb] = await db.select({ episodeId: schema.storyboards.episodeId }).from(schema.storyboards)
      .where(eq(schema.storyboards.id, sbId)).limit(1)
    const key = sb?.episodeId ?? 0
    const prev = videoChains.get(key) ?? Promise.resolve()
    videoChains.set(key, prev.then(run))
    return id
  }

  run()
  return id
}

function parseTaskParams(raw: string | null | undefined): Record<string, any> {
  if (!raw) return {}
  try {
    return JSON.parse(raw) || {}
  } catch {
    return {}
  }
}

async function processTask(id: number, config: AIConfig) {
  try {
    const [record] = await db.select().from(schema.sysTask).where(eq(schema.sysTask.id, id))
    if (!record) return
    const type = record.type as TaskType
    const label = taskLabel(type)
    const params = parseTaskParams(record.params)
    logTaskProgress(label, 'build-request', {
      id,
      provider: config.provider,
      storyboardId: record.storyboardId,
      sceneId: record.sceneId,
      characterId: record.characterId,
    })

    let url: string, method: string, headers: Record<string, string>, body: unknown

    if (type === 'image') {
      const adapter = getImageAdapter(config.provider)
      const resolvedReferenceImages = await normalizeReferenceImages(params.referenceImages)
      const req = await adapter.buildGenerateRequest(config, {
        id: record.id,
        model: record.model,
        prompt: record.prompt,
        size: params.size,
        maxPixels: params.maxPixels,
        frameType: params.frameType,
        referenceImages: resolvedReferenceImages.length ? JSON.stringify(resolvedReferenceImages) : null,
      })
      ;({ url, method, headers, body } = req)
    } else {
      const adapter = getVideoAdapter(config.provider)
      const resolvedImageUrl = await normalizeVideoReferenceUrl(params.imageUrl)
      const resolvedFirstFrameUrl = await normalizeVideoReferenceUrl(params.firstFrameUrl)
      const resolvedLastFrameUrl = await normalizeVideoReferenceUrl(params.lastFrameUrl)
      const resolvedReferenceImageUrls = await normalizeVideoReferenceUrls(params.referenceImageUrls)
      // 镜头衔接（1018 用户规则）：衔接 = 上一条**精确末帧**当首帧锚（AddGuide frame_idx 0）；
      // 不衔接（cut / 跨场景）= 不碰上一段，只用参考图。参考图始终由 referenceImageUrls 另传。
      let prompt = record.prompt
      let firstFrameUrl = resolvedFirstFrameUrl
      let guideUrl: string | null = null
      let prevLatent: string | null = null
      let trimFrames = 0
      if (params.chain) {
        const ctx = await relayContext(record.storyboardId)
        if (ctx?.source && ctx.sameScene && ctx.continuity === 'same_shot') {
          // [1117] latent 直传：上一段 latent 尾部当 frame 0 关键帧——零 VAE 往返，不经过
          // 成片解码/压缩，避免像素锚的塑料感。上一段的 latent 由上一条自己 BridgeSaveAVLatent 落盘。
          // 11-17 用户「固化方案」：Pika 一条龙图缺省就走 latent（显式 latent_chain:false 才回像素锚）；
          // 上一段没有 .pt（老产物）时桥自己退回无锚，不会报错。
          const latentDefault = /^h3_pika_flex_1shot.*\.json$/i.test(String(params.graph || ''))
          if ((params.latentChain ?? latentDefault) && String(params.graph || '').toLowerCase() !== 'jzl') {
            prevLatent = `sb${ctx.prevId}`
            prompt = `${prompt}\ncontinuity: [keyframe completion] continue seamlessly from the end of the previous shot; match lighting, colour, camera position and motion.`
          } else {
            const lastFrame = await extractLastFrame(ctx.source)
            if (lastFrame) {
              // 老 JZL 图只认 keyframe 窗口（guide + 段间 latent）：cond 行永不降噪、每步重注入，
              // 段首窗口是照搬的，落盘前裁掉。native / saved 图走 AddGuide 首帧，不重复窗口、不裁。
              if (String(params.graph || '').toLowerCase() === 'jzl') {
                guideUrl = lastFrame
                prevLatent = `sb${ctx.prevId}`
                trimFrames = SEAM_WINDOW
              } else {
                firstFrameUrl = lastFrame
              }
              prompt = `${prompt}\ncontinuity: [keyframe completion] the first frame is taken from the end of the previous shot; match its lighting, colour and camera position.`
            }
          }
        }
      }
      // 参考视频/音频文件较大，不适合 dataURL 内联，需解析为公网可访问 URL
      const resolvedReferenceVideoUrls = resolvePublicMediaUrls(params.referenceVideoUrls, 'video')
      // 1107 锁音：comfyui 适配器自己会把 static/ 路径读成字节落到 input/，不需要公网地址 ——
      // 走 resolvePublicMediaUrls 时未配 PUBLIC_BASE_URL 会直接 throw，把本地台词床整条路堵死。
      const resolvedReferenceAudioUrls = config.provider === 'comfyui'
        ? Array.from(new Set((Array.isArray(params.referenceAudioUrls) ? params.referenceAudioUrls : [])
            .map((u) => String(u || '').trim()).filter(Boolean)))
        : resolvePublicMediaUrls(params.referenceAudioUrls, 'audio')
      const resolvedReferenceFileUrl = resolvePublicMediaUrl(params.referenceFileUrl, 'file')
      const req = await adapter.buildGenerateRequest(config, {
        id: record.id,
        model: record.model,
        prompt,
        referenceMode: params.referenceMode,
        imageUrl: resolvedImageUrl,
        firstFrameUrl,
        lastFrameUrl: resolvedLastFrameUrl,
        // 1017 的洞：`graph` 存进了 sys_task.params（上面 :142）也进了适配器（comfyui-video.ts:191
        // `record.graph`），但这条 record 字面量是**逐字段列出来的**、没抄 graph ⇒ 适配器永远读到
        // undefined ⇒ 桥 `_graph = b.get("graph") or "native"` 恒走 native，body `graph:"*.json"` 形同不存在。
        // 实测证据 = 1017 13:18Z 那条在跑的 `/queue`：文件里 CLIPLoader `device:"cpu"`，队列里同一号
        // 节点却是 `"device":"default"`（`h3_refall_cpuTE.json` 的 28 号被 `_wf_saved` 剪到 20 号，
        // 但 device 不会被它动 —— `__init__.py:600-601` 只是 `dict(v["inputs"])` 原样拷）。
        graph: params.graph,
        referenceImageUrls: resolvedReferenceImageUrls.length ? JSON.stringify(resolvedReferenceImageUrls) : null,
        referenceVideoUrls: resolvedReferenceVideoUrls.length ? JSON.stringify(resolvedReferenceVideoUrls) : null,
        referenceAudioUrls: resolvedReferenceAudioUrls.length ? JSON.stringify(resolvedReferenceAudioUrls) : null,
        referenceFileUrl: resolvedReferenceFileUrl,
        referenceLinkUrl: params.referenceLinkUrl,
        guideUrl,
        prevLatent,
        saveName: record.storyboardId ? `sb${record.storyboardId}` : null,
        trimFrames,
        generateAudio: params.generateAudio,
        duration: params.duration,
        aspectRatio: params.aspectRatio,
        resolution: params.resolution,
        seed: params.seed,
        steps: params.steps,
        promptExtend: params.promptExtend,
        watermark: params.watermark,
        lora: params.lora,
        loraStrength: params.loraStrength,
        loraTrigger: params.loraTrigger,
        sparse: params.sparse,
        noLora: params.noLora,
      })
      ;({ url, method, headers, body } = req)
    }

    logTaskProgress(label, 'request', {
      id,
      provider: config.provider,
      method,
      url: redactUrl(url),
      model: record.model,
    })

    const isMultipart = body instanceof FormData
    logTaskPayload(label, 'request payload', {
      id, method, url, headers,
      // multipart 表单（如 OpenAI /v1/images/edits）无法 JSON 化，记录字段摘要
      body: isMultipart ? `[multipart/form-data: ${[...(body as FormData).keys()].join(', ')}]` : body,
    })

    const resp = await fetch(url, {
      method,
      headers,
      body: isMultipart ? (body as FormData) : JSON.stringify(body),
      signal: AbortSignal.timeout(600_000),
    })

    if (!resp.ok) throw new Error(`API error ${resp.status}: ${await resp.text()}`)
    const result = await resp.json() as any
    logTaskPayload(label, 'response payload', { id, provider: config.provider, result })

    if (type === 'image') {
      const adapter = getImageAdapter(config.provider)
      const { isAsync, taskId, imageUrl } = adapter.parseGenerateResponse(result)

      if (!isAsync && imageUrl) {
        logTaskProgress(label, 'sync-complete', { id, imageUrl })
        await handleImageComplete(record, imageUrl)
        return
      }

      if (!isAsync && !imageUrl) {
        // 同步模式但无 URL（Gemini 等返回 base64）
        const b64 = adapter.extractImageBase64(result)
        if (b64) {
          logTaskProgress(label, 'sync-base64-complete', { id, mimeType: b64.mimeType })
          await handleImageCompleteBase64(record, b64.data, b64.mimeType)
          return
        }
        throw new Error('No image URL or base64 data in response')
      }

      await markPolling(id, taskId)
      pollTask(record, config, taskId!)
      return
    }

    const adapter = getVideoAdapter(config.provider)
    const { isAsync, taskId, videoUrl } = adapter.parseGenerateResponse(result)

    if (!isAsync && videoUrl) {
      logTaskProgress(label, 'sync-complete', { id, videoUrl })
      await handleVideoComplete(record, config, videoUrl, params.duration)
      return
    }

    await markPolling(id, taskId)
    pollTask(record, config, taskId!)
  } catch (err: any) {
    await failTask(id, err.message)
  }
}

async function markPolling(id: number, taskId: string | undefined) {
  await db.update(schema.sysTask)
    .set({ taskId, status: 'processing', updatedAt: now() })
    .where(eq(schema.sysTask.id, id))
  logTaskProgress('SysTask', 'poll-start', { id, taskId })
}

async function failTask(id: number, message: string) {
  logTaskError('SysTask', 'failed', { id, error: message })
  await db.update(schema.sysTask)
    .set({ status: 'failed', errorMsg: message, updatedAt: now() })
    .where(eq(schema.sysTask.id, id))
}

type SysTaskRecord = typeof schema.sysTask.$inferSelect

async function pollTask(record: SysTaskRecord, config: AIConfig, taskId: string) {
  const type = record.type as TaskType
  const label = taskLabel(type)
  const profile = POLL_PROFILES[type]
  const adapter = type === 'image' ? getImageAdapter(config.provider) : getVideoAdapter(config.provider)
  const startedAt = Date.now()

  for (let i = 0; i < profile.attempts; i++) {
    if (profile.maxDurationMs && Date.now() - startedAt >= profile.maxDurationMs) {
      await failTask(record.id, 'Timeout: Polling exceeded 10 minutes')
      return
    }
    await new Promise(r => setTimeout(r, profile.intervalMs))
    try {
      const { url, method, headers } = adapter.buildPollRequest(config, taskId)
      logTaskProgress(label, 'poll-request', {
        id: record.id,
        taskId,
        provider: config.provider,
        method,
        url: redactUrl(url),
        attempt: i + 1,
      })
      const remainingMs = profile.maxDurationMs
        ? Math.max(1_000, profile.maxDurationMs - (Date.now() - startedAt))
        : 600_000
      const resp = await fetch(url, {
        method,
        headers,
        signal: AbortSignal.timeout(remainingMs),
      })
      if (!resp.ok) continue
      const result = await resp.json() as any

      // 图片/视频 PollResponse 结构不同，这里统一按 any 取值后按 type 分支
      const pollResp: any = adapter.parsePollResponse(result)

      if (pollResp.status === 'completed') {
        if (type === 'image') {
          if (pollResp.imageUrl) {
            logTaskSuccess(label, 'poll-complete', { id: record.id, taskId, imageUrl: pollResp.imageUrl })
            await handleImageComplete(record, pollResp.imageUrl)
            return
          }
          if (adapter.provider === 'gemini') {
            // Gemini 可能返回 base64
            const b64 = (adapter as ReturnType<typeof getImageAdapter>).extractImageBase64(result)
            if (b64) {
              logTaskSuccess(label, 'poll-base64-complete', { id: record.id, taskId, mimeType: b64.mimeType })
              await handleImageCompleteBase64(record, b64.data, b64.mimeType)
              return
            }
          }
        } else if (pollResp.videoUrl) {
          logTaskSuccess(label, 'poll-complete', { id: record.id, taskId, videoUrl: pollResp.videoUrl })
          await handleVideoComplete(record, config, pollResp.videoUrl, pollResp.duration)
          return
        }
      }
      if (pollResp.status === 'failed') {
        // 上游明确失败（如内容审核拦截）属终态：立即落库，不重试不等待超时
        await failTask(record.id, pollResp.error || 'Generation failed')
        return
      }

      // 进度写回（1012）：不加列不迁移，塞进现成的 params JSON。优先用上游透出的真步数
      // （comfyui 桥从 ws 抓的 pct），没有才用 adapter.progressHint 的暖跑锚估算；
      // 估算上限 95%，真完成由 succeeded 定。写失败不影响轮询。
      // ⚠️ progressHint 要的是 adapter 的 record 形状（resolution/duration 在顶层），
      // 而这里手里是 sys_task 行 —— 那些字段埋在 params JSON 里，1012 第一版直接传行
      // 导致永远落进 480p 档（expected=364 而不是 270）。从 params 还原视图再传。
      let hint: number | undefined
      if (type === 'video' && typeof (adapter as any).progressHint === 'function') {
        try {
          const pp = JSON.parse(record.params || '{}')
          hint = (adapter as any).progressHint({
            prompt: record.prompt || '',
            duration: pp.duration,
            resolution: pp.resolution,
            firstFrameUrl: pp.firstFrameUrl || pp.first_frame_url,
          })
        } catch { hint = undefined }
      }
      const real = typeof pollResp.progress === 'number' ? pollResp.progress : undefined
      if (real != null || hint) {
        const elapsed = Math.round((Date.now() - startedAt) / 1000)
        const pct = real != null ? Math.min(99, real) : Math.min(95, Math.round((elapsed / (hint || 1)) * 100))
        try {
          const params = JSON.parse(record.params || '{}')
          params.progress = { pct, elapsed, ...(hint ? { expected: hint } : {}), ...(real != null ? { real: true } : {}) }
          record.params = JSON.stringify(params)
          await db.update(schema.sysTask)
            .set({ params: record.params, updatedAt: now() })
            .where(eq(schema.sysTask.id, record.id))
        } catch { /* 进度是装饰 */ }
      }
    } catch (err: any) {
      const exhausted = i === profile.attempts - 1
        || (profile.maxDurationMs != null && Date.now() - startedAt >= profile.maxDurationMs)
      if (exhausted) {
        await failTask(record.id, `Timeout: ${err.message}`)
        return
      }
      logTaskWarn(label, 'poll-retry', { id: record.id, taskId, attempt: i + 1, error: err.message })
    }
  }
  await failTask(record.id, 'Timeout: polling attempts exhausted')
}

async function handleImageComplete(record: SysTaskRecord, imageUrl: string) {
  const localPath = await downloadFile(imageUrl, 'images')
  // 列表页缩略图（前端按命名约定推导地址，失败不影响主流程）
  await generateImageThumb(localPath)

  await db.update(schema.sysTask)
    .set({ resultUrl: imageUrl, localPath, status: 'completed', completedAt: now(), updatedAt: now() })
    .where(eq(schema.sysTask.id, record.id))

  logTaskSuccess('ImageTask', 'downloaded', { id: record.id, provider: record.provider, localPath })

  await writeBackImageAssets(record, localPath)
}

async function handleImageCompleteBase64(record: SysTaskRecord, base64Data: string, mimeType: string) {
  const localPath = await saveBase64Image(base64Data, mimeType, 'images')
  await generateImageThumb(localPath)

  await db.update(schema.sysTask)
    .set({ localPath, status: 'completed', completedAt: now(), updatedAt: now() })
    .where(eq(schema.sysTask.id, record.id))

  logTaskSuccess('ImageTask', 'saved-base64', { id: record.id, provider: record.provider, mimeType, localPath })

  await writeBackImageAssets(record, localPath)
}

/** 1119：角色主图落地后默认补一张三视图（qwen 参考图驱动；尺寸与 character-sheet 口径一致 1920x1080） */
async function enqueueCharacterSheet(record: SysTaskRecord, portraitPath: string) {
  const cid = record.characterId
  if (!cid) return
  const [char] = await db.select().from(schema.characters).where(eq(schema.characters.id, cid))
  if (!char) return
  const stylePrompt = await getDramaStylePrompt(char.dramaId).catch(() => '')
  const genId = await generateImage({
    characterId: cid,
    dramaId: char.dramaId,
    prompt: characterSheetDefaultPrompt(stylePrompt, true),
    size: '1920x1080',
    referenceImages: [portraitPath],
    sheetPass: true,
  })
  logTaskStart('CharacterSheet', 'auto', { characterId: cid, generationId: genId })
}

// 图片完成后回写业务表：分镜(按 frameType)、角色、场景、道具
async function writeBackImageAssets(record: SysTaskRecord, localPath: string) {
  const params = parseTaskParams(record.params)
  if (record.storyboardId) {
    const sbUpdate: Record<string, any> = { updatedAt: now() }
    if (params.frameType === 'first_frame') sbUpdate.firstFrameImage = localPath
    else if (params.frameType === 'last_frame') sbUpdate.lastFrameImage = localPath
    else sbUpdate.composedImage = localPath
    await db.update(schema.storyboards).set(sbUpdate).where(eq(schema.storyboards.id, record.storyboardId))
  }
  if (record.characterId) {
    if (params.sheetPass) {
      // 1119 三视图补跑：只写 sheet_image_url，不再级联（否则无限套娃）
      await db.update(schema.characters).set({ sheetImageUrl: localPath, updatedAt: now() }).where(eq(schema.characters.id, record.characterId))
    } else {
      await db.update(schema.characters).set({ imageUrl: localPath, updatedAt: now() }).where(eq(schema.characters.id, record.characterId))
      // 1119 用户「平台接口要默认出三视图」：主图落地后自动补一张（参考图 = 刚出的主图；失败不影响主图）
      await enqueueCharacterSheet(record, localPath).catch((err: any) => logTaskWarn('CharacterSheet', 'auto-skip', { id: record.id, error: String(err?.message || err).slice(0, 160) }))
    }
  }
  if (record.sceneId) {
    await db.update(schema.scenes).set({
      ...(params.sceneGrid ? { gridImageUrl: localPath } : { imageUrl: localPath }),
      status: 'completed', updatedAt: now(),
    }).where(eq(schema.scenes.id, record.sceneId))
  }
  if (record.propId) {
    await db.update(schema.props).set({ imageUrl: localPath, updatedAt: now() }).where(eq(schema.props.id, record.propId))
  }
  if (params.techniqueId) {
    await db.update(schema.techniques).set({ imageUrl: localPath, status: 'ready', updatedAt: now() }).where(eq(schema.techniques.id, Number(params.techniqueId)))
  }
  if (params.outfitId) {
    await db.update(schema.characterOutfits).set({ imageUrl: localPath, status: 'ready', updatedAt: now() }).where(eq(schema.characterOutfits.id, Number(params.outfitId)))
    await composeOutfitImage(Number(params.outfitId))
  }
  if (params.outfitAccessoryId) {
    await db.update(schema.characterOutfits).set({ accessoryImageUrl: localPath, updatedAt: now() }).where(eq(schema.characterOutfits.id, Number(params.outfitAccessoryId)))
    await composeOutfitImage(Number(params.outfitAccessoryId))
  }
  if (params.outfitSheetId) {
    await db.update(schema.characterOutfits).set({ sheetImageUrl: localPath, status: 'ready', updatedAt: now() }).where(eq(schema.characterOutfits.id, Number(params.outfitSheetId)))
  }
}

/** 1122 服饰长图：上=平铺三视（image_url）、下=饰品网格（accessory_image_url），等宽拼接 → composed_image_url */
async function composeOutfitImage(outfitId: number) {
  try {
    const [o] = await db.select().from(schema.characterOutfits).where(eq(schema.characterOutfits.id, outfitId))
    if (!o?.imageUrl || !o?.accessoryImageUrl) return
    const gAbs = path.join(DATA_ROOT, o.imageUrl)
    const aAbs = path.join(DATA_ROOT, o.accessoryImageUrl)
    if (!fs.existsSync(gAbs) || !fs.existsSync(aAbs)) return
    const gMeta = await sharp(gAbs).metadata()
    const width = gMeta.width || 1920
    const gHeight = gMeta.height || 1080
    const accBuf = await sharp(aAbs).resize({ width }).png().toBuffer()
    const accMeta = await sharp(accBuf).metadata()
    const composed = await sharp({
      create: { width, height: gHeight + (accMeta.height || 640), channels: 3, background: '#ffffff' },
    }).composite([
      { input: gAbs, top: 0, left: 0 },
      { input: accBuf, top: gHeight, left: 0 },
    ]).png().toBuffer()
    const rel = `static/images/outfit_${outfitId}_${Date.now()}.png`
    const abs = path.join(DATA_ROOT, rel)
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, composed)
    // 1122：拼图也要出缩略图，否则列表用 _thumb.webp 会 404（页面图片不显示）
    await generateImageThumb(rel)
    await db.update(schema.characterOutfits).set({ composedImageUrl: rel, updatedAt: now() }).where(eq(schema.characterOutfits.id, outfitId))
  } catch (err: any) {
    logTaskError('ImageTask', 'outfit-compose', { outfitId, error: String(err?.message || err).slice(0, 160) })
  }
}

async function handleVideoComplete(record: SysTaskRecord, config: AIConfig, videoUrl: string, duration: number | null | undefined) {
  const localPath = await downloadFile(videoUrl, 'videos')
  // 1024 用户「先做minimax小脸修复…加到平台流程 然后用GPU」：comfyui 基片生成后跑一发小脸修复二采，
  // 成片替换基片。失败保留基片（不阻断任务）。**1025 用户「默认全开、不加开关」** ⇒ 不用再传 refine，
  // 显式 `refine:false` 才关（见 face-refine.ts 的 wantsFaceRefine）。
  let finalPath = localPath
  const params = parseTaskParams(record.params)
  // 1101 三采链（现在的生产默认图）自带 RIFE 补帧 + RTX VSR ×2，再叠平台这两道 = 白跑两遍（小脸二采还要换载）
  // ⇒ 走这张图时按 `upscale:false` 处理。1109 用户「加上小脸修复」：一条龙（native）的成品是固定口径
  // 2560×1472@48（1280×736 基帧 → RIFE ×2 → RelayVSR ×2），二采图已改成「取 24fps 基帧 → 修脸 → RIFE ×2
  // → RelayVSR ×2」自带后处理 ⇒ native 放行 refine，其它自带后处理的图（两采/三采/lock，画布 3072×1728）
  // 二采图口径对不上，仍按关处理。
  // 1107 有台词床时适配器缺省走锁音版三采链（同样自带补帧超分），判据要带上它。
  const hasBed = Array.isArray(params.referenceAudioUrls) && params.referenceAudioUrls.length > 0
  const nativeChain = effectiveGraph(params.graph, params.lora, hasBed) === PROD_GRAPH
  // [1116] Pika 小脸二采：`h3_pika_base24.json` 只出 24fps 0.9MP 基片（不接 VSR/RIFE），
  // 后续交给 face-refine 图（它自带修脸 + RIFE ×2 + RelayVSR ×2）。判据单列，避免动 native 那条。
  const pikaBase = String(params.graph || '') === 'h3_pika_base24.json'
  const post = record.provider === 'comfyui' && (isSelfContainedGraph(params.graph, params.lora, hasBed) || pikaBase)
    ? { ...params, refine: (nativeChain || pikaBase) ? params.refine : false, upscale: false }
    : params
  const wantRefine = wantsFaceRefine(record.provider, post)
  if (wantRefine && record.prompt) {
    const refined = await refineVideoFace({
      config,
      videoLocalPath: localPath,
      prompt: record.prompt,
      // 1109：桥的 job JSON 不回 `length`（`_job_json` 只给 id/status/file/url），poll 的 duration 恒为
      // DEFAULT_LENGTH/24 = 5.17 s ⇒ 用它会算出 124 帧，和一条龙基帧数（294/277…）对不上。
      // 基帧数 = 适配器提交时的 framesForDuration(record.duration)，这里用同一口径（params.duration）。
      length: framesForDuration(params.duration ?? duration),
      seed: params.seed ?? undefined,
    })
    if (refined) {
      finalPath = refined
      logTaskSuccess('VideoTask', 'face-refined', { id: record.id, base: localPath, refined })
    } else {
      logTaskWarn('VideoTask', 'face-refine-failed', { id: record.id, base: localPath })
    }
  }
  // 1025 用户「分辨率能在高点吗」：二采之后走 RTX VSR 硬件 ×2（1024×768 → 2048×1536，294 帧实测 29 s、
  // 跑 1 号卡）。合并端本来就把 1024 拉到 1920×1080（1.875× 双线性），先 ×2 再降采样才有真细节。
  // 失败保留上一版（不阻断任务）；显式 `upscale:false` 才关（同 wantsFaceRefine 的口子）。
  if (wantsUpscale(record.provider, post)) {
    const up = await upscaleVideoVSR(finalPath)
    if (up) {
      finalPath = up
      logTaskSuccess('VideoTask', 'vsr-upscaled', { id: record.id, base: localPath, upscaled: up })
    } else {
      logTaskWarn('VideoTask', 'vsr-upscale-skipped', { id: record.id, base: finalPath })
    }
  }
  // 1108 用户「画面有的时候会闪烁」：全局亮度跳变（实测 6 条片子 5 条有，RIFE/VSR 两条不同后处理链
  // 都有 ⇒ 生成侧的）。交付前压一道时域亮度归一；没有跳变的片子不重编码（检测 1.4 s，重编码 18 s/12 s 片）。
  if (record.provider === 'comfyui' && await deflickerVideo(finalPath)) {
    logTaskSuccess('VideoTask', 'deflickered', { id: record.id, localPath: finalPath })
  }
  // 海报帧供列表/封面展示，避免前端为显示首帧缓冲整个视频
  await extractVideoPoster(finalPath)
  await db.update(schema.sysTask)
    .set({ resultUrl: videoUrl, localPath: finalPath, status: 'completed', completedAt: now(), updatedAt: now() })
    .where(eq(schema.sysTask.id, record.id))

  logTaskSuccess('VideoTask', 'downloaded', { id: record.id, localPath: finalPath, storyboardId: record.storyboardId, duration })

  if (params.techniqueId) {
    // 1119 技能整条流程参考视频：写回 techniques.video_url
    await db.update(schema.techniques).set({ videoUrl: finalPath, status: 'ready', updatedAt: now() }).where(eq(schema.techniques.id, Number(params.techniqueId)))
  }
  if (record.storyboardId) {
    // 不要回写 duration：它是**创作意图**，同时是 length 的输入（comfyui-video.ts framesForDuration）。
    // 回写会自锁——生成 5.2s 就把「这条要拍 12s」改成 5.2s，下一轮按 5.2s 算 length，永久锁死 5.2s。
    // 实测：09-25 首轮拆解出的 12/12/12/12/8，在第一次渲染成功后全被覆写成 5.1667，此后再没出过 5 秒以上的片子。
    await db.update(schema.storyboards)
      .set({ videoUrl: finalPath, updatedAt: now() })
      .where(eq(schema.storyboards.id, record.storyboardId))
  }
}

// ─── 参考素材归一化 ───────────────────────────────────────────────

async function normalizeReferenceImages(refs: string[] | null | undefined): Promise<string[]> {
  if (!Array.isArray(refs) || !refs.length) return []

  const deduped = Array.from(
    new Set(
      refs
        .map((item) => String(item || '').trim())
        .filter(Boolean),
    ),
  )

  const normalized = await Promise.all(deduped.map(async (value) => {
    if (value.startsWith('data:image/')) return value
    if (value.startsWith('static/') || value.startsWith('/static/')) {
      const localPath = value.startsWith('/static/') ? value.slice(1) : value
      try {
        return await readImageAsCompressedDataUrl(localPath, {
          maxWidth: 768,
          maxHeight: 768,
          quality: 68,
        })
      } catch (err) {
        logTaskWarn('ImageTask', 'reference-read-failed', { path: localPath, error: (err as Error).message })
        return null
      }
    }
    // 远程 URL：下载压缩为 data URL，保证 multipart 上传（OpenAI edits）/ inline_data（Gemini）都可用
    if (/^https?:\/\//.test(value)) {
      try {
        return await fetchImageAsCompressedDataUrl(value, {
          maxWidth: 768,
          maxHeight: 768,
          quality: 68,
        })
      } catch (err) {
        logTaskWarn('ImageTask', 'reference-fetch-failed', { url: value, error: (err as Error).message })
        return null
      }
    }
    return value
  }))

  return normalized.filter((item): item is string => !!item).slice(0, 6)
}

/** 段间接力（连续拍）：取上一段成片的末帧。
 *  为什么是「参考图」而不是 first_frame：JZL ref2v 节点没有 first_frame 输入（输入表只有
 *  ref_image_0~8 / ref_video / ref_audio），fl2va 节点没有 ref 槽位 —— 两者互斥，实测一收到
 *  首帧就丢参考行、角色完全重生成（同一分镜两个人一个都不像）。带成参考图 = 保住身份，同时把
 *  上一段的光线/色调/构图落点喂进去（社区 Seamless Chain 的 memory bank 是这条的完整版，实测
 *  luma drift 1.055→1.022/hop、chroma 1.086→1.039）。
 *  前提：段按顺序跑（上一段已完成），否则返回 null 退回纯参考图。 */
async function relayContext(storyboardId?: number | null): Promise<{ source: string | null; prevId: number; sameScene: boolean; continuity: string } | null> {
  if (!storyboardId) return null
  const [cur] = await db.select({ episodeId: schema.storyboards.episodeId, n: schema.storyboards.storyboardNumber,
    sceneId: schema.storyboards.sceneId, continuity: schema.storyboards.continuity })
    .from(schema.storyboards).where(eq(schema.storyboards.id, storyboardId)).limit(1)
  if (!cur) return null
  const [prev] = await db.select({ id: schema.storyboards.id, videoUrl: schema.storyboards.videoUrl,
    sceneId: schema.storyboards.sceneId, continuity: schema.storyboards.continuity })
    .from(schema.storyboards).where(and(eq(schema.storyboards.episodeId, cur.episodeId), eq(schema.storyboards.storyboardNumber, cur.n - 1))).limit(1)
  if (!prev) return null
  // 用「这条分镜实际交付的成片」，不是 sys_task 里第一条 completed：重roll 过的段会取到旧片，
  // 接力帧就成了另一张构图（1003 A/B 实测：sb14 交付的是池景空镜，接力却取了早先的脸部特写）。
  const source = prev.videoUrl || (await db.select({ localPath: schema.sysTask.localPath }).from(schema.sysTask)
    .where(and(eq(schema.sysTask.storyboardId, prev.id), eq(schema.sysTask.type, 'video'), eq(schema.sysTask.status, 'completed'))).limit(1))[0]?.localPath
  if (!source) return null
  return { source, prevId: prev.id, sameScene: cur.sceneId === prev.sceneId, continuity: cur.continuity || 'same_shot' }
}

async function normalizeVideoReferenceUrl(value: string | null | undefined): Promise<string | null> {
  const raw = String(value || '').trim()
  if (!raw) return null
  if (raw.startsWith('data:image/')) return raw
  if (raw.startsWith('static/') || raw.startsWith('/static/')) {
    const localPath = raw.startsWith('/static/') ? raw.slice(1) : raw
    try {
      // 1115 用户「参考图不够高清？」：以前视频参考统一压到 768×768/q68，三视图落到 input/
      // 只有 768×439、每张脸 ~40–250 px，模型拿不到毛孔/五官细节 —— 这是近景蜡像感的硬顶。
      // 提到 1536/92：三视图原尺寸（1328×768）不再缩，脸部像素 ×4；本机桥走 data URL，体积无碍。
      return await readImageAsCompressedDataUrl(localPath, {
        maxWidth: 1536,
        maxHeight: 1536,
        quality: 92,
      })
    } catch (err) {
      logTaskWarn('VideoTask', 'reference-read-failed', { path: localPath, error: (err as Error).message })
      return null
    }
  }
  return raw
}

async function normalizeVideoReferenceUrls(refs: string[] | null | undefined): Promise<string[]> {
  if (!Array.isArray(refs) || !refs.length) return []
  const normalized = await Promise.all(
    Array.from(new Set(refs.map((item) => String(item || '').trim()).filter(Boolean))).map((item) => normalizeVideoReferenceUrl(item)),
  )
  return normalized.filter((item): item is string => !!item)
}

/**
 * 将参考视频/音频解析为 Seedance API 可访问的 URL。
 * http(s)/dataURL 直通；本地 static 路径需要 PUBLIC_BASE_URL 拼成公网地址，
 * 未配置时抛出可操作的中文错误（落入 catch 写入 error_msg 供前端展示）。
 */
function resolvePublicMediaUrl(value: string | null | undefined, kind: 'video' | 'audio' | 'file'): string | null {
  const raw = String(value || '').trim()
  if (!raw) return null
  if (raw.startsWith('http://') || raw.startsWith('https://') || raw.startsWith('data:')) return raw
  if (raw.startsWith('static/') || raw.startsWith('/static/')) {
    const base = (process.env.PUBLIC_BASE_URL || '').trim().replace(/\/+$/, '')
    if (!base) {
      const label = kind === 'video' ? '视频' : kind === 'audio' ? '音频' : '文件'
      throw new Error(
        `参考${label}为本地路径 ${raw}，但后端未配置 PUBLIC_BASE_URL，上游视频生成 API 无法访问内网地址。` +
        `请在 backend/.env 配置 PUBLIC_BASE_URL（如 https://your-domain.com）后重试，或改用公网 URL。`,
      )
    }
    const p = raw.startsWith('/') ? raw : `/${raw}`
    return `${base}${p}`
  }
  return raw
}

function resolvePublicMediaUrls(refs: string[] | null | undefined, kind: 'video' | 'audio'): string[] {
  if (!Array.isArray(refs) || !refs.length) return []
  const items = Array.from(new Set(refs.map((item) => String(item || '').trim()).filter(Boolean)))
  return items.map((item) => resolvePublicMediaUrl(item, kind)).filter((item): item is string => !!item)
}

function normalizeStoredVideoResolution(resolution: string | null | undefined): string | undefined {
  const value = String(resolution || '').trim().toLowerCase()
  if (value === '480p' || value === '720p' || value === '1080p') return value
  if (value === '2k') return '2K'
  // 1007 加：允许直接写画布（例 `1728x960`）。分辨率实验以前每加一档就要改一次适配器映射，
  // 现在只要改库里的 episodes.resolution 即可 —— 画布由 comfyui 适配器直接吃（节点自己会吸到 32 网格）。
  if (/^\d+x\d+$/.test(value)) return value
  return undefined
}
