// 1108「画面有的时候会闪烁」：全局亮度跳变的检测 + 压制。
// 用合成片当锚（eq=brightness 在 20-23 帧整幅 +60 亮度 = 和真片同形的跳变），
// 锁三件事：① 有跳变才重编码，并把跳变压下来 ② 干净片一个字节不动 ③ env 能整条关掉。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

// STORAGE_PATH 必须在 import 之前设：paths.ts 是模块加载时求值的。
const STORE = mkdtempSync(join(tmpdir(), 'hb-df-'))
process.env.STORAGE_PATH = STORE
mkdirSync(join(STORE, 'videos'), { recursive: true })

const { deflickerVideo } = await import('../src/services/video-deflicker.ts')
const { ffmpegPath } = await import('../src/utils/ffmpeg.ts')

const NULL_SINK = process.platform === 'win32' ? 'NUL' : '/dev/null'
const run = (args) => execFileSync(ffmpegPath, args, {
  encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'],
})

function makeClip(file, flash) {
  run([
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=24:duration=2.5',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2.5',
    ...(flash ? ['-vf', "eq=brightness=0.25:enable='between(n,20,23)'"] : []),
    '-c:v', 'libx264', '-crf', '18', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', file,
  ])
}

/** 逐帧平均亮度里最大的相邻跳变 —— 和 video-deflicker.ts 里的判据同一口径。 */
function maxJump(file) {
  const out = run([
    '-hide_banner', '-nostats', '-loglevel', 'error', '-i', file,
    '-vf', 'scale=320:-2,signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=-',
    '-f', 'null', NULL_SINK,
  ])
  const v = [...out.matchAll(/signalstats\.YAVG=([\d.]+)/g)].map((m) => Number(m[1]))
  let best = 0
  for (let i = 1; i < v.length; i++) best = Math.max(best, Math.abs(v[i] - v[i - 1]))
  return best
}

test('有亮度跳变就重编码，并把跳变压下来（+60 → <15）', async () => {
  const abs = join(STORE, 'videos', 'flash.mp4')
  makeClip(abs, true)
  const before = maxJump(abs)
  assert.ok(before > 40, `合成片应该有明显跳变，实测 ${before}`)

  assert.equal(await deflickerVideo('static/videos/flash.mp4'), true)
  const after = maxJump(abs)
  assert.ok(after < 15, `deflicker 后跳变应 <15，实测 ${after}`)
  assert.ok(statSync(abs).size > 1024)
})

test('干净的片子不重编码（不是每条都白吃一次有损）', async () => {
  const abs = join(STORE, 'videos', 'clean.mp4')
  makeClip(abs, false)
  assert.ok(maxJump(abs) < 4)
  const before = statSync(abs).mtimeMs

  assert.equal(await deflickerVideo('static/videos/clean.mp4'), false)
  assert.equal(statSync(abs).mtimeMs, before)
})

test('HUOBAO_DEFLICKER=0 整条关掉（回滚口）', async () => {
  const abs = join(STORE, 'videos', 'off.mp4')
  writeFileSync(abs, 'not a video')            // 关掉时连探测都不该跑
  process.env.HUOBAO_DEFLICKER = '0'
  try {
    assert.equal(await deflickerVideo('static/videos/off.mp4'), false)
  } finally {
    delete process.env.HUOBAO_DEFLICKER
  }
})
