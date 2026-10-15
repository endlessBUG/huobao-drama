import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

// 超分链路的「接线」测试。真正的不变量（默认不插节点、帧数裁回原长、音频不过超分）
// 由桥自己的 _selftest 用真图断言（python __init__.py 直接跑），这里只锁我们这侧的开关与形状。
const bridge = readFileSync('E:/AI/ComfyUI/custom_nodes/ComfyUI-OpenAI-Bridge/__init__.py', 'utf8')
const adapter = readFileSync(new URL('../src/services/adapters/comfyui-video.ts', import.meta.url), 'utf8')

test('bridge：upscale 默认关，路由可覆盖', () => {
  assert.match(bridge, /def _wf_video\(prompt, w, h, length, refs, seed, prefix, ref_scale=2\.0, upscale=0, selflift=False, sparse=False, guide=None, trim=0, prev_latent=None, save_name=None, window=22, lora=None, lora_strength=1\.0, latent_upscale=0\):/)
  assert.match(bridge, /upscale = int\(b\.get\("upscale"\) or 0\)/)
  assert.match(bridge, /selflift = bool\(b\.get\("selflift"\)\)/)
  assert.match(bridge, /sparse = bool\(b\.get\("sparse", False\)\)/)
  // 路由把它透传进 _wf_video（第 9、10、11 个位置参数）
  assert.match(bridge, /"openai\/h3_" \+ uuid\.uuid4\(\)\.hex\[:8\], ref_scale, upscale, selflift, sparse,\s*b\.get\("guide"\) or None, int\(b\.get\("trim"\) or 0\)/)
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

// 闸只管 FlashVSR 像素超分那条（g["3000"]）。1013 换桥后 native 二采的
// MinimaxH3LatentUpscaler3D 自己写 precision=fp16（conv 上采、实测 302 s 热跑没问题），
// 所以不许再全文禁 fp16 —— 要禁的是「谁把 FlashVSRInitPipe 的 bf16 改成 fp16」。
test('bridge：超分精度用节点默认 bf16（同 2 字节，指数域和 fp32 同宽，不会溢出）', () => {
  assert.match(bridge, /"precision":\s*"bf16"/)
  assert.doesNotMatch(bridge, /FlashVSRInitPipe[\s\S]{0,300}?"precision":\s*"fp16"/)
})

test('bridge：超分插在 VAEDecode 与 CreateVideo 之间，音频旁路', () => {
  assert.match(bridge, /frames_src = "308"/)
  assert.match(bridge, /frames_src = "3081"/)
  assert.match(bridge, /"images":\s*\[frames_src, 0\], "audio":\s*\[audio_src, 0\]/)
  // 视频侧进超分，音频侧仍直取 latent 解码结果 —— 音画不会因超分错位
  assert.match(bridge, /audio_src = "309"/)
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
  // 1009：交付尺寸搬进 `const feed`（非 VOSR2 那支），vf 改用 feed 的宽高 —— 断言跟着改，意思不变
  assert.match(merge, /: \{ w: OUT_W, h: OUT_H \}/)
  assert.match(merge, /scale=\$\{feed\.w\}:\$\{feed\.h\}:force_original_aspect_ratio=increase,crop=\$\{feed\.w\}:\$\{feed\.h\}\$\{finish\}/)
})

test('bridge _selftest 断言超分开/关两种形状', () => {
  assert.match(bridge, /v2 = _wf_video\("a cat", 576, 320, 124, \["qingyi\.jpg"\], 7, "openai\/h3_sr_test", 2\.0, 2\)/)
  assert.match(bridge, /assert "3081" not in v and v\["310"\]\["inputs"\]\["images"\] == \["308", 0\]/)
  assert.match(bridge, /assert not any\(n\["class_type"\] == "ImageScale" for n in v2\.values\(\)\)/)
})

test('adapter：480p 走 SelfLift 864x480（提升靠 latent lift，不叠 FlashVSR）；默认走 SelfLift 到 1.22 MP（1472x832）；首帧路径保持旧口径', () => {
  assert.match(adapter, /const SIZE_480P = '864x480'/)
  assert.match(adapter, /const DEFAULT_SIZE = '1024x768'/) // 1016 定案：20 步无 LoRA 的生产画布
  assert.match(adapter, /const UPSCALE = 0/)
  assert.match(adapter, /const is480 = record\.resolution === '480p'/) // 1016：缺省不再当 480p，走生产默认画布
  // 2026-10-07：1080p 以前是**空设置**（is480 之外全走 DEFAULT_SIZE，所以选 1080p 和选 720p 出图完全一样）。
  // 现在三档：480p → 864x480、1080p → 1920x1080、其它（含 720p 默认）→ 1024x768（1016 定案画布；1472x832 是 4 步 turbo 时代值）。
  // 1080p 这一档本机**还没实测过能不能吃下**（1.22 MP 是台账里这台 8G 目前最高画布）；这条断言只锁映射，不锁结论。
  assert.match(adapter, /const SIZE_1080P = '1920x1080'/)
  // 1016 首尾帧：画布不再有 firstFrameUrl 例外（首尾帧走 native 的 AddGuide 链，同一条 20 步/去 LoRA）
  assert.match(adapter, /size: is480 \? SIZE_480P : \(rawSize \|\| \(record\.resolution === '1080p' \? SIZE_1080P : DEFAULT_SIZE\)\)/)
  assert.match(adapter, /upscale: UPSCALE/)
  // 1008：SelfLift 已下掉（用户定案「720p 直采 → VOSR2 ×2 → 2K」）。回退 = 改回 `!firstFrameFile`。
  assert.match(adapter, /selflift: false,/)
  // 2026-10-03 拍板：transition_step=3（243 帧实测 914s vs t=2 的 2846s，−68%），
  // 代价是身份 0.698→0.635。改回 2 必须带着新的实测理由，别静默回退。
  assert.match(bridge, /"transition_step": 3/)
  assert.match(bridge, /assert v3\["307"\]\["inputs"\]\["transition_step"\] == 3/)
  // 闸：SelfLift 与 FlashVSR 不能同时开 —— 1152x640 再 ×2 = 2304x1280，8G 必炸
  assert.match(bridge, /if upscale and not selflift:/)
})

// 1007 下午两条：① `resolution` 可以直接写画布（以后量档位只改库、不用改代码）
// ② 交付端收尾按源高分叉 —— 720p 上采到 1080p 只加 unsharp（实测锐度 5.2 → 14.1），
//    1080p 直采必须先 gblur 再 unsharp（治 1–2 px 阶梯；纯 blur 会掉 28% 锐度、先放大 2× 再降回 ≈没做）。
//    判据与实测表在 docs/comfyui-h3-configs.md §二十。unsharp 用位置参数：这个 ffmpeg build 不认具名选项。
test('adapter：resolution 可直接写画布；ffmpeg-merge：收尾按源高分叉', () => {
  const gen = readFileSync(new URL('../src/services/generation.ts', import.meta.url), 'utf8')
  assert.ok(gen.includes('/^\\d+x\\d+$/.test(value)) return value'), 'generation.ts 没让 resolution 透传画布')
  assert.ok(adapter.includes('const rawSize = /^\\d+x\\d+$/.test('), 'adapter 没读画布直写的 resolution')
  // 1016 首尾帧：画布不再有 firstFrameUrl 例外（首尾帧走 native 的 AddGuide 链，同一条 20 步/去 LoRA）
  assert.match(adapter, /size: is480 \? SIZE_480P : \(rawSize \|\| \(record\.resolution === '1080p' \? SIZE_1080P : DEFAULT_SIZE\)\)/)
  const merge = readFileSync(new URL('../src/services/ffmpeg-merge.ts', import.meta.url), 'utf8')
  assert.match(merge, /feed\.h >= 1000 \? ',gblur=sigma=0\.5,unsharp=5:5:1\.0' : ',unsharp=5:5:1\.0'/)
  // 不传 input_size = 保持源尺寸（与 1008 的行为一致）；传了才预缩 —— 这条不许被默认值偷偷改掉
  assert.match(merge, /parseSize\(opts\?\.inputSize\) \|\| \{ w: src\.w, h: src\.h \}/)
  // 闸：收尾必须在 crop 之后（先低通再拉边缘），且 blur 半径固定 0.5 —— 改这两个数要带着新的实测理由
  assert.match(merge, /function probeVideoSize\(filePath: string\): Promise<\{ w: number; h: number \}>/)
  // 1008：VOSR2 模式不在交付端先放大（放大是超分模型的活，`inference.py` 的 `_resize_to_target`
  // 会把整批先 bicubic 预放大再上 GPU ⇒ 先放一遍等于付两次钱，而且 tile 数近 2×）。
  assert.match(merge, /const vosrMode = \/\^vosr\/i\.test\(upscaleMode\)/)
  assert.match(merge, /const feed = vosrMode/)
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
