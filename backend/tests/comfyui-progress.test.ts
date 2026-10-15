import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ComfyUIVideoAdapter } from '../src/services/adapters/comfyui-video.ts'

const a = new ComfyUIVideoAdapter()
const rec = (o: any) => ({ prompt: 'x', ...o } as any)

// 锚 = 实测 history（124 帧整单）：576x320=126s / 864x480=364s / 1472x832=270s（4 步 turbo 时代）
// + 1016 定案 1024x768 = 674s/243 帧（20 步无 LoRA）⇒ 720p 档现在打的是 1024x768
test('progressHint 命中实测锚', () => {
  assert.equal(a.progressHint(rec({ duration: 5, resolution: '720p' })), 344) // 124 帧 × 2.774
  assert.equal(a.progressHint(rec({ duration: 10, resolution: '720p' })), 674) // 243 帧 × 2.774（x2432s20 实测）
  assert.equal(a.progressHint(rec({ duration: 5, resolution: '480p' })), 364)
  assert.equal(a.progressHint(rec({ duration: 5, resolution: '576x320' })), 126)
  // 1016 首尾帧：首帧条不再落 fl2va 的 576×320（→126s），画布与其它条一样是 1024×768
  assert.equal(a.progressHint(rec({ duration: 5, resolution: '720p', firstFrameUrl: '/static/x.png' })), 344)
  assert.equal(a.progressHint(rec({ duration: 5, resolution: '720p', lastFrameUrl: '/static/x.png' })), 344)
})

test('progressHint 对没锚的画布给不出数（不瞎估）', () => {
  assert.equal(a.progressHint(rec({ duration: 5, resolution: '123x456' })), undefined)
})

test('parsePollResponse 透桥的真步数（1012 ws 旁听），老桥没这个键就是 undefined', () => {
  assert.deepEqual(a.parsePollResponse({ status: 'running', progress: { pct: 42 } }),
    { status: 'processing', progress: 42 })
  assert.deepEqual(a.parsePollResponse({ status: 'queued' }),
    { status: 'processing', progress: undefined })
})
