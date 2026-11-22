// 1122 关键帧检查 AI：本机人脸检测（insightface）+ 可配置 LLM 裁决。
// LLM 作为配置项（service_type='qa'，默认 DeepSeek）；没有配置时退回纯检测结论。
import { Hono } from 'hono'
import { execFile } from 'node:child_process'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { eq } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { success, badRequest } from '../utils/response.js'
import { resolveOutfitUrl } from '../services/outfits.js'
import { getActiveConfig } from '../services/ai.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const app = new Hono()

function runFaceQA(imageRel: string, expected: Array<{ name: string; ref: string }>): Promise<any> {
  return new Promise((resolve) => {
    const script = path.join(__dirname, '../../.qa_frame.py')
    const abs = path.join(path.join(__dirname, '../../..'), 'data', imageRel.replace(/\//g, path.sep))
    const tmp = path.join(os.tmpdir(), `qa_${Date.now()}.json`)
    try { fs.writeFileSync(tmp, JSON.stringify(expected), 'utf8') } catch { resolve({ ok: true, skipped: true }); return }
    execFile('python', ['-X', 'utf8', script, abs, tmp], { timeout: 180000, encoding: 'utf8' }, (err, stdout) => {
      try { fs.unlinkSync(tmp) } catch { /* ignore */ }
      if (err) { resolve({ ok: true, error: String(err).slice(0, 160) }); return }
      const line = String(stdout || '').split(/\r?\n/).filter(l => l.startsWith('{')).pop()
      try { resolve(line ? JSON.parse(line) : { ok: true, error: 'no output' }) } catch { resolve({ ok: true, error: 'parse' }) }
    })
  })
}

/** LLM 裁决：拿镜头描述 + 角色绑定 + 检测证据，判是否符合 */
async function judgeWithLLM(evidence: any): Promise<{ ok: boolean; reason?: string; issues?: any[]; model?: string } | null> {
  const cfg = await getActiveConfig('qa')
  if (!cfg) return null
  let models: string[] = []
  try { models = JSON.parse(String(cfg.model || '[]')) } catch { /* ignore */ }
  const model = models[0] || 'deepseek-v4-pro'
  const url = String(cfg.baseUrl || '').replace(/\/+$/, '') + '/v1/chat/completions'
  const sys = '你是短剧关键帧质检员。给定：镜头描述、本镜应出现的角色、以及本机人脸检测器证据（你没有图，只能依据证据）。只输出 JSON：{"ok":true|false,"issues":[{"type":"...","severity":"fail|warn","detail":"..."}],"reason":"..."}。判据：只有**证据与描述硬冲突**才判 fail——① 检测器报 duplicate/extra/missing（硬问题）；② 描述明确是手部/道具/空镜特写，却检出多张人脸。其余（相似度略低、构图/氛围猜测、描述里没提的细节）一律 severity=warn，不要因此判 fail。'
  const body = {
    model,
    temperature: 0,
    messages: [
      { role: 'system', content: sys },
      { role: 'user', content: JSON.stringify(evidence, null, 1).slice(0, 12000) },
    ],
  }
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify(body),
    })
    if (!resp.ok) return null
    const data: any = await resp.json()
    const text = String(data?.choices?.[0]?.message?.content || '')
    const m = text.match(/\{[\s\S]*\}/)
    if (!m) return null
    const v = JSON.parse(m[0])
    return { ok: !!v.ok, reason: v.reason, issues: v.issues, model }
  } catch {
    return null
  }
}

// POST /frames/qa {storyboard_id, frame_type?, image_url?, prompt?}
app.post('/qa', async (c) => {
  const body = await c.req.json()
  const sid = Number(body.storyboard_id)
  if (!sid) return badRequest(c, 'storyboard_id 必填')
  const [sb] = await db.select().from(schema.storyboards).where(eq(schema.storyboards.id, sid))
  if (!sb) return badRequest(c, '分镜不存在')
  const frameType = body.frame_type === 'first_frame' ? 'first' : 'last'
  const imageRel = body.image_url || (frameType === 'first' ? sb.firstFrameImage : sb.lastFrameImage)
  if (!imageRel) return badRequest(c, '该帧还没有图片')

  const chars = await db.select({ id: schema.storyboardCharacters.characterId })
    .from(schema.storyboardCharacters).where(eq(schema.storyboardCharacters.storyboardId, sid))
  const expected: Array<{ name: string; ref: string }> = []
  const names: string[] = []
  for (const ch of chars) {
    const [row] = await db.select().from(schema.characters).where(eq(schema.characters.id, ch.id))
    if (!row) continue
    names.push(row.name)
    const outfit = await resolveOutfitUrl(ch.id, sid)
    const ref = outfit || row.sheetImageUrl || row.imageUrl
    if (ref) expected.push({ name: row.name, ref })
  }

  const detector = await runFaceQA(imageRel, expected)
  const evidence = {
    shot_description: sb.description || '',
    expected_characters: names,
    detector,
  }
  const llm = await judgeWithLLM(evidence)
  const ok = llm ? llm.ok : detector.ok
  return success(c, { ok, llm, detector, expected: names, image: imageRel })
})

export default app
