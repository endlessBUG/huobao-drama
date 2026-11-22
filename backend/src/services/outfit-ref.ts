// 1122 帧图角色参考：从「角色×服饰」组合三视图裁出**正面全身单视图**。
// 依据：qwen 会把四视拼版当构图复制（单人镜画出两张脸），单视图参考可消除；
// 组合三视图本身仍是视频参考（H3 需要脸特写细节）。
import fs from 'node:fs'
import path from 'node:path'
import sharp from 'sharp'
import { DATA_ROOT } from '../utils/paths.js'

function hashOf(s: string): string {
  let h = 0
  for (const ch of s) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  return h.toString(36)
}

/** 返回单视图裁片的 static 相对路径；输入非 static/文件不存在时返回 null */
export async function ensureSingleViewRef(url: string | null | undefined): Promise<string | null> {
  const src = String(url || '')
  if (!src.startsWith('static/')) return null
  const abs = path.join(DATA_ROOT, src)
  if (!fs.existsSync(abs)) return null
  const rel = `static/images/single/${hashOf(src)}.jpg`
  const out = path.join(DATA_ROOT, rel)
  if (fs.existsSync(out)) return rel
  const meta = await sharp(abs).metadata()
  const w = meta.width || 1920
  const h = meta.height || 1088
  // 版式：左 36% 正脸特写，右侧三张全身视图（正面/侧面/背面）等宽 → 取第一张（正面）
  const left = Math.round(w * 0.36)
  const width = Math.max(1, Math.round(w * 0.213))
  fs.mkdirSync(path.dirname(out), { recursive: true })
  await sharp(abs)
    .extract({ left, top: 0, width, height: h })
    .jpeg({ quality: 92, mozjpeg: true })
    .toFile(out)
  return rel
}
