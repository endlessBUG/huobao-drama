import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

// 桥的块稀疏注意力（sol-attn）开关 —— 这条锁的是接线，不是效果：
// sparse 在桥里是 `_wf_video(..., sparse)` 的形参，只有 body 带 `"sparse": true` 才会插第 98 格
// （BlockSparseAttention）并把下游从 97 改到 98。断一环（tasks 不收、快照不写、adapter 不传）
// 后端都会静默拿到一张没开稀疏的图，而 A/B 的结论会被当成「sol-attn 没用」。
const bridge = readFileSync('E:/AI/ComfyUI/custom_nodes/ComfyUI-OpenAI-Bridge/__init__.py', 'utf8')
const adapter = readFileSync(new URL('../src/services/adapters/comfyui-video.ts', import.meta.url), 'utf8')
const generation = readFileSync(new URL('../src/services/generation.ts', import.meta.url), 'utf8')
const tasks = readFileSync(new URL('../src/routes/tasks.ts', import.meta.url), 'utf8')
const types = readFileSync(new URL('../src/services/adapters/types.ts', import.meta.url), 'utf8')

test('桥：sparse 从 body 读、为真才插 98、下游跟着改 98', () => {
  assert.match(bridge, /sparse = bool\(b\.get\("sparse", False\)\)/)
  assert.match(bridge, /if sparse:\s*\n\s*# ComfyUI 在 torch<cu130/)
  assert.match(bridge, /g\["98"\] = \{"class_type": "BlockSparseAttention"/)
  assert.match(bridge, /m = "98" if sparse else "97"/)
})

test('后端：sparse 一路传到桥的 body（routes → 快照 → processTask → adapter）', () => {
  assert.match(tasks, /sparse: videoBody!\.sparse/)
  // 快照写一次 + processTask 从快照读一次：少一边都会静默丢（chain 上就是这么翻车的）
  assert.match(generation, /sparse\?: boolean \| null/)
  assert.match(generation, /sparse: params\.sparse,\s+\/\/ 必须进快照/)
  assert.match(generation, /loraTrigger: params\.loraTrigger,\s*\n\s*sparse: params\.sparse,\s*\n\s*\}\)/)
  assert.match(types, /sparse\?: boolean \| null/)
  // 1108 用户「开全注意力」：缺省 = dense ⇒ `?? false`（不传就真发 false，桥不插 Veda）。
  // 显式 `sparse: true` 仍是唯一回到 Veda 的路。
  assert.match(adapter, /sparse: record\.sparse \?\? false/)
})

test('不传 sparse 时 body 必须带 sparse:false（缺省 dense）', () => {
  // 反着锁：把 `?? false` 改回 `?? undefined` / `? true : undefined` 都要红 —— 后者是 1016 那种
  // 「false 和没传混成一谈」的老病，会让「开全注意力」静默失效。
  assert.match(adapter, /sparse: record\.sparse \?\? false/)
  assert.doesNotMatch(adapter, /sparse: record\.sparse \?\? undefined/)
  assert.doesNotMatch(adapter, /record\.sparse \? true : undefined/)
})
