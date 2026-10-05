import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

// 超分链路的「接线」测试。真正的不变量（默认不插节点、帧数裁回原长、音频不过超分）
// 由桥自己的 _selftest 用真图断言（python __init__.py 直接跑），这里只锁我们这侧的开关与形状。
const bridge = readFileSync('E:/AI/ComfyUI/custom_nodes/ComfyUI-OpenAI-Bridge/__init__.py', 'utf8')
const adapter = readFileSync(new URL('../src/services/adapters/comfyui-video.ts', import.meta.url), 'utf8')

test('bridge：upscale 默认关，路由可覆盖', () => {
  assert.match(bridge, /def _wf_video\(prompt, w, h, length, refs, seed, prefix, ref_scale=2\.0, upscale=0, selflift=False, sparse=False, guide=None\):/)
  assert.match(bridge, /upscale = int\(b\.get\("upscale"\) or 0\)/)
  assert.match(bridge, /selflift = bool\(b\.get\("selflift"\)\)/)
  assert.match(bridge, /sparse = bool\(b\.get\("sparse", False\)\)/)
  // 路由把它透传进 _wf_video（第 9、10、11 个位置参数）
  assert.match(bridge, /"openai\/h3_" \+ uuid\.uuid4\(\)\.hex\[:8\], ref_scale, upscale, selflift, sparse,\s*b\.get\("guide"\) or None\)/)
})

test('bridge：超分拆 InitPipe + Adv 两段（加载权重与跑超分入参分开，便于单独调参）', () => {
  assert.match(bridge, /"class_type":\s*"FlashVSRInitPipe"/)
  assert.match(bridge, /"class_type":\s*"FlashVSRNodeAdv"/)
  assert.match(bridge, /"pipe":\s*\["3000", 0\]/)
  assert.match(bridge, /"model":\s*"FlashVSR-v1\.1"/)
  // tile_size 保持 256：实测 1024 单瓦片同速但峰值 8.5G，溢出 8G 卡
  assert.match(bridge, /"tile_size":\s*256, "tile_overlap":\s*24/)
})

// 这条是补的坑：桥里曾把 Python **类名** FlashVSRNodeInitPipe 当成 class_type，而 ComfyUI 认的是
// NODE_CLASS_MAPPINGS 的**键** FlashVSRInitPipe。图字典照样构造得出、桥自检也过（自检只比自己的
// 字符串），只有真提交才 "node type not found"。所以这里不问桥、直接问节点源码认哪些名字。
test('bridge 里所有 FlashVSR 节点的 class_type 都是节点包注册过的键', () => {
  const pack = readFileSync('E:/AI/ComfyUI/custom_nodes/ComfyUI-FlashVSR_Ultra_Fast/nodes.py', 'utf8')
  const block = pack.match(/NODE_CLASS_MAPPINGS\s*=\s*\{([\s\S]*?)\}/)?.[1]
  assert.ok(block, '没能从节点源码里解析出 NODE_CLASS_MAPPINGS')
  const registered = new Set([...block.matchAll(/^\s*"([^"]+)"\s*:/gm)].map((m) => m[1]))
  assert.ok(registered.size >= 3, `注册表解析异常，只有 ${registered.size} 项`)

  const used = [...bridge.matchAll(/"class_type":\s*"(FlashVSR[^"]*)"/g)].map((m) => m[1])
  assert.ok(used.length > 0, 'bridge 里没找到 FlashVSR 节点')
  for (const t of used) {
    assert.ok(registered.has(t), `class_type "${t}" 不在节点包注册表里，真提交会 node type not found。注册表：${[...registered].join(', ')}`)
  }
})

test('bridge：超分精度用节点默认 bf16（同 2 字节，指数域和 fp32 同宽，不会溢出）', () => {
  assert.match(bridge, /"precision":\s*"bf16"/)
  assert.doesNotMatch(bridge, /"precision":\s*"fp16"/)
})

test('bridge：超分插在 VAEDecode 与 CreateVideo 之间，音频旁路', () => {
  assert.match(bridge, /frames_src = "308"/)
  assert.match(bridge, /frames_src = "3081"/)
  assert.match(bridge, /"images":\s*\[frames_src, 0\], "audio":\s*\["309", 0\]/)
  // 视频侧进超分，音频侧仍直取 latent 解码结果 —— 音画不会因超分错位
  assert.match(bridge, /"frames":\s*\["308", 0\]/)
  assert.match(bridge, /g\["309"\] = \{"class_type": "VAEDecodeAudio", "inputs": \{"samples": \["307", 0\]/)
})

// 1080p 不在桥里做。曾在超分后接 ImageScale(1920x1080) 落到每条分镜上，实测把 124 帧
// 从 259s 拉到 900s（scale=3 走的超分本身就是 7 倍代价）。交付尺寸归导出合并那一步，
// 全片算一遍即可。这条断言是防回归闸：谁把缩放塞回桥里就红。
test('bridge：不在生成侧缩到 1080p（交付尺寸归导出合并）', () => {
  assert.doesNotMatch(bridge, /"class_type":\s*"ImageScale"/)
  assert.doesNotMatch(bridge, /frames_src = "3082"/)
})

test('ffmpeg-merge：成片统一落到 1920x1080，increase+crop 不拉伸', () => {
  const merge = readFileSync(new URL('../src/services/ffmpeg-merge.ts', import.meta.url), 'utf8')
  assert.match(merge, /const OUT_W = 1920/)
  assert.match(merge, /const OUT_H = 1080/)
  assert.match(merge, /scale=\$\{OUT_W\}:\$\{OUT_H\}:force_original_aspect_ratio=increase,crop=\$\{OUT_W\}:\$\{OUT_H\}/)
})

test('bridge _selftest 断言超分开/关两种形状', () => {
  assert.match(bridge, /v2 = _wf_video\("a cat", 576, 320, 124, \["qingyi\.jpg"\], 7, "openai\/h3_sr_test", 2\.0, 2\)/)
  assert.match(bridge, /assert "3081" not in v and v\["310"\]\["inputs"\]\["images"\] == \["308", 0\]/)
  assert.match(bridge, /assert not any\(n\["class_type"\] == "ImageScale" for n in v2\.values\(\)\)/)
})

test('adapter：480p 走 SelfLift 864x480（提升靠 latent lift，不叠 FlashVSR）；默认走 SelfLift 到 1.22 MP（1472x832）；首帧路径保持旧口径', () => {
  assert.match(adapter, /const SIZE_480P = '864x480'/)
  assert.match(adapter, /const DEFAULT_SIZE = '1472x832'/)
  assert.match(adapter, /const UPSCALE = 0/)
  assert.match(adapter, /const is480 = \(record\.resolution \|\| '480p'\) === '480p'/)
  assert.match(adapter, /size: firstFrameFile \? FL2VA_SIZE : \(is480 \? SIZE_480P : DEFAULT_SIZE\)/)
  assert.match(adapter, /upscale: firstFrameFile \? 2 : UPSCALE/)
  assert.match(adapter, /selflift: !firstFrameFile/)
  // 2026-10-03 拍板：transition_step=3（243 帧实测 914s vs t=2 的 2846s，−68%），
  // 代价是身份 0.698→0.635。改回 2 必须带着新的实测理由，别静默回退。
  assert.match(bridge, /"transition_step": 3/)
  assert.match(bridge, /assert v3\["307"\]\["inputs"\]\["transition_step"\] == 3/)
  // 闸：SelfLift 与 FlashVSR 不能同时开 —— 1152x640 再 ×2 = 2304x1280，8G 必炸
  assert.match(bridge, /if upscale and not selflift:/)
})

// 块稀疏注意力（1003 加）。class_type 必须是 core 的 node_id —— 和 FlashVSR 那条是同一个坑。
test('bridge：BlockSparseAttention 名字对得上 core，默认关（实测净亏）、可开，且采样器挂的是补丁后的模型', () => {
  const core = readFileSync('E:/AI/ComfyUI/comfy_extras/nodes_sparse_attention.py', 'utf8')
  assert.match(core, /node_id="BlockSparseAttention"/)
  assert.match(bridge, /"class_type":\s*"BlockSparseAttention"/)
  // ComfyUI 在 cu124 上默认禁用 comfy_kitchen 的 cuda 后端（quant_ops.py:26-28）→ 稀疏永不触发。
  // 不能整闸打开（实测 int8 requantize 炸），只能单点把 sol_attn 指到 cuda 后端。
  assert.match(bridge, /_ck\.sol_attn = _ckcuda\.sol_attn/)
  assert.match(bridge, /_ck\.sol_attn_is_available = lambda/)
  assert.doesNotMatch(bridge, /_ck\.registry\.enable\("cuda"\)/)
  assert.match(bridge, /m = "98" if sparse else "97"/)
  assert.match(bridge, /"model":\s*\[m, 0\]/)
  // sol-attn 是三种模式里唯一免训练的（sla 要按该模式蒸馏的权重、vsa 要 FastH3 权重，我们都没有）
  // DynamicCombo 在 prompt API 里要用点号键（实测：平铺过不了校验、嵌套字典过校验但 execute 拿不到
  // selection，只有 "selection.tau" 跑通）
  assert.match(bridge, /"selection":\s*"sol-attn",\s*"selection\.tau":\s*1\.3/)
  // min_tokens 必须低于每瓦片序列长度（实测每瓦片 10823 token），否则稀疏永不触发
  assert.match(bridge, /"min_tokens":\s*4096/)
  // 参考/文本/音频行钉成精确 —— 身份判据（像不像）风险最小的挂法
  assert.match(bridge, /"sink_conditioning":\s*"exact_kv_and_rows"/)
  // 这两个是实测踩出来的：新式 io.Schema 的 advanced 输入在 prompt API 里仍必填，漏了就整单被拒
  assert.match(bridge, /"dense_blocks":\s*""/)
  // verbose 必须开：没有 `sparse ...` 日志行就等于没加速（补丁可能报告成功但什么都不做）
  assert.match(bridge, /"verbose":\s*True/)
})
