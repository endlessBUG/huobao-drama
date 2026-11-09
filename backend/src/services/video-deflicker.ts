/**
 * 1108 用户「画面有的时候会闪烁」—— 查出来闪的是**全局亮度瞬时跳变**，不是后处理。
 *
 * 实测（同一批 6 条成片，5 条有）：某几帧全画面亮度 110 → 134 → 十几帧内回落到 110；
 * 4×6 网格逐格 +10~+21（整幅一起抬，不是局部光效/镜头光斑）。
 * 已排除补帧超分：RIFE+RelayVSR 的成片和两采+RTX VSR 的成片都出现同样波形 ⇒ 生成侧 H3 的曝光不稳
 * （4 步 turbo + Veda 32/32 这套加速栈的已知代价，见 docs/comfyui-h3-configs.md）。
 *
 * 修法：交付前跑 ffmpeg `deflicker`（按邻域平均亮度做时域归一）。实测同一条片：
 * 最大跳变 +13.9 → +2.3、逐帧差 max 14.6 → 6.0、全片均值 111.0 → 110.5（不变暗不变色）。
 * 只在真检测到跳变时才重编码 —— 干净的片子一个字节不动，不白吃一次有损。
 * 成本：检测 1.4 s、重编码 18 s（12 s / 2560×1472 / 587 帧）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { ffmpegPath } from '../utils/ffmpeg.js'
import { STORAGE_ROOT } from '../utils/paths.js'

/** 正常运动实测 <1、闪烁 ≥8 ⇒ 4 这条线把「有闪」全部捞进来，又不会被正常运动误触发。 */
const JUMP_THRESHOLD = 4
/** deflicker 的窗口帧数：48 fps 下 10 帧 ≈ 0.2 s，够盖住实测 4 帧的跳变 + 12 帧的回落尾巴。 */
const WINDOW = 10

const BIN = ffmpegPath || 'ffmpeg'
const NULL_SINK = process.platform === 'win32' ? 'NUL' : '/dev/null'

function run(args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(BIN, args, { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024, windowsHide: true },
      (err, stdout) => (err ? reject(err) : resolve(String(stdout))))
  })
}

/** 逐帧平均亮度里最大的相邻跳变；读不到就当 0（不动原片）。 */
async function maxLumaJump(file: string): Promise<number> {
  const out = await run([
    '-hide_banner', '-nostats', '-loglevel', 'error', '-i', file,
    // 缩到 320 宽只算亮度直方图，1.4 s 跑完 587 帧；file=- 把 metadata 打到 stdout（不要写临时文件：
    // Windows 路径里的盘符冒号会把 filter 描述符切断）。
    '-vf', 'scale=320:-2,signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=-',
    '-f', 'null', NULL_SINK,
  ], 180_000)
  const vals = [...out.matchAll(/signalstats\.YAVG=([\d.]+)/g)].map((m) => Number(m[1]))
  let best = 0
  for (let i = 1; i < vals.length; i++) best = Math.max(best, Math.abs(vals[i] - vals[i - 1]))
  return best
}

/**
 * 有闪就原地替换成压过的版本，返回是否动过。任何一步失败都保留原片（不阻断任务）。
 * `relPath` 是平台相对路径（`static/videos/xxx.mp4`）。
 */
export async function deflickerVideo(relPath: string): Promise<boolean> {
  if (process.env.HUOBAO_DEFLICKER === '0') return false
  const abs = path.join(STORAGE_ROOT, relPath.replace(/^static\//, ''))
  if (!fs.existsSync(abs)) return false
  try {
    if ((await maxLumaJump(abs)) <= JUMP_THRESHOLD) return false
    const tmp = abs.replace(/\.mp4$/i, '') + '.dl.mp4'
    await run([
      '-hide_banner', '-nostats', '-loglevel', 'error', '-y', '-i', abs,
      '-vf', `deflicker=mode=am:size=${WINDOW}`,
      '-map', '0:v:0', '-map', '0:a?',
      '-c:v', 'libx264', '-crf', '17', '-preset', 'medium', '-pix_fmt', 'yuv420p',
      '-c:a', 'copy', '-movflags', '+faststart', tmp,
    ], 900_000)
    if (!fs.existsSync(tmp) || fs.statSync(tmp).size < 1024) throw new Error('empty output')
    fs.renameSync(tmp, abs)
    return true
  } catch (e) {
    console.warn('[deflicker] failed, keep original clip:', (e as Error).message)
    return false
  }
}
