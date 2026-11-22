/**
 * 技能（招式/特效）资产 — 1119 用户「增加技能模块 和角色一样分为全局和镜头」。
 * 与 props 同一套模式：剧级（episode_id 为空）或集级（episode_id 非空）；
 * 资产图 = 4×4 动作分解参考表（社区验证过的动作/特效锚图），出片时作为参考图槽。
 * 注意：`/skills` 已是 Agent 技能管理路由，这里内部名 techniques，UI 文案仍叫「技能」。
 */
import { Hono } from 'hono'
import { and, eq, isNull, sql } from 'drizzle-orm'
import fs from 'node:fs'
import path from 'node:path'
import { db, getInsertId, schema } from '../db/index.js'
import { success, created, badRequest, now } from '../utils/response.js'
import { toSnakeCase, toSnakeCaseArray } from '../utils/transform.js'
import { generateImage, generateVideo } from '../services/generation.js'
import { getDramaStylePrompt } from '../services/style-preset.js'
import { logTaskError, logTaskStart, logTaskSuccess } from '../utils/task-logger.js'
import { DATA_ROOT } from '../utils/paths.js'

const app = new Hono()
const SHEET_SIZE = '1920x1080'
const FFMPEG = process.env.HUOBAO_FFMPEG || 'E:/AI/ffmpeg-9.0.2-essentials_build/bin/ffmpeg.exe'

/** 分解表骨架：简单 2×2 / 中等 3×3 / 复杂 4×4（1119 用户「简单2*2 中等3*3 复杂4*4」） */
function sheetPrompt(stylePrompt: string, name: string, summary: string, grid: string) {
  const g = grid === '2x2' ? '2x2' : grid === '3x3' ? '3x3' : '4x4'
  const base = [
    '修仙级特效分解设定图，电影概念设定图质感，电影级体积光，仙侠大片气势',
    `技能：${name}${summary ? '。' + summary : ''}`,
    '主体：白色无贴图人体模型（白模，无五官、无发色、无服饰花纹），只表现招式姿态；兵器与光效保留颜色',
  ]
  const layouts: Record<string, string[]> = {
    '2x2': [
      '版式：2×2 共 4 格，等尺寸面板，细黑分隔线，每格左上角标编号 1–4',
      '四格内容：①起手蓄力（法阵亮起、灵气入体）②释放（巨型剑气离体）③命中（地面熔裂、碎石环爆）④余波收招（光效渐熄、尘雾沉降）',
    ],
    '3x3': [
      '版式：3×3 共 9 格，等尺寸面板，细黑分隔线，每格左上角标编号 1–9',
      '九格内容：①起手蓄力 ②释放 ③剑气飞行 ④命中 ⑤地面与气浪反应 ⑥天地异象（光柱/雷弧）⑦核心光效特写 ⑧飞溅粒子特写 ⑨余波收招',
    ],
    '4x4': [
      '版式：4×4 共 16 格，按四个横向区块组织，每区 4 格，细黑分隔线，每格左上角标编号 1–16',
      '第 1 区动作关键帧：蓄力 → 出招 → 命中 → 余波；第 2 区光效分层：核心发光体 / 拖尾轨迹 / 飞溅粒子 / 环境反馈；',
      '第 3 区四视角：正面 / 侧面 / 俯视 / 主观低角度；第 4 区强度四档：微弱 / 常规 / 强力 / 爆发',
    ],
  }
  return [...base, ...layouts[g], '格内细箭头标动作与光效流向；纯净浅灰背景，柔光棚拍', stylePrompt || ''].filter(Boolean).join('，')
}

// GET /techniques?drama_id=&episode_id= — 列表（剧级全局 + 指定集）
app.get('/', async (c) => {
  const dramaId = Number(c.req.query('drama_id') || 0)
  const episodeId = Number(c.req.query('episode_id') || 0)
  if (!dramaId) return badRequest(c, 'drama_id 必填')
  const cond = episodeId
    ? and(eq(schema.techniques.dramaId, dramaId), isNull(schema.techniques.deletedAt), sql`(${schema.techniques.episodeId} IS NULL OR ${schema.techniques.episodeId} = ${episodeId})`)
    : and(eq(schema.techniques.dramaId, dramaId), isNull(schema.techniques.deletedAt))
  const rows = await db.select().from(schema.techniques).where(cond)
  return success(c, toSnakeCaseArray(rows).map((r: any) => ({ ...r, scope: r.episode_id ? 'episode' : 'global' })))
})

// POST /techniques — 新建（episode_id 空 = 全局）
app.post('/', async (c) => {
  const body = await c.req.json()
  if (!body.drama_id) return badRequest(c, 'drama_id 必填')
  if (!body.name?.trim()) return badRequest(c, '名称必填')
  const ts = now()
  const res = await db.insert(schema.techniques).values({
    dramaId: Number(body.drama_id),
    episodeId: body.episode_id ? Number(body.episode_id) : null,
    name: body.name.trim(),
    kind: body.kind || 'move',
    summary: body.summary || '',
    prompt: body.prompt || '',
    source: body.source || 'manual',
    status: body.status || 'pending',
    grid: body.grid || '4x4',
    createdAt: ts,
    updatedAt: ts,
  })
  const [row] = await db.select().from(schema.techniques).where(eq(schema.techniques.id, getInsertId(res)))
  return created(c, toSnakeCase(row))
})

// PUT /techniques/:id
app.put('/:id', async (c) => {
  const id = Number(c.req.param('id'))
  const body = await c.req.json()
  const updates: Record<string, any> = { updatedAt: now() }
  if (body.name !== undefined) updates.name = body.name
  if (body.kind !== undefined) updates.kind = body.kind
  if (body.summary !== undefined) updates.summary = body.summary
  if (body.prompt !== undefined) updates.prompt = body.prompt
  if (body.image_url !== undefined) updates.imageUrl = body.image_url
  if (body.status !== undefined) updates.status = body.status
  if (body.grid !== undefined) updates.grid = body.grid
  if (body.episode_id !== undefined) updates.episodeId = body.episode_id || null
  await db.update(schema.techniques).set(updates).where(eq(schema.techniques.id, id))
  return success(c)
})

// DELETE /techniques/:id
app.delete('/:id', async (c) => {
  await db.update(schema.techniques).set({ deletedAt: now() }).where(eq(schema.techniques.id, Number(c.req.param('id'))))
  return success(c)
})

// POST /techniques/:id/generate — 出 4×4 动作分解表
app.post('/:id/generate', async (c) => {
  const id = Number(c.req.param('id'))
  const body = await c.req.json().catch(() => ({}))
  const [t] = await db.select().from(schema.techniques).where(eq(schema.techniques.id, id))
  if (!t) return badRequest(c, '技能不存在')
  const stylePrompt = await getDramaStylePrompt(t.dramaId).catch(() => '')
  const prompt = (t.prompt || '').trim() || sheetPrompt(stylePrompt, t.name, t.summary || '', String((t as any).grid || '4x4'))
  // 1119 用户「需要用 MOSS IMAGE 不是 qwen」：技能分解表默认走 MossImage（没有则回退默认图配置）
  let cfgId = body.config_id
  if (!cfgId) {
    const rows = await db.select({ id: schema.aiServiceConfigs.id, model: schema.aiServiceConfigs.model })
      .from(schema.aiServiceConfigs)
      .where(and(eq(schema.aiServiceConfigs.serviceType, 'image'), eq(schema.aiServiceConfigs.isActive, true)))
    const moss = rows.find(r => String(r.model || '').includes('moss-image'))
    if (moss) cfgId = moss.id
  }
  try {
    logTaskStart('TechniqueSheet', 'generate', { techniqueId: id })
    const genId = await generateImage({ dramaId: t.dramaId, techniqueId: id, prompt, model: body.model, size: SHEET_SIZE, configId: cfgId })
    logTaskSuccess('TechniqueSheet', 'generate', { techniqueId: id, generationId: genId })
    return success(c, { image_generation_id: genId })
  } catch (err: any) {
    logTaskError('TechniqueSheet', 'generate', { techniqueId: id, error: err.message })
    return badRequest(c, err.message)
  }
})

// POST /techniques/:id/bind { storyboard_id } — 挂到镜头
app.post('/:id/bind', async (c) => {
  const id = Number(c.req.param('id'))
  const body = await c.req.json()
  const sbId = Number(body.storyboard_id)
  if (!sbId) return badRequest(c, 'storyboard_id 必填')
  const existing = await db.select().from(schema.storyboardTechniques)
    .where(and(eq(schema.storyboardTechniques.storyboardId, sbId), eq(schema.storyboardTechniques.techniqueId, id)))
  if (!existing.length) await db.insert(schema.storyboardTechniques).values({ storyboardId: sbId, techniqueId: id, createdAt: now() })
  return success(c)
})

// POST /techniques/:id/unbind { storyboard_id }
app.post('/:id/unbind', async (c) => {
  const id = Number(c.req.param('id'))
  const body = await c.req.json()
  await db.delete(schema.storyboardTechniques)
    .where(and(eq(schema.storyboardTechniques.storyboardId, Number(body.storyboard_id)), eq(schema.storyboardTechniques.techniqueId, id)))
  return success(c)
})

// POST /techniques/extract { episode_id } — 从本集分镜描述里识别招式/特效
app.post('/extract', async (c) => {
  const body = await c.req.json()
  const episodeId = Number(body.episode_id)
  if (!episodeId) return badRequest(c, 'episode_id 必填')
  const [ep] = await db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId))
  if (!ep) return badRequest(c, '剧集不存在')
  const sbs = await db.select({ id: schema.storyboards.id, no: schema.storyboards.storyboardNumber, desc: schema.storyboards.description })
    .from(schema.storyboards).where(eq(schema.storyboards.episodeId, episodeId))
  const VERBS = '削|斩|劈|挑|刺|扫|撩|点|按|拍|震|压|封|引|噬|燃|冻|碎|锁|扣'
  const NOUNS = '剑|刀|扇|掌|拳|指|气|芒|符|阵|雷|焰|冰|霜|血|火|风|影'
  const re = new RegExp('([\\u4e00-\\u9fa5]{0,2}(?:' + VERBS + ')[\\u4e00-\\u9fa5]{0,2}(?:' + NOUNS + ')[\\u4e00-\\u9fa5]{0,2})', 'g')
  const found = new Map<string, number[]>()
  for (const sb of sbs) {
    for (const m of String(sb.desc || '').matchAll(re)) {
      const key = m[1]
      if (!found.has(key)) found.set(key, [])
      const arr = found.get(key)!
      if (!arr.includes(sb.no)) arr.push(sb.no)
    }
  }
  const existing = await db.select().from(schema.techniques)
    .where(and(eq(schema.techniques.dramaId, ep.dramaId), isNull(schema.techniques.deletedAt)))
  const byName = new Map(existing.map(t => [t.name, t]))
  const ts = now()
  const createdList: any[] = []
  const matched: any[] = []
  for (const [name, nos] of found) {
    const hit = byName.get(name)
    if (hit) { matched.push({ name, shots: nos, id: hit.id }); continue }
    const res = await db.insert(schema.techniques).values({
      dramaId: ep.dramaId, episodeId, name, kind: 'move', summary: '', source: 'auto', status: 'pending', createdAt: ts, updatedAt: ts,
    })
    const tid = getInsertId(res)
    for (const no of nos) {
      const [sb] = await db.select({ id: schema.storyboards.id }).from(schema.storyboards)
        .where(and(eq(schema.storyboards.episodeId, episodeId), eq(schema.storyboards.storyboardNumber, no)))
      if (sb) await db.insert(schema.storyboardTechniques).values({ storyboardId: sb.id, techniqueId: tid, createdAt: ts })
    }
    createdList.push({ id: tid, name, shots: nos })
  }
  logTaskSuccess('Technique', 'extract', { episodeId, created: createdList.length, matched: matched.length })
  return success(c, { created: createdList, matched })
})


/** 1119 用户「一个技能从释放开始到最终结束的全部流程」：出整条流程参考视频（释放→收招） */
function flowPrompt(t: { name: string; summary: string | null; kind: string | null }) {
  const s = (t.summary || '').trim()
  const isVfx = (t.kind || 'move') === 'vfx'
  return [
    `动作特效参考视频，完整呈现「${t.name}」从释放到收招的全过程，镜头稳定、无字幕无水印。`,
    s ? `技能特征：${s}。` : '',
    '0.0-2.0 起手蓄力：白模沉身蓄势，脚下符文法阵逐圈亮起，灵气如雾旋涡倒卷入体，光自兵器根部向尖端蔓延，刃口转白炽；',
    '2.0-4.0 释放：一步踏前斩出，十米级凹月牙剑气离体飞出，边缘水墨飞白、内部金色符文流转，身后衣袂与旗幡被气浪掀起；',
    '4.0-6.5 飞行与命中：剑气贴地掠过，沿途地面被剖出熔红裂纹，碎石与尘土环状炸起；命中处爆出纯白激波环，冷白闪光打亮全场；',
    '6.5-8.5 天地反应：赤金光柱冲天贯云，云层被剖出亮痕，空中万千剑影列阵如鱼群；',
    '8.5-10.0 余波收招：剑影散作火星随风飘落，法阵余光渐熄，白模收势归位，尘雾缓缓沉降。',
    isVfx ? '特效为画面主体，白模只做载体。' : '',
    '白色无贴图人体模型主体（无五官无发色无服饰），赤金加纯白激色，电影级体积光，仙侠大片质感。',
  ].filter(Boolean).join('')
}

// POST /techniques/:id/generate-video — 整条流程参考视频
app.post('/:id/generate-video', async (c) => {
  const id = Number(c.req.param('id'))
  const body = await c.req.json().catch(() => ({}))
  const [t] = await db.select().from(schema.techniques).where(eq(schema.techniques.id, id))
  if (!t) return badRequest(c, '技能不存在')
  try {
    logTaskStart('TechniqueVideo', 'generate', { techniqueId: id })
    const genId = await generateVideo({
      dramaId: t.dramaId,
      techniqueId: id,
      prompt: flowPrompt(t as any),
      duration: Number(body.duration) || 10,
      resolution: body.resolution || '1888x1056',
      graph: body.graph || undefined,
      // 参考图：有分解表就用分解表（saved 图里的 LoadImage 占位必须被真实文件替换，否则校验直接拒）
      referenceImageUrls: t.imageUrl ? [t.imageUrl] : undefined,
      refine: false,
      upscale: false,
    })
    logTaskSuccess('TechniqueVideo', 'generate', { techniqueId: id, generationId: genId })
    return success(c, { video_generation_id: genId })
  } catch (err: any) {
    logTaskError('TechniqueVideo', 'generate', { techniqueId: id, error: err.message })
    return badRequest(c, err.message)
  }
})

// POST /techniques/from-video — 用户上传视频转技能（抽 16 帧拼 4×4 表）
app.post('/from-video', async (c) => {
  const body = await c.req.parseBody()
  const file = body['file']
  const dramaId = Number(body['drama_id'] || 0)
  const name = String(body['name'] || '').trim()
  const episodeId = body['episode_id'] ? Number(body['episode_id']) : null
  if (!dramaId) return badRequest(c, 'drama_id 必填')
  if (!name) return badRequest(c, '名称必填')
  if (!file || typeof file === 'string') return badRequest(c, '视频文件必填')
  const ts = now()
  const vDir = path.join(DATA_ROOT, 'uploads', 'techniques')
  fs.mkdirSync(vDir, { recursive: true })
  const stamp = Date.now()
  const vPath = path.join(vDir, `skill_${stamp}.mp4`)
  fs.writeFileSync(vPath, Buffer.from(await (file as File).arrayBuffer()))
  const sheetRel = `static/images/technique_${stamp}.png`
  const sheetAbs = path.join(DATA_ROOT, sheetRel)
  fs.mkdirSync(path.dirname(sheetAbs), { recursive: true })
  const { execFileSync } = await import('node:child_process')
  try {
    execFileSync(FFMPEG, ['-y', '-v', 'error', '-i', vPath,
      '-vf', "select='not(mod(n,16))',scale=480:-2,tile=4x4", '-frames:v', '1', sheetAbs], { timeout: 180000 })
  } catch (err: any) {
    return badRequest(c, '抽帧失败：' + String(err?.message || err).slice(0, 200))
  }
  if (!fs.existsSync(sheetAbs)) return badRequest(c, '抽帧没有产出图片')
  const res = await db.insert(schema.techniques).values({
    dramaId, episodeId, name, kind: String(body['kind'] || 'move'), summary: String(body['summary'] || ''),
    imageUrl: sheetRel, source: 'video', status: 'ready', createdAt: ts, updatedAt: ts,
  })
  const [row] = await db.select().from(schema.techniques).where(eq(schema.techniques.id, getInsertId(res)))
  return created(c, toSnakeCase(row))
})

export default app
