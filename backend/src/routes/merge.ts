import { Hono } from 'hono'
import { and, eq, isNull } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { success, badRequest } from '../utils/response.js'
import { mergeEpisodeVideos } from '../services/ffmpeg-merge.js'
import { toSnakeCase } from '../utils/transform.js'
import { logTaskError, logTaskStart, logTaskSuccess } from '../utils/task-logger.js'

const app = new Hono()

// POST /episodes/:id/merge — 拼接镜头视频(body.storyboard_ids 可选,只拼所选;
//   body.interpolate_fps="60" 走 NVIDIA DLSS 补帧、body.upscale="seedvr2" 走 ComfyUI core 的 SeedVR2 修复，
//   两个都默认关 —— 见 services/comfyui-dlss.ts 与 services/comfyui-seedvr.ts)
app.post('/episodes/:id/merge', async (c) => {
  const episodeId = Number(c.req.param('id'))
  const [ep] = await db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId))
  if (!ep) return badRequest(c, '剧集不存在')

  let storyboardIds: number[] | undefined
  let interpolateFps: string | undefined
  let upscaleMode: string | undefined
  let upscaleFactor: number | undefined
  let inputSize: string | undefined
  try {
    const body = await c.req.json()
    if (Array.isArray(body?.storyboard_ids)) {
      storyboardIds = body.storyboard_ids.map(Number).filter(Boolean)
    }
    if (body?.interpolate_fps) interpolateFps = String(body.interpolate_fps).trim()
    if (body?.upscale) upscaleMode = String(body.upscale).trim()
    // 1008：倍率也要能走请求体（`upscale` 是 Int，只有 ×1/×2/×3/×4）。×1 是 8 GB 上唯一跑得完
    // 362 帧的形态（×2 = 20.9 s/帧 ⇒ 2.1 h/条，而且 2944×1664×362 帧的 fp32 批要 26.8 GB 内存）。
    if (body?.upscale_factor) upscaleFactor = Number(body.upscale_factor)
    // 1009：`input_size` = 喂给模型的尺寸（VOSR2 那条）。1k→2k 的走法 = `input_size=1280x720` +
    // `upscale_factor=2` → 直出 2560x1440；成本 ∝ 模型工作的像素（台账 §二十四）。
    if (body?.input_size) inputSize = String(body.input_size).trim()
  } catch { /* 无 body 时拼接全部 */ }

  try {
    logTaskStart('MergeAPI', 'episode-merge', { episodeId, dramaId: ep.dramaId, storyboardIds, interpolateFps, upscaleMode, upscaleFactor, inputSize })
    const mergeId = await mergeEpisodeVideos(
      episodeId, ep.dramaId, storyboardIds,
      (interpolateFps || upscaleMode) ? { interpolateFps, upscale: upscaleMode, upscaleFactor, inputSize } : undefined,
    )
    logTaskSuccess('MergeAPI', 'episode-merge', { episodeId, mergeId })
    return success(c, { merge_id: mergeId, status: 'processing' })
  } catch (err: any) {
    logTaskError('MergeAPI', 'episode-merge', { episodeId, error: err.message })
    return badRequest(c, err.message)
  }
})

// GET /episodes/:id/merge — 查询最新拼接状态
app.get('/episodes/:id/merge', async (c) => {
  const episodeId = Number(c.req.param('id'))
  const merges = await db.select().from(schema.videoMerges)
    .where(eq(schema.videoMerges.episodeId, episodeId))


  const latest = merges[merges.length - 1]
  if (!latest) return success(c, null)

  return success(c, toSnakeCase(latest))
})

// GET /episodes/:id/merges — 成片列表(全部拼接记录,新的在前)
app.get('/episodes/:id/merges', async (c) => {
  const episodeId = Number(c.req.param('id'))
  const merges = await db.select().from(schema.videoMerges)
    .where(and(eq(schema.videoMerges.episodeId, episodeId), isNull(schema.videoMerges.deletedAt)))
  merges.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''))
  return success(c, merges.slice(0, 30).map(toSnakeCase))
})

export default app
