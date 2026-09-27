import { Hono } from 'hono'
import { and, eq } from 'drizzle-orm'
import { db, getInsertId, schema } from '../db/index.js'
import { success, created, badRequest, now } from '../utils/response.js'
import { toSnakeCase } from '../utils/transform.js'
import { generateImage } from '../services/generation.js'
import { getDramaStylePrompt } from '../services/style-preset.js'
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
 * 三视图骨架句 —— 与 workspace/skills/prompt-generator/character-prompt/SKILL.md 的
 * 「输出结构」一致（那份是给 agent 看的规范，这里是空框生成时的兜底，两边改动要同步）。
 * 只取骨架句，模板里的 [槽位] 不搬 —— 槽位的活由 char.appearance / char.styling 拼。
 */
const SHEET_SKELETON_WITH_REF = [
  '以参考图中的同一人物为准，脸型、五官、发型、肤色、妆容、服装与配饰一律照参考图原样保留，只改变角度与构图',
  '角色设定参考图，左侧为正脸特写，右侧并列展示正面、90 度侧面、背面三张等高全身视图',
  '特写与全身视图都是同一角色，全身入镜，中性 A 字站姿，三张全身视图等高并排、头顶脚底对齐',
  '正脸特写与三个视图的脸、发型和服装完全一致，妆容与配饰同样一致，且与参考图是同一人',
  '纯白背景，柔和均匀的光线，电影质感',
].join('，')

const SHEET_SKELETON_TEXT_ONLY = [
  '角色设定参考图，左侧为正脸特写，右侧并列展示正面、90 度侧面、背面三张等高全身视图',
  '特写与全身视图都是同一角色，全身入镜，中性 A 字站姿，三张全身视图等高并排、头顶脚底对齐',
  '正脸特写与三个视图的脸、发型和服装完全一致，妆容与配饰同样一致',
  '纯白背景，柔和均匀的光线，电影质感',
].join('，')

/**
 * 用户没写时的内容兜底 —— 老 characterImagePrompt() 那串原样保留（骨架不在这里，见 characterImagePrompt）。
 * 空字段不拼（filter(Boolean)）；兜底只影响这一次生成，不写库 —— 框里还是空的。
 */
function characterFallbackContent(char: typeof schema.characters.$inferSelect) {
  return [
    char.name,
    char.appearance || char.description || '人物立绘',
    char.styling || '',
    '16:9 横版角色定妆照',
    '半身角色海报构图',
    '正面',
    '高质量',
    '白色背景',
  ].filter(Boolean).join(', ')
}

/**
 * 生图提示词 = 项目视觉风格 + 正文 + 三视图骨架。
 * 正文完全由用户决定（详情页那个文本框）：草稿优先、其次库里存的，没写才落到老版式兜底。
 * 骨架是产品保证的版式，与「提示词优化」无关（优化只管用户那段字的内容）——不管用户写没写都追加，
 * 否则用户一写字版式就没了，出图不再是三视图。
 */
function characterImagePrompt(stylePrompt: string, userPrompt: string | null | undefined, char: typeof schema.characters.$inferSelect) {
  const content = (userPrompt || '').trim() || characterFallbackContent(char)
  return [stylePrompt || '', content, char.imageUrl ? SHEET_SKELETON_WITH_REF : SHEET_SKELETON_TEXT_ONLY].filter(Boolean).join(', ')
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

  // 详情页传来的 prompt 就是框里当前的字（含没保存的草稿）；显式传了空串也照收（用户把框清空了）。
  // 只有字段缺席（面板没开）才回落到库里存的
  const stylePrompt = await getDramaStylePrompt(char.dramaId)
  const prompt = characterImagePrompt(stylePrompt, typeof body.prompt === 'string' ? body.prompt : char.finalPrompt, char)
  try {
    logTaskStart('CharacterImage', 'generate', { characterId: id, episodeId: ep.id, dramaId: char.dramaId })
    const genId = await generateImage({ characterId: id, dramaId: char.dramaId, prompt, model: body.model, size: CHARACTER_IMAGE_SIZE, configId: body.config_id ?? ep.imageConfigId ?? undefined, referenceImages: char.imageUrl ? [char.imageUrl] : undefined })
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
      const genId = await generateImage({ characterId: cid, dramaId: char.dramaId, prompt, model: body.model, size: CHARACTER_IMAGE_SIZE, configId: body.config_id ?? ep.imageConfigId ?? undefined, referenceImages: char.imageUrl ? [char.imageUrl] : undefined })
      results.push(genId)
    } catch {}
  }
  logTaskSuccess('CharacterImage', 'batch-generate', { episodeId: ep.id, requested: ids.length, started: results.length })
  return success(c, { count: results.length, ids: results })
})

export default app
