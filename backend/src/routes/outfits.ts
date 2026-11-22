// 1122 服饰柜：角色 × 服饰（每套=参考图），可生成候选、出「角色×服饰」组合三视图；
// 分镜用 storyboard_outfits 记录换装点（缺省=继承上一镜，见 resolveOutfit）。
import fs from 'node:fs'
import path from 'node:path'
import sharp from 'sharp'
import { Hono } from 'hono'
import { eq, and, desc, isNull, inArray } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { DATA_ROOT } from '../utils/paths.js'
import { success, created, badRequest } from '../utils/response.js'
import { generateImage } from '../services/generation.js'
import { getDramaStylePrompt } from '../services/style-preset.js'
import { characterSheetDefaultPrompt } from '../services/character-sheet.js'
import { resolveOutfitUrl } from '../services/outfits.js'
import { now } from '../utils/response.js'

const app = new Hono()

/** 1122 组合三视图的「脸」参考：从角色肖像裁上 42% 的方图（只有脸+发，不带旧衣服），
 * 否则模型会把参考图 1 的旧衣服抄到左格特写里（沈砚/陆铮/赵老爷/苏父 4/5 实测中招）。 */
async function outfitFaceRef(ch: any): Promise<string | null> {
  const src = String(ch?.imageUrl || '')
  if (!src.startsWith('static/')) return null
  const abs = path.join(DATA_ROOT, src)
  if (!fs.existsSync(abs)) return null
  const rel = `static/images/faces/outfit_${ch.id}.jpg`
  const out = path.join(DATA_ROOT, rel)
  if (fs.existsSync(out)) return rel
  const meta = await sharp(abs).metadata()
  const w = meta.width || 832
  const h = meta.height || 1216
  const side = Math.round(Math.min(w, h * 0.42))
  const box = { left: Math.round((w - side) / 2), top: Math.round(h * 0.03), width: side, height: side }
  fs.mkdirSync(path.dirname(out), { recursive: true })
  await sharp(abs).extract(box).resize({ width: 768, height: 768, fit: 'inside' }).jpeg({ quality: 92 }).toFile(out)
  return rel
}

async function imageConfigId(prefer?: number) {
  return prefer
}

// 1122 实测：只写「素雅常服」这种两字标签，qwen 会几乎原样照抄参考图里的衣服（换了等于没换）。
// 每个 look 必须带款式/颜色/材质，并明说「不要沿用参考图中的衣服与背景」。
// 男女分开：appearance/description 里带「男性」的走男套（否则男角会被配上百褶裙）。
// 1122 用户「衣服性感点」：女角默认档改性感版（成年角色；薄纱/抹胸/露肩/收腰高开衩）
const DEFAULT_LOOKS_F = [
  '月白薄纱对襟长衫配素白抹胸和高腰长裙，露肩露锁骨，纱质轻透',
  '靛蓝紧身劲装，深 V 领、收腰、裙摆高开衩，勾勒曲线',
  '绛红织金抹胸礼服，露肩广袖、高开衩裙摆，金线刺绣',
  '玄黑贴身夜行衣，收腰包臀、薄纱长袖，露腰设计',
  '藕荷色薄纱外披配素白抹胸内衬，后背镂空、肩颈裸露',
  '正红织锦抹胸礼服，露背收腰、裙摆开衩，金线凤纹',
]
const DEFAULT_LOOKS_M = [
  '月白直裰长衫配青色布腰带与玉冠，棉麻质感',
  '玄色窄袖劲装配黑革腰封与长靴，利落肃杀',
  '石青织金锦袍配同色披风，丝绸质感',
  '深灰交领常服配布带与软底靴，素净',
  '墨黑夜行衣配皮质护腕与束发黑带',
  '绛紫锦缎长袍配白玉腰带与长穗',
]
function defaultLooks(ch: any) {
  const text = `${ch?.appearance || ''}${ch?.description || ''}`
  return /男性/.test(text) ? DEFAULT_LOOKS_M : DEFAULT_LOOKS_F
}

/** 本集出场角色 = episode_characters ∪ 本集分镜绑定的角色（episode_characters 常为空，分镜绑定才是实况） */
async function episodeCharacterIds(episodeId: number) {
  const ids = new Set<number>()
  for (const r of await db.select({ id: schema.episodeCharacters.characterId })
    .from(schema.episodeCharacters).where(eq(schema.episodeCharacters.episodeId, episodeId))) ids.add(r.id)
  const sbs = await db.select({ id: schema.storyboards.id }).from(schema.storyboards).where(eq(schema.storyboards.episodeId, episodeId))
  if (sbs.length) {
    for (const r of await db.select({ id: schema.storyboardCharacters.characterId })
      .from(schema.storyboardCharacters).where(inArray(schema.storyboardCharacters.storyboardId, sbs.map(s => s.id)))) ids.add(r.id)
  }
  return [...ids]
}

// 1122 用户定稿：**服饰资产 = 服饰三视图**（同一套衣服的正面/90°侧面/背面，隐形人台，画面里没有人）。
// 出片参考仍是「角色×服饰」组合三视图（见 generate-sheet），服饰三视图只当它的第二张参考。
// 所以候选生成**不带角色参考图** —— 带了 qwen 就会把人画进去（用户原话：视频小图不要显示人物）。
async function createCandidates(ch: any, count: number, looks: string[], body: any) {
  const stylePrompt = await getDramaStylePrompt(ch.dramaId)
  // 1122 实测：服饰三视图的「平铺、无人台/白膜」只有 MOSS 听话（qwen 无论怎么写都会画立式人台）。
  // 1122 用户「挪到 6006 出」：服饰 = MOSS config 8 (6006)；饰品网格/组合三视图 = qwen config 9 (6006)。
  const cfgId = await imageConfigId(body.config_id ?? 8)
  const ids: number[] = []
  for (let i = 0; i < count; i++) {
    const look = String(looks[i % looks.length])
    const ts = now()
    const res = await db.insert(schema.characterOutfits).values({
      characterId: ch.id, dramaId: ch.dramaId,
      name: `${ch.name}·${look.split('，')[0].slice(0, 20)}`,
      summary: look,
      status: 'processing',
      prompt: look,
      createdAt: ts, updatedAt: ts,
    })
    const outfitId = Number((res as any).lastInsertRowid ?? (res as any).insertId ?? 0)
    // 1122 用户定稿（拼图方案）：服饰图 = 上（MOSS 横版平铺三视、无人台）+ 下（qwen 饰品网格、每行≤3）自动拼接。
    // 竖版直接出会把人台画回来，所以拆两张、后端 composeOutfitImage 拼成长图。
    // 1122 用户「纯粹的衣服、多角度、不要模型」：**不要写 360 度**——模型会把 360 读成真人环绕图
    // （两次实测都画成四个真人）；改成「四角度摆开的衣服产品图」+ ghost mannequin 才是纯衣服。
    const garmentPrompt = `${stylePrompt ? stylePrompt + '，' : ''}服饰设定图，纯白背景，柔和均匀的光线。画面里是**纯粹的衣服本身**，同一件衣服的四个角度依次摆开：正面、90 度左侧、背面、90 度右侧；衣服悬空立体成型（ghost mannequin 效果），有垂坠和体积感（不是平铺），完整可见不裁切。看不到任何衣架、人台、模特、支撑物、人体或人物，也没有皮肤。${look}。`
    const genId = await generateImage({
      characterId: undefined as any,
      dramaId: ch.dramaId,
      prompt: garmentPrompt,
      model: body.model,
      size: body.size || '1920x1080',
      // qwen 适配器会缩到 1344x768；服饰图允许更高预算（MOSS 适配器按原尺寸走）
      maxPixels: 1920 * 1080,
      configId: cfgId,
      outfitId,
    })
    ids.push(genId)
    // 饰品网格单独一张（qwen 6006）：**只画小物件**——1122 实测写「与这套服装相配」会把 6 个格子画成迷你服装照，
    // 必须明写「画面里没有任何衣服/裙子/外套」。
    const accessoryPrompt = `纯白背景的六个独立小格（2 行 3 列），逐格内容固定：第一行=发簪、发簪、耳坠；第二行=玉佩、项链、香囊。每格只放那一件首饰，背景纯白、格内除首饰外空无一物，特写清晰、彼此分开、间距均匀；配色为红金。六格全部只放首饰小件，**任何一格都不许出现布料、衣服局部、裙子、袍子、外套或人物**。`
    const accId = await generateImage({
      characterId: undefined as any,
      dramaId: ch.dramaId,
      prompt: accessoryPrompt,
      model: body.model,
      size: '1536x1024',
      maxPixels: 1536 * 1024,
      configId: 9,
      outfitAccessoryId: outfitId,
    })
    ids.push(accId)
  }
  return ids
}

app.get('/', async (c) => {
  // drama_id：剧集详情页「素材库 → 服饰」用 —— 全剧角色的服饰，带 char_name
  const dramaId = Number(c.req.query('drama_id') || 0)
  if (dramaId) {
    const rows = await db.select({
      outfit: schema.characterOutfits,
      charName: schema.characters.name,
    })
      .from(schema.characterOutfits)
      .innerJoin(schema.characters, eq(schema.characters.id, schema.characterOutfits.characterId))
      .where(and(eq(schema.characterOutfits.dramaId, dramaId), isNull(schema.characterOutfits.deletedAt)))
      .orderBy(desc(schema.characterOutfits.id))
    return success(c, rows.map(r => ({ ...r.outfit, char_name: r.charName })))
  }
  // episode_id：本集出场角色的全部服饰，带 char_name
  const episodeId = Number(c.req.query('episode_id') || 0)
  if (episodeId) {
    const out: any[] = []
    for (const id of await episodeCharacterIds(episodeId)) {
      const [ch] = await db.select().from(schema.characters).where(eq(schema.characters.id, id))
      if (!ch) continue
      const rows = await db.select().from(schema.characterOutfits)
        .where(and(eq(schema.characterOutfits.characterId, id), isNull(schema.characterOutfits.deletedAt)))
        .orderBy(desc(schema.characterOutfits.id))
      out.push(...rows.map(o => ({ ...o, char_name: ch.name })))
    }
    return success(c, out)
  }
  const characterId = Number(c.req.query('character_id') || 0)
  if (!characterId) return badRequest(c, 'character_id 必填')
  const rows = await db.select().from(schema.characterOutfits)
    .where(and(eq(schema.characterOutfits.characterId, characterId), isNull(schema.characterOutfits.deletedAt)))
    .orderBy(desc(schema.characterOutfits.id))
  return success(c, rows)
})

// POST /outfits —— 手工建一套（可带 image_url）
app.post('/', async (c) => {
  const body = await c.req.json()
  if (!body.character_id) return badRequest(c, 'character_id 必填')
  const [ch] = await db.select().from(schema.characters).where(eq(schema.characters.id, Number(body.character_id)))
  if (!ch) return badRequest(c, '角色不存在')
  const ts = now()
  const res = await db.insert(schema.characterOutfits).values({
    characterId: ch.id, dramaId: ch.dramaId,
    name: String(body.name || '服饰').slice(0, 60),
    summary: body.summary || null,
    imageUrl: body.image_url || null,
    status: body.image_url ? 'ready' : 'candidate',
    createdAt: ts, updatedAt: ts,
  })
  const [row] = await db.select().from(schema.characterOutfits).where(eq(schema.characterOutfits.id, Number((res as any).lastInsertRowid ?? (res as any).insertId ?? 0)))
  return created(c, row ?? null)
})

app.put('/:id', async (c) => {
  const id = Number(c.req.param('id'))
  const body = await c.req.json()
  const [o] = await db.select().from(schema.characterOutfits).where(eq(schema.characterOutfits.id, id))
  if (!o) return badRequest(c, '服饰不存在')
  const patch: Record<string, any> = { updatedAt: now() }
  if ('name' in body) patch.name = String(body.name).slice(0, 60)
  if ('summary' in body) patch.summary = body.summary
  if ('image_url' in body) { patch.imageUrl = body.image_url; patch.status = body.image_url ? 'ready' : o.status }
  if ('status' in body) patch.status = body.status
  await db.update(schema.characterOutfits).set(patch).where(eq(schema.characterOutfits.id, id))
  return success(c)
})

app.delete('/:id', async (c) => {
  const id = Number(c.req.param('id'))
  await db.update(schema.characterOutfits).set({ deletedAt: now(), updatedAt: now() }).where(eq(schema.characterOutfits.id, id))
  await db.delete(schema.storyboardOutfits).where(eq(schema.storyboardOutfits.outfitId, id))
  return success(c)
})

// POST /outfits/generate —— 按角色批量出服饰候选（qwen 带角色参考，脸不漂）
app.post('/generate', async (c) => {
  const body = await c.req.json()
  const characterId = Number(body.character_id)
  const count = Math.min(Math.max(Number(body.count || 3), 1), 6)
  if (!characterId) return badRequest(c, 'character_id 必填')
  const [ch] = await db.select().from(schema.characters).where(eq(schema.characters.id, characterId))
  if (!ch) return badRequest(c, '角色不存在')
  const looks = Array.isArray(body.looks) && body.looks.length ? body.looks : defaultLooks(ch)
  const ids = await createCandidates(ch, count, looks, body)
  return created(c, { count: ids.length, ids })
})

// POST /outfits/generate-episode —— 「每集先出服饰」：本集全部角色各出 N 套
app.post('/generate-episode', async (c) => {
  const body = await c.req.json()
  const episodeId = Number(body.episode_id)
  const count = Math.min(Math.max(Number(body.count || 3), 1), 6)
  if (!episodeId) return badRequest(c, 'episode_id 必填')
  const charIds = await episodeCharacterIds(episodeId)
  const looksOverride = Array.isArray(body.looks) && body.looks.length ? body.looks : null
  const ids: number[] = []
  for (const id of charIds) {
    const [ch] = await db.select().from(schema.characters).where(eq(schema.characters.id, id))
    if (!ch) continue
    ids.push(...await createCandidates(ch, count, looksOverride || defaultLooks(ch), body))
  }
  return created(c, { characters: charIds.length, count: ids.length, ids })
})

// GET /outfits/shot?storyboard_id= —— 本镜各角色的服饰选项与解析结果（继承链）
app.get('/shot', async (c) => {
  const storyboardId = Number(c.req.query('storyboard_id') || 0)
  if (!storyboardId) return badRequest(c, 'storyboard_id 必填')
  const bound = await db.select({ id: schema.storyboardCharacters.characterId })
    .from(schema.storyboardCharacters).where(eq(schema.storyboardCharacters.storyboardId, storyboardId))
  const items: any[] = []
  for (const b of bound) {
    const [ch] = await db.select().from(schema.characters).where(eq(schema.characters.id, b.id))
    if (!ch) continue
    const outfits = await db.select().from(schema.characterOutfits)
      .where(and(eq(schema.characterOutfits.characterId, ch.id), isNull(schema.characterOutfits.deletedAt)))
      .orderBy(desc(schema.characterOutfits.id))
    const [explicit] = await db.select().from(schema.storyboardOutfits)
      .where(and(eq(schema.storyboardOutfits.storyboardId, storyboardId), eq(schema.storyboardOutfits.characterId, ch.id)))
    const resolvedUrl = await resolveOutfitUrl(ch.id, storyboardId)
    const resolved = resolvedUrl ? outfits.find(o => (o.sheetImageUrl || o.imageUrl) === resolvedUrl) : null
    items.push({
      character_id: ch.id,
      name: ch.name,
      outfits,
      bound_outfit_id: explicit?.outfitId ?? null,
      resolved_outfit_id: resolved?.id ?? null,
      resolved_name: resolved?.name ?? null,
    })
  }
  return success(c, items)
})

// POST /outfits/:id/generate-sheet —— 角色 + 这套服饰 → 组合三视图（双参考）
app.post('/:id/generate-sheet', async (c) => {
  const id = Number(c.req.param('id'))
  const body = await c.req.json().catch(() => ({}))
  const [o] = await db.select().from(schema.characterOutfits).where(eq(schema.characterOutfits.id, id))
  if (!o) return badRequest(c, '服饰不存在')
  const [ch] = await db.select().from(schema.characters).where(eq(schema.characters.id, o.characterId))
  if (!ch) return badRequest(c, '角色不存在')
  const stylePrompt = await getDramaStylePrompt(o.dramaId)
  const cfgId = await imageConfigId(body.config_id ?? 9)
  const refs: string[] = []
  const face = await outfitFaceRef(ch)
  if (face) refs.push(face)
  else if (ch.imageUrl) refs.push(ch.imageUrl)
  if (o.imageUrl) refs.push(o.imageUrl)
  // 版式句与角色三视图共用同一份骨架（左侧正脸特写 + 右侧三张全身，纯白底）——脸特写裁切也依赖这个版式
  const skeleton = characterSheetDefaultPrompt(stylePrompt, true)
  // 1122 实测：只写「照角色图/照服饰图」时，左格脸特写会照抄角色参考图的旧衣服（红裙那张的特写是米色裙）——
  // 同一张参考图里两套衣服会打架，H3 出片会飘。必须明说特写也只穿第二张的服装、第一张只管脸。
  const prompt = `${skeleton}。第一张参考图**只有脸和发型**（不含任何服装），只提供本角色的脸型、五官、发型与妆容；第二张参考图提供整套服装的款式、颜色与材质。左侧正脸特写与右侧三张全身视图必须穿同一套第二张参考图里的服装（特写里也不要出现任何其他衣服），脸与发型和第一张参考图是同一个人。`
  const genId = await generateImage({
    dramaId: o.dramaId,
    prompt,
    model: body.model,
    size: body.size || '1920x1080',
    maxPixels: 1920 * 1080,
    referenceImages: refs,
    configId: cfgId,
    outfitSheetId: id,
  })
  return created(c, { image_generation_id: genId })
})

// POST /outfits/bind —— 分镜换装点（outfit_id 为空=删除该镜的绑定，回落到继承）
app.post('/bind', async (c) => {
  const body = await c.req.json()
  const storyboardId = Number(body.storyboard_id)
  const characterId = Number(body.character_id)
  if (!storyboardId || !characterId) return badRequest(c, 'storyboard_id / character_id 必填')
  if (!body.outfit_id) {
    await db.delete(schema.storyboardOutfits).where(and(
      eq(schema.storyboardOutfits.storyboardId, storyboardId),
      eq(schema.storyboardOutfits.characterId, characterId),
    ))
    return success(c)
  }
  await db.delete(schema.storyboardOutfits).where(and(
    eq(schema.storyboardOutfits.storyboardId, storyboardId),
    eq(schema.storyboardOutfits.characterId, characterId),
  ))
  await db.insert(schema.storyboardOutfits).values({
    storyboardId, characterId, outfitId: Number(body.outfit_id), createdAt: now(),
  })
  return success(c)
})

export default app
