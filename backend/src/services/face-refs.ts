// 1115 平台集成「真人剧强化」：角色三视图自动补一张方脸特写参考。
// 依据：H3 R2V 的参考图有效细节由画布像素预算决定，三视图里的全身视图脸只有 ~40px，
// 真正能带身份/肤质的是左半张特写；用户实测 5 参考（三视图+场景+脸特写）明显少蜡。
// 规则：三视图版式是「左侧正面特写 + 右侧三张全身视图」⇒ 裁左 36% 全高，缩到 768 以内。
// 只处理 static/ 本地路径；非 static 直接跳过（远程图不在这里下载）。
import fs from 'node:fs'
import path from 'node:path'
import sharp from 'sharp'
import { DATA_ROOT } from '../utils/paths.js'

export interface FaceRefCharacter {
  id: number
  imageUrl: string | null
  /** 1119 三视图：有就用它当参考源（横版左 36% 正好是正脸特写），没有回退原图 */
  sheetImageUrl?: string | null
}

/** 幂等：文件存在就直接用；不存在才裁。返回 static 相对路径（角色页也用它显示脸特写）。 */
export async function ensureFaceCropForCharacter(ch: FaceRefCharacter): Promise<string | null> {
  const src = String(ch.sheetImageUrl || ch.imageUrl || '')
  if (!src.startsWith('static/')) return null
  // 缓存键带源图指纹：换参考图/重生成三视图后 image_url 变 → 自动重裁，不会一直喂旧脸。
  let hash = 0
  for (const ch2 of src) hash = (hash * 31 + ch2.charCodeAt(0)) >>> 0
  const rel = `static/images/faces/char_${ch.id}_${hash.toString(36)}_768.jpg`
  const abs = path.join(DATA_ROOT, rel)
  const srcAbs = path.join(DATA_ROOT, src)
  if (!fs.existsSync(srcAbs)) return null
  if (fs.existsSync(abs)) return rel
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  const img = sharp(srcAbs).rotate()
  const meta = await img.metadata()
  const w = meta.width || 1344
  const h = meta.height || 768
  // 三视图横版：左 36% 是正面特写；单人人像竖图：取上方居中方块（脸在画面上部）。
  let box: { left: number; top: number; width: number; height: number }
  if (h > w * 1.1) {
    const side = Math.max(1, Math.min(w, Math.round(h * 0.5)))
    box = { left: Math.round((w - side) / 2), top: Math.round(h * 0.1), width: side, height: side }
  } else {
    box = { left: 0, top: 0, width: Math.max(1, Math.round(w * 0.36)), height: h }
  }
  await img
    .extract(box)
    .resize({ width: 768, height: 768, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 92, mozjpeg: true })
    .toFile(abs)
  return rel
}

/**
 * 给 H3 full_ref 追加「方脸特写」参考图，并把 <Picture N> 标签写进三个段：
 *   subject_definitions / retention_analysis / detailed_description（[Shot 1] 前）
 * 假设前 k 张参考就是角色三视图（顺序与 <Subject 1..k> 一致，桥的 ref_image_0..k-1 同序）。
 * 已有同号 <Picture N> 时不重复写定义（手工改过的分镜保持原样）。
 */
export async function appendFaceRefs(
  prompt: string,
  refs: string[],
  characters: FaceRefCharacter[],
): Promise<{ prompt: string; refs: string[] }> {
  if (!characters.length) return { prompt, refs }
  if (!prompt.includes('subject_definitions:') || !prompt.includes('<Picture 1>')) return { prompt, refs }
  const base = refs.length
  const outRefs = [...refs]
  const defs: string[] = []
  const rets: string[] = []
  const descs: string[] = []
  for (let i = 0; i < characters.length; i++) {
    // 1119：角色已有三视图时不再额外挂脸特写 —— 三视图左 36% 本来就是正脸特写，
    // 再挂一张等于同一个人占两个参考位，白吃编码时间与内存（#6 起 6 参考挤爆 RAM）。
    if (characters[i]?.sheetImageUrl) continue
    const rel = await ensureFaceCropForCharacter(characters[i])
    if (!rel) continue
    const pic = base + outRefs.length - refs.length + 1
    outRefs.push(rel)
    defs.push(`<Picture ${pic}> is a close-up of <Subject ${i + 1}>'s face, the same person as <Picture ${i + 1}>, showing skin texture and facial features.`)
    rets.push(`<Picture ${pic}> (appears in all shots): fully_preserved - face detail reference for <Subject ${i + 1}>; identity, skin texture and features match <Picture ${i + 1}>.`)
    descs.push(`The face of <Subject ${i + 1}> follows the detail of <Picture ${pic}>.`)
  }
  if (!outRefs.length) return { prompt, refs }
  let p = prompt
  if (!p.includes('<Picture ' + (base + 1) + '>')) {
    p = p.replace('summary:', defs.join('\n') + '\nsummary:')
    p = p.replace('detailed_description:', rets.join('\n') + '\ndetailed_description:')
    const k = p.indexOf('[Shot 1]')
    if (k >= 0) p = p.slice(0, k) + descs.join('\n') + '\n' + p.slice(k)
  }
  return { prompt: p, refs: outRefs }
}
