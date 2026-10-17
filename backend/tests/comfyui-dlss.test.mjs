// DLSS 补帧的形状锁 + 接线锁。这些坑全是 1007 实测踩出来的，改回去必须带新的实测理由：
//   · `/prompt` 要 inputs（不是 UI 的 widgets_values）—— comfy_execution/graph.py:131
//   · 必须有 output 节点，且 SaveVideo 的动态组合在 prompt API 里是点号键
//   · FPS_CHOICES 里没有 48（实读 object_info）
//   · 补帧挂在 merge、默认关、失败不抛（补帧是观感增益不是正确性依赖）
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const src = (p) => fs.readFileSync(path.join(root, 'src', p), 'utf-8')
const dlss = src('services/comfyui-dlss.ts')
const merge = src('services/ffmpeg-merge.ts')

test('DLSS 补帧图用 API 的 inputs 形状，不是 UI 的 widgets_values', () => {
  assert.ok(dlss.includes("class_type: 'LoadVideo', inputs:"), 'LoadVideo 必须走 inputs')
  assert.ok(!/buildInterpolateGraph[\s\S]*?widgets_values/.test(dlss), '补帧图里不该再出现 widgets_values')
  assert.ok(dlss.includes("'3': { class_type: 'SaveVideo'"), '必须有 output 节点（SaveVideo），否则 /prompt 报 prompt_no_outputs')
  assert.ok(dlss.includes("'format.codec': 'auto'"), '动态组合在 prompt API 里要用点号键（memory comfyui-graph-gotchas 第 4 条）')
})

test('FPS 档位照实：没有 48，24 fps 的料只能补到 25/30/50/60/90/120', () => {
  assert.ok(!dlss.includes("'48'"), 'DLSS 的 FPS_CHOICES 里没有 48（实测 object_info），别写进去当它存在')
  for (const f of ['60', '120', '30']) assert.ok(dlss.includes(`'${f}'`), `该有 ${f}`)
  assert.ok(dlss.includes('encoding_quality'), '编码质量必须显式给 —— quality=Max 是 libx264 cq 0，2 s 从 1.35MB 涨到 29.35MB')
  assert.ok(dlss.includes('NVENC'), '走 NVENC（实测 encoder=h264_nvenc，Max 那档 CPU libx264 体积炸）')
})

test('只在成功之后才原地覆盖交付件', () => {
  const guard = dlss.indexOf("status !== 'success'")
  const copy = dlss.indexOf('fs.copyFileSync(outAbs, targetAbs)')
  assert.ok(guard > 0 && copy > guard, 'copyFileSync 必须排在 status 校验之后：失败要保留原 24 fps 成片')
  assert.ok(dlss.includes('DLSS 产物不在盘上'), '产物落盘位置要校验，不能假设 history 里有名字就存在')
})

test('补帧挂在 merge：默认关、失败吞掉、补帧之后再测时长', () => {
  assert.ok(merge.includes('DLSS_INTERPOLATE_FPS'), '必须留 env 兜底、默认关（不设 = 行为与之前一致）')
  assert.ok(merge.includes('opts?.interpolateFps ||'), '开关优先走请求体（要能走平台端点触发，不能只靠 env）')
  const route = fs.readFileSync(path.join(root, 'src', 'routes', 'merge.ts'), 'utf-8')
  assert.ok(route.includes('interpolate_fps') && route.includes('{ interpolateFps, upscale: upscaleMode, upscaleFactor, inputSize }'), '路由必须把 body 里的档位传到 mergeEpisodeVideos（1007 SeedVR2 → 两个键；1008 VOSR2 倍率 → 三个键；1009 input_size → 四个键）')
  assert.ok(/catch \(err: any\)[\s\S]{0,240}logTaskError\('MergeTask', 'episode-merge-interpolate'/.test(merge),
    '补帧失败只记日志、不抛 —— 不能让它拖垮导出')
  const interp = merge.indexOf('interpolateVideoViaDLSS(')
  const dur = merge.indexOf('getVideoDuration(outputPath)')
  assert.ok(interp > 0 && dur > interp, '时长必须在补帧之后测（帧率变了、时长不变，库里要记最终交付件）')
  assert.ok(merge.indexOf('const mergedRelative') < merge.indexOf('interpolateVideoViaDLSS('), 'relPath 要先算出来才能喂给补帧')
})
