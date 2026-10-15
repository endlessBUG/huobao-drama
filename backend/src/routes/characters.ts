import { Hono } from 'hono'
import { and, eq } from 'drizzle-orm'
import { db, getInsertId, schema } from '../db/index.js'
import { success, created, badRequest, now } from '../utils/response.js'
import { toSnakeCase } from '../utils/transform.js'
import { generateImage } from '../services/generation.js'
import { getDramaStylePrompt } from '../services/style-preset.js'
import { characterSheetDefaultPrompt } from '../services/character-sheet.js'
import { logTaskError, logTaskStart, logTaskSuccess } from '../utils/task-logger.js'

const app = new Hono()
const CHARACTER_IMAGE_SIZE = '1920x1080'

// POST /characters — 手动新增角色（传入 episode_id 时关联到该集）
app.post('/', async (c) => {
  const body = await c.req.json()
  if (!body.drama_id) return badRequest(c, 'drama_id 必填')
  if (!body.name?.trim()) return badRequest(c, '名称必填')
  const ts = now()
  const res = await db.insert(schema.characters).values({
    name: body.name.trim(),
    role: body.role || '',
    description: body.description || '',
    appearance: body.appearance || '',
    styling: body.styling || '',
    dramaId: body.drama_id,
    createdAt: ts,
    updatedAt: ts,
  })
  const charId = getInsertId(res)
  if (body.episode_id) {
    const existing = await db.select().from(schema.episodeCharacters)
      .where(and(eq(schema.episodeCharacters.episodeId, Number(body.episode_id)), eq(schema.episodeCharacters.characterId, charId)))
    if (!existing.length) {
      await db.insert(schema.episodeCharacters).values({ episodeId: Number(body.episode_id), characterId: charId, createdAt: ts })
    }
  }
  const [row] = await db.select().from(schema.characters).where(eq(schema.characters.id, charId))
  return created(c, toSnakeCase(row))
})

/**
 * 最终提示词 = **框里那串字本身**（1016 改版：「最终提示词」名副其实，框里显示的就是发出去的）。
 * 用户改了、删了都以框里为准，后端不再往后面追加骨架 —— 否则框里看得见的版式和后端偷偷补的那份会撞成两遍。
 * 只有框空着（从没写过、也没编辑过）才回落到默认：风格 + 骨架。
 * 正文永远由用户决定：草稿优先、其次库里存的，不拿 appearance/styling 拼兜底、不让 Agent 代笔。
 */
function characterImagePrompt(stylePrompt: string, userPrompt: string | null | undefined, char: typeof schema.characters.$inferSelect) {
  const content = (userPrompt || '').trim()
  return content || characterSheetDefaultPrompt(stylePrompt, !!char.localPath)
}

/**
 * 角色图的参考图 = **用户上传的原图**（localPath），不是上一轮生成的产物（imageUrl）。
 * 生图回写只写 imageUrl（见 generation.ts 的 writeBackImageAssets），所以 localPath 永远停在用户自己给的那张。
 * 用 imageUrl 会自我锁死：骨架句要求「服装与配饰一律照参考图原样保留」，参考图又是上一轮产物
 * → 第一版生成成什么样就永远照抄，用户改提示词也换不掉服装（实测 styling 写着要求，三轮下来三视图仍是第一版那身）。
 * 没上传就不给参考图、走纯文生图 —— 与「没写就是空」同一口径，不拿 imageUrl 兜底。
 */
function referenceImageFor(char: typeof schema.characters.$inferSelect) {
  return char.localPath ? [char.localPath] : undefined
}

// PUT /characters/:id
app.put('/:id', async (c) => {
  const id = Number(c.req.param('id'))
  const body = await c.req.json()
  const updates: Record<string, any> = { updatedAt: now() }
  for (const key of ['name', 'role', 'description', 'appearance', 'styling', 'imageUrl', 'localPath']) {
    const snakeKey = key.replace(/[A-Z]/g, m => '_' + m.toLowerCase())
    if (snakeKey in body) updates[key] = body[snakeKey]
    else if (key in body) updates[key] = body[key]
  }
  // 手动编辑最终提示词时以传入值为准；未传入则保留原值（修改信息时不再自动置空）
  if (body.final_prompt !== undefined) updates.finalPrompt = body.final_prompt || null
  else if (body.finalPrompt !== undefined) updates.finalPrompt = body.finalPrompt || null
  await db.update(schema.characters).set(updates).where(eq(schema.characters.id, id))
  return success(c)
})

// DELETE /characters/:id
app.delete('/:id', async (c) => {
  const id = Number(c.req.param('id'))
  await db.update(schema.characters).set({ deletedAt: now() }).where(eq(schema.characters.id, id))
  return success(c)
})

// POST /characters/:id/generate-image
app.post('/:id/generate-image', async (c) => {
  const id = Number(c.req.param('id'))
  const body = await c.req.json()
  const [char] = await db.select().from(schema.characters).where(eq(schema.characters.id, id))
  if (!char) return badRequest(c, '角色不存在')
  if (!body.episode_id) return badRequest(c, 'episode_id 必填')

  const [ep] = await db.select().from(schema.episodes).where(eq(schema.episodes.id, Number(body.episode_id)))
  if (!ep) return badRequest(c, '剧集不存在')

  // 详情页传来的 prompt 就是框里当前的字（含没保存的草稿）；空串照收 —— 空框 = 用默认（风格 + 骨架）。
  // 只有字段缺席（面板没开）才回落到库里存的
  const stylePrompt = await getDramaStylePrompt(char.dramaId)
  const prompt = characterImagePrompt(stylePrompt, typeof body.prompt === 'string' ? body.prompt : char.finalPrompt, char)
  try {
    logTaskStart('CharacterImage', 'generate', { characterId: id, episodeId: ep.id, dramaId: char.dramaId })
    const genId = await generateImage({ characterId: id, dramaId: char.dramaId, prompt, model: body.model, size: CHARACTER_IMAGE_SIZE, configId: body.config_id ?? ep.imageConfigId ?? undefined, referenceImages: referenceImageFor(char) })
    logTaskSuccess('CharacterImage', 'generate', { characterId: id, generationId: genId })
    return success(c, { image_generation_id: genId })
  } catch (err: any) {
    logTaskError('CharacterImage', 'generate', { characterId: id, error: err.message })
    return badRequest(c, err.message)
  }
})

// POST /characters/batch-generate-images
app.post('/batch-generate-images', async (c) => {
  const body = await c.req.json()
  const ids: number[] = body.character_ids || []
  if (!body.episode_id) return badRequest(c, 'episode_id 必填')
  const [ep] = await db.select().from(schema.episodes).where(eq(schema.episodes.id, Number(body.episode_id)))
  if (!ep) return badRequest(c, '剧集不存在')
  const results: number[] = []
  const stylePrompt = await getDramaStylePrompt(ep.dramaId)
  for (const cid of ids) {
    const [char] = await db.select().from(schema.characters).where(eq(schema.characters.id, cid))
    if (!char) continue
    const prompt = characterImagePrompt(stylePrompt, char.finalPrompt, char)
    try {
      const genId = await generateImage({ characterId: cid, dramaId: char.dramaId, prompt, model: body.model, size: CHARACTER_IMAGE_SIZE, configId: body.config_id ?? ep.imageConfigId ?? undefined, referenceImages: referenceImageFor(char) })
      results.push(genId)
    } catch {}
  }
  logTaskSuccess('CharacterImage', 'batch-generate', { episodeId: ep.id, requested: ids.length, started: results.length })
  return success(c, { count: results.length, ids: results })
})

export default app
