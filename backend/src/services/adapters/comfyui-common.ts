// 本机 ComfyUI + ComfyUI-OpenAI-Bridge 的共用件（图片 / 视频两个 Adapter 都要把参考图
// 先落到 ComfyUI input/ 目录，桥只认文件名，不认 URL / data URL）。
import type { AIConfig } from './types'
import path from 'node:path'
import fs from 'node:fs'
import { DATA_ROOT } from '../../utils/paths.js'

/** 本机 ComfyUI input 目录（默认；可被 settings.comfyuiInputDir / 环境变量 COMFYUI_INPUT_DIR 覆盖） */
export const DEFAULT_INPUT_DIR = 'E:\\AI\\ComfyUI\\input'

export function toInputDir(config: AIConfig): string {
  const envDir = process.env.COMFYUI_INPUT_DIR?.trim()
  const settingDir = (config as any).comfyuiInputDir?.trim()
  return (settingDir || envDir || DEFAULT_INPUT_DIR).replace(/^[/\\]+|[/\\]+$/, '')
}

export function guessExtension(value: string): string {
  const base = value.split('?')[0].split('#')[0].replace(/^data:[^,]+/, '')
  const name = (base.split(/[/\\]/).pop() || base) || ''
  const dot = name.lastIndexOf('.')
  return dot > 0 && dot < name.length - 1 ? name.slice(dot).toLowerCase() : '.png'
}

/** data URL / 本地 static 路径 / 远程 URL 统一读成字节 */
export async function readReferenceBytes(value: string): Promise<Uint8Array | null> {
  const raw = value.trim()
  if (!raw) return null
  if (raw.startsWith('data:')) {
    const sep = raw.indexOf(',')
    if (sep < 0) return null
    const b64 = raw.slice(sep + 1).replace(/\s+/g, '')
    return Buffer.from(b64, 'base64')
  }
  // 本地 static 路径直接读磁盘（与 ffmpeg-merge 的 toAbsPath 同口径）。
  // 旧实现 fetch('/static/'+raw) 对 DB 的 static/... 会 double-prefix 成
  // /static/static/... → 404，且 Node fetch 对相对路径必抛，故本地文件永落不到 input/
  if (/^static\/|^\/static\//.test(raw)) {
    try {
      const rel = raw.replace(/^\/+/, '')
      return new Uint8Array(fs.readFileSync(path.join(DATA_ROOT, rel)))
    } catch {
      return null
    }
  }
  try {
    const resp = await fetch(raw)
    if (!resp.ok) return null
    return new Uint8Array(await resp.arrayBuffer())
  } catch {
    return null
  }
}

/** 把参考图落到 ComfyUI input/ 目录，返回新文件名（最多 max 张，多余的截断） */
export async function stageReferenceImages(
  images: string[] | null | undefined,
  inputDir: string,
  max: number,
): Promise<string[]> {
  const out: string[] = []
  for (const v of (images || []).slice(0, max)) {
    const bytes = await readReferenceBytes(String(v || ''))
    if (!bytes) continue
    const fname = `huobao_ref_${Date.now()}_${Math.random().toString(36).slice(2, 8)}${guessExtension(v)}`
    fs.mkdirSync(inputDir, { recursive: true })
    fs.writeFileSync(path.join(inputDir, fname), bytes)
    out.push(fname)
  }
  return out
}

/** 容忍配置成 http://127.0.0.1:6006 / http://127.0.0.1:6006/v1 / …/v1/（OpenAI 风格带 /v1） */
export function baseOf(baseUrl: string): string {
  // 尾斜杠必须先去掉：留着它 /\/v1?$/ 匹配不到，拼出来就是 /v1/v1/…
  return (baseUrl || '').replace(/\/+$/, '').replace(/\/v1?$/, '')
}
