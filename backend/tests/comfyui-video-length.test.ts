import assert from 'node:assert/strict'
import { test } from 'node:test'
import { framesForDuration } from '../src/services/adapters/comfyui-video'

// 节点 align_frame_count：while (n % 17 != 5) n++
const aligned = (n: number) => n % 17 === 5
const secs = (n: number) => n / 24

test('framesForDuration：吸附 17k+5 网格（非对齐会被 VAE 静默补帧→尾巴卡住）', () => {
  assert.equal(framesForDuration(12), 294) // 288 → 294 = 12.25s
  assert.equal(framesForDuration(10), 243) // 240 → 243 = 10.12s
  assert.equal(framesForDuration(9), 226) // 216 → 226 = 9.42s
  assert.equal(framesForDuration(8), 192) // 192 已是网格点 = 8.00s
  assert.equal(framesForDuration(5.17), 124) // 默认档 = 5.17s
  assert.equal(framesForDuration(15), 362) // 360 → 362 = 15.08s（训练区间上界）
  for (const s of [3, 5.17, 8, 9, 10, 12, 15, 30]) {
    assert.ok(aligned(framesForDuration(s)), `${s}s → ${framesForDuration(s)} 帧不落在 17k+5 网格上`)
  }
})

test('framesForDuration：夹进训练区间 124-362，缺省退回旧行为 124', () => {
  assert.equal(framesForDuration(1), 124)
  assert.equal(framesForDuration(60), 362)
  assert.equal(framesForDuration(null), 124)
  assert.equal(framesForDuration(undefined), 124)
  assert.equal(framesForDuration(0), 124)
  assert.equal(secs(framesForDuration(60)), 15.083333333333334)
})
