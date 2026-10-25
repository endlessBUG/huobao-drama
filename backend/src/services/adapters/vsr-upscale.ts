// 分辨率后处理（1025 用户「分辨率能在高点吗」）：RTX VSR 硬件超分 ×2，1024×768 → 2048×1536。
// 走的是 1021 已判活的路线（`docs/comfyui-h3-configs.md`：arm12/17/20 ×2 逐像素保真、不造结构也不抹结构），
// 1025 在真生产片（task 683、294 帧）上实测 **29.1 s = 0.10 s/帧**、YAVG 只掉 0.32%（1012 的 −1.2% 是 4K 档，
// 这条不是）。跑在 VSR_GPU（默认 1 号卡 4060）上，不占 6006 的 0 号卡。
// 为什么不在生成侧抬画布：1472×832 实测 1.9× 时间且构图漂（arm25），PDD LoRA 也是 1024 口径；
// 交付端合并本来就要把 1024 拉到 1920×1080（1.875× 双线性 = 软），先 ×2 再让合并降采样才是真细节。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { STORAGE_ROOT } from '../../utils/paths.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SCRIPT = path.join(HERE, '..', '..', '..', 'scripts', 'vsr2x.py')

/** 默认全开（用户要更高分辨率），API 显式 `upscale:false` 才关；只对 comfyui 的视频。 */
export function wantsUpscale(
  provider: string | null | undefined,
  params: { upscale?: boolean } | null | undefined,
): boolean {
  return provider === 'comfyui' && params?.upscale !== false
}

/** nvvfx 装在 ComfyUI 的 venv 里；给出候选，找不到就静默跳过（别的机器没有这条硬件路）。 */
function findPython(): string | null {
  const cands = [
    process.env.VSR_PYTHON,
    process.env.COMFYUI_PYTHON,
    'E:/AI/ComfyUI/.venv-cu130/Scripts/python.exe',
    'E:/AI/ComfyUI/.venv/Scripts/python.exe',
  ].filter(Boolean) as string[]
  return cands.find((p) => { try { return fs.existsSync(p) } catch { return false } }) ?? null
}

// 4060 只有 8 GB，几条任务同时收尾时并发跑 VSR 会互相顶；一条一条来（每条约 11-30 s，排队不心疼）。
let chain: Promise<unknown> = Promise.resolve()

/** ×2 成片，返回新的相对路径（static/videos/…）；任何一步不可用/失败都返回 null（调用方保留原片）。 */
export function upscaleVideoVSR(videoLocalPath: string): Promise<string | null> {
  const run = chain.then(() => doUpscale(videoLocalPath))
  chain = run.catch(() => {})
  return run
}

async function doUpscale(videoLocalPath: string): Promise<string | null> {
  const py = findPython()
  if (!py || !fs.existsSync(SCRIPT)) return null
  const absIn = path.join(STORAGE_ROOT, videoLocalPath.replace(/^static\//, ''))
  const outAbs = path.join(STORAGE_ROOT, 'videos', `${randomUUID()}.mp4`)
  fs.mkdirSync(path.dirname(outAbs), { recursive: true })
  fs.mkdirSync(os.tmpdir(), { recursive: true })
  const env: NodeJS.ProcessEnv = { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' }
  if (!env.VSR_GPU) env.VSR_GPU = '1' // 0 号卡留给 6006 生成下一条
  try {
    await new Promise<void>((resolve, reject) => {
      execFile(py, ['-I', SCRIPT, absIn, outAbs, '2', 'ULTRA'], {
        timeout: 10 * 60_000, maxBuffer: 16 * 1024 * 1024, env, windowsHide: true,
      }, (err, _stdout, stderr) => {
        if (err) return reject(new Error(`${err.message} :: ${String(stderr).slice(-300)}`))
        resolve()
      })
    })
  } catch (e) {
    console.warn('[vsr-upscale] failed, keep base clip:', (e as Error).message)
    try { fs.rmSync(outAbs, { force: true }) } catch {}
    return null
  }
  if (!fs.existsSync(outAbs) || fs.statSync(outAbs).size < 1024) return null
  return `static/videos/${path.basename(outAbs)}`
}
