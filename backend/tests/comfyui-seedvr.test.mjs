// SeedVR2 修复（ComfyUI core 自带）的形状锁 + 接线锁。每条断言都指着源码或本机实测：
//   · `/prompt` 要 inputs（comfy_execution/graph.py:131）；SaveVideo 是 output 节点、动态组合用点号键
//   · 采样设置照本机官方 blueprint `E:/AI/ComfyUI/blueprints/Upscale Video (SeedVR2 3B Int8).json` 内层节点
//   · `chunking_mode` 必须 manual：`nodes_seedvr.py:484` 的 auto = free − 8.5 − 4×0.55 GiB（先扣 10.7 GiB，
//     标定注释 constants.py:3-7 写明是 RTX 5090 + 3b fp16）⇒ 8 GB 上退化成 1 latent 帧/块
//   · `frames_per_chunk` 必须 4n+1（`nodes_seedvr.py:493-497` 会抛）
//   · blueprint 里的 `ResizeImageMaskNode` 本机 `/object_info` 查无此类 ⇒ 放大由调用方预做，图里不许出现它
//   · 修复挂在 merge、默认关、失败不抛（观感增益不是正确性依赖）
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const src = (p) => fs.readFileSync(path.join(root, 'src', p), 'utf-8')
const seedvr = src('services/comfyui-seedvr.ts')
const merge = src('services/ffmpeg-merge.ts')

test('SeedVR2 图用 API 的 inputs 形状，且必须有 output 节点', () => {
  assert.ok(seedvr.includes("class_type: 'LoadVideo', inputs:"), 'LoadVideo 必须走 inputs')
  assert.ok(!/buildUpscaleGraph[\s\S]*?widgets_values/.test(seedvr), '图里不该出现 widgets_values')
  assert.ok(seedvr.includes("class_type: 'SaveVideo'"), '必须有 output 节点，否则 /prompt 报 prompt_no_outputs')
  assert.ok(seedvr.includes("'format.codec': 'auto'"), '动态组合在 prompt API 里要用点号键（memory comfyui-graph-gotchas 第 4 条）')
  assert.ok(!/class_type:\s*'ResizeImageMaskNode'/.test(seedvr), '本机这版 ComfyUI 没有 ResizeImageMaskNode（/object_info 查无此类）⇒ 图里不许用它，放大由调用方预做')
})

test('采样与 VAE 设置照本机官方 blueprint，不许顺手改', () => {
  for (const s of ["steps: 1", "cfg: 1.0", "sampler_name: 'euler'", "scheduler: 'simple'", "denoise: 1.0"]) {
    assert.ok(seedvr.includes(s), `blueprint 的 KSampler 是 ${s}`)
  }
  assert.ok(seedvr.includes('VAEEncodeTiled') && seedvr.includes('VAEDecodeTiled'), 'blueprint 走 tiled VAE（tile 512/overlap 128/temporal 64/8）')
  assert.ok(seedvr.includes('tile_size: 512'), 'tile_size 必须是 512（blueprint 内层节点实测值）')
  assert.ok(seedvr.includes('SeedVR2PostProcessing'), '必须收尾做几何对齐/色彩回贴，否则输出与参考尺寸不一致')
})

test('chunking：8 GB 上必须 manual，且 frames_per_chunk 必须 4n+1', () => {
  assert.ok(seedvr.includes("chunking_mode: 'manual'"), 'auto 那条公式先扣 10.7 GiB（nodes_seedvr.py:484），8 GB 算出来是负数')
  assert.ok(!/chunking_mode:\s*'auto'/.test(seedvr), '不许默认回 auto')
  assert.ok(seedvr.includes('isFourNPlusOne'), '4n+1 要在提交前拦（nodes_seedvr.py:493-497 会抛）')
  assert.ok(seedvr.includes('4n+1'), '错误信息要写清合法档位')
  assert.ok(seedvr.includes("'chunking_mode.frames_per_chunk'"), 'chunking_mode 是 DynamicCombo ⇒ 子键必须点号写法（1007 23:58 实测 /prompt 回 400 required_input_missing chunking_mode.frames_per_chunk）')
  assert.ok(!/'frames_per_chunk':\s*framesPerChunk\b/.test(seedvr), '不许再写平铺的 frames_per_chunk（就是那次 400 的根因）')
  assert.ok(seedvr.includes("original_resized_images: ['2', 0]"), 'PostProcessing 的参照必须是放大后/pad 前那一份（blueprint 里接的是 Resize 输出，不是 Preprocess 输出）')
})

test('只在成功之后才原地覆盖交付件，耗时用 history 的两个时间戳', () => {
  const guard = seedvr.indexOf("status !== 'success'")
  const copy = seedvr.indexOf('fs.copyFileSync(outAbs, targetAbs)')
  assert.ok(guard > 0 && copy > guard, 'copyFileSync 必须排在 status 校验之后：失败要保留原成片')
  assert.ok(seedvr.includes('产物不在盘上'), '产物落盘位置要校验，不能假设 history 里有名字就存在')
  assert.ok(seedvr.includes('execution_success') && seedvr.includes('execution_start'), '耗时口径 = history 的 execution_start→success（脚本那个数含排队）')
  assert.ok(seedvr.includes('Math.random() * 1e15'), 'seed 每次换：同 seed 会命中 ComfyUI 缓存、量不到真耗时')
})

test('修复挂在 merge：默认关、失败吞掉、修复之后再测时长', () => {
  assert.ok(merge.includes('SEEDVR2_UPSCALE'), '必须留 env 兜底、默认关（不设 = 行为与之前一致）')
  assert.ok(merge.includes('opts?.upscale ||'), '开关优先走请求体（要能走平台端点触发，不能只靠 env）')
  const route = fs.readFileSync(path.join(root, 'src', 'routes', 'merge.ts'), 'utf-8')
  assert.ok(route.includes('body?.upscale') && route.includes('upscale: upscaleMode'), '路由必须把 body.upscale 传到 mergeEpisodeVideos')
  assert.ok(/catch \(err: any\)[\s\S]{0,240}logTaskError\('MergeTask', 'episode-merge-upscale'/.test(merge),
    '修复失败只记日志、不抛 —— 不能让它拖垮导出')
  const call = merge.indexOf('upscaleVideoViaSeedVR(')
  const dur = merge.indexOf('getVideoDuration(outputPath)')
  assert.ok(call > 0 && dur > call, '时长必须在修复之后测（库里要记最终交付件）')
  assert.ok(merge.indexOf('const mergedRelative') < call, 'relPath 要先算出来才能喂给修复')
  assert.ok(merge.indexOf('upscaleVideoViaSeedVR(') < merge.indexOf('interpolateVideoViaDLSS('), '先修复再补帧（补帧读的是覆盖后的文件）')
})
