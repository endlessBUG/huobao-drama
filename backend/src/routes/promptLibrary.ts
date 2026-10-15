import { Hono } from 'hono'
import { eq, and, sql } from 'drizzle-orm'
import { db, getInsertId, schema } from '../db/index.js'
import { success, created, badRequest, notFound, now } from '../utils/response.js'
import { toSnakeCase } from '../utils/transform.js'

const app = new Hono()

// GET /prompt-library — 列表。?group=解剖&q=cleft&all=1&sort=hits
// 默认只回启用项、按命中次数降序（「常用」的口径就是 hits）
app.get('/', async (c) => {
  const group = c.req.query('group')
  const q = c.req.query('q')
  const all = c.req.query('all') === '1'
  const rows = await db.select().from(schema.promptLibrary)
  let filtered = rows.filter(r => all ? true : r.isActive)
  if (group) filtered = filtered.filter(r => r.groupName === group)
  if (q) {
    const needle = q.toLowerCase()
    filtered = filtered.filter(r =>
      r.title.toLowerCase().includes(needle) || r.text.toLowerCase().includes(needle) ||
      (r.note || '').toLowerCase().includes(needle))
  }
  filtered.sort((a, b) => (b.hits || 0) - (a.hits || 0) || a.id - b.id)
  return success(c, filtered.map(r => toSnakeCase(r)))
})

// 分组清单（设置页的筛选条用）
app.get('/groups', async (c) => {
  const rows = await db.select({
    groupName: schema.promptLibrary.groupName,
    count: sql<number>`count(*)`,
  }).from(schema.promptLibrary).groupBy(schema.promptLibrary.groupName)
  return success(c, rows.map(r => toSnakeCase(r)))
})

// POST /prompt-library — 新增一条
app.post('/', async (c) => {
  const body = await c.req.json()
  if (!body.group_name?.trim()) return badRequest(c, '分组必填')
  if (!body.title?.trim()) return badRequest(c, '标题必填')
  if (!body.text?.trim()) return badRequest(c, '提示词内容必填')
  const [dup] = await db.select().from(schema.promptLibrary)
    .where(and(eq(schema.promptLibrary.groupName, body.group_name.trim()),
      eq(schema.promptLibrary.title, body.title.trim())))
  if (dup) return badRequest(c, '同组里这个标题已经存在')
  const ts = now()
  const res = await db.insert(schema.promptLibrary).values({
    groupName: body.group_name.trim(),
    title: body.title.trim(),
    text: body.text.trim(),
    note: body.note || null,
    hits: Number(body.hits ?? 0),
    isActive: body.is_active === false || body.is_active === 0 ? false : true,
    createdAt: ts,
    updatedAt: ts,
  })
  const [row] = await db.select().from(schema.promptLibrary)
    .where(eq(schema.promptLibrary.id, getInsertId(res)))
  return created(c, toSnakeCase(row))
})

// PUT /prompt-library/:id
app.put('/:id', async (c) => {
  const id = Number(c.req.param('id'))
  const body = await c.req.json()
  const [row] = await db.select().from(schema.promptLibrary)
    .where(eq(schema.promptLibrary.id, id))
  if (!row) return notFound(c, '条目不存在')
  const updates: Record<string, any> = { updatedAt: now() }
  if (body.group_name !== undefined) updates.groupName = String(body.group_name).trim()
  if (body.title !== undefined) updates.title = String(body.title).trim()
  if (body.text !== undefined) updates.text = String(body.text).trim()
  if (body.note !== undefined) updates.note = body.note || null
  if (body.hits !== undefined) updates.hits = Number(body.hits)
  if (body.is_active !== undefined) {
    const v = body.is_active
    updates.isActive = !(v === false || v === 0)
  }
  await db.update(schema.promptLibrary).set(updates).where(eq(schema.promptLibrary.id, id))
  return success(c)
})

// DELETE /prompt-library/:id — 硬删除（库是全局参考品，没有引用外键要留）
app.delete('/:id', async (c) => {
  const id = Number(c.req.param('id'))
  await db.delete(schema.promptLibrary).where(eq(schema.promptLibrary.id, id))
  return success(c)
})

export default app
