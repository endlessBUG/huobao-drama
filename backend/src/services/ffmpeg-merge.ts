/**
 * FFmpeg 多镜头拼接 — 将所有生成后的镜头视频拼接为一集
 */
import fs from 'fs'
import path from 'path'
import { v4 as uuid } from 'uuid'
import { db, getInsertId, schema } from '../db/index.js'
import { eq } from 'drizzle-orm'
import { now } from '../utils/response.js'
import { logTaskError, logTaskStart, logTaskSuccess } from '../utils/task-logger.js'
import { extractVideoPoster } from '../utils/video-poster.js'
import { ffmpeg, checkFfmpegSuite } from '../utils/ffmpeg.js'
import { interpolateVideoViaDLSS } from './comfyui-dlss.js'
import { upscaleVideoViaSeedVR } from './comfyui-seedvr.js'
import { upscaleVideoViaVOSR } from './comfyui-vosr.js'
import { DATA_ROOT, STORAGE_ROOT } from '../utils/paths.js'

function toAbsPath(relativePath: string): string {
  if (path.isAbsolute(relativePath)) return relativePath
  if (relativePath.startsWith('static/')) return path.join(DATA_ROOT, relativePath)
  return path.join(STORAGE_ROOT, relativePath)
}

// 成片统一落到 1080p。分镜本身是超分后的 1152x640，在这里一次性放大到交付尺寸。
// 为什么放合并处而不是每条分镜各做一次：源和质量完全一样，但全片只算一遍，
// 省掉每条分镜的重复缩放（分镜在 ComfyUI 里缩到 1080p 会让单条耗时从 4.3 分涨到 15 分，
// 且是超线性的 —— 见 adapters/comfyui-video.ts 里 UPSCALE 的实测记录）。
// increase + crop 是「先放满再居中裁」，不是拉伸：源是 1.8（1152/640）、1080p 是 1.7778，
// 拉伸会把每帧横向压 1.25%，落在人脸上就是形变；裁只切掉左右各约 1.2%，肉眼无感。
const OUT_W = 1920
const OUT_H = 1080

/**
 * 拼接一集的镜头视频。
 * 优先使用视频生成产物，兼容历史的 composedVideoUrl 数据。
 * 传入 storyboardIds 时只拼接所选镜头（仍按镜号顺序）。
 */
export async function mergeEpisodeVideos(
  episodeId: number, dramaId: number, storyboardIds?: number[],
  opts?: { interpolateFps?: string; upscale?: string; upscaleFactor?: number; inputSize?: string },
): Promise<number> {
  let storyboards = await db.select().from(schema.storyboards)
    .where(eq(schema.storyboards.episodeId, episodeId))
    .orderBy(schema.storyboards.storyboardNumber)

  if (storyboardIds?.length) {
    const allow = new Set(storyboardIds.map(Number))
    storyboards = storyboards.filter(sb => allow.has(sb.id))
  }

  // 允许部分拼接:按镜号顺序拼接已生成的镜头,未生成的跳过
  const clips = storyboards
    .map(sb => ({ sb, url: sb.videoUrl || sb.composedVideoUrl }))
    .filter(c => Boolean(c.url)) as { sb: typeof storyboards[number]; url: string }[]

  if (clips.length === 0) throw new Error('所选镜头还没有可拼接的视频')

  // 拼接前探测 ffmpeg：二进制损坏时 fluent-ffmpeg 的同步 EFTYPE 会崩掉整个进程，
  // 这里提前拦截并给出可操作的修复指引（路由层会作为 400 返回前端）
  const suite = await checkFfmpegSuite()
  if (!suite.ffmpeg || !suite.ffprobe) {
    throw new Error('本机 ffmpeg 不可用，无法拼接视频（常见于 node_modules 跨平台拷贝或 ffmpeg-static 下载损坏）。请删除 node_modules 后在本机重新 npm install，或设置 FFMPEG_BIN 指向有效的 ffmpeg 可执行文件后重启服务')
  }

  // 校验视频文件真实存在:DB 里的 video_url 可能指向已被清理的文件,
  // 直接拼会得到 ffmpeg 的 "No such file or directory" 晦涩报错
  const missing = clips.filter(c => !fs.existsSync(toAbsPath(c.url)))
  if (missing.length > 0) {
    const nums = missing.map(c => `S${c.sb.storyboardNumber}`).join('、')
    throw new Error(`镜头 ${nums} 的视频文件已丢失（本地文件不存在），请重新生成这些镜头的视频，或在拼接时取消勾选`)
  }

  const videos = clips.map(c => c.url)

  logTaskStart('MergeTask', 'episode-merge', { episodeId, dramaId, clips: videos.length })

  // 创建 merge 记录
  const ts = now()
  const res = await db.insert(schema.videoMerges).values({
    episodeId,
    dramaId,
    title: `Episode ${episodeId} Merge`,
    provider: 'ffmpeg',
    model: 'ffmpeg-concat-h264-aac',
    status: 'processing',
    scenes: JSON.stringify(videos),
    createdAt: ts,
  })
  const mergeId = getInsertId(res)

  // 异步执行
  doMerge(mergeId, episodeId, videos, opts).catch(async err => {
    logTaskError('MergeTask', 'episode-merge', { mergeId, episodeId, error: err.message })
    console.error(`[Merge] Failed:`, err)
    await db.update(schema.videoMerges)
      .set({ status: 'failed', errorMsg: err.message })
      .where(eq(schema.videoMerges.id, mergeId))
  })

  return mergeId
}

// 1007 实测的交付端收尾（判据在 docs/comfyui-h3-configs.md §二十）：
//   720p 采样被上采到 1080p 后边缘发软（正脸区 Laplacian 5.2）→ 加 unsharp 拉回 14.1（2.7×），
//   发丝/发夹边/织纹/背景人脸都回来，且不引入阶梯（源本来就软）。
//   1080p 直采的源边缘带 1–2 px 阶梯（锯齿）→ 必须先 gblur 低通再 unsharp（24.4 vs 原样 16.7；
//   纯 blur 只有 12.0 = 掉 28% 锐度；先放大 2× 再降回 ≈没做）。
// 分叉判据 = 源高：≥1000（1080p 直采）走 blur+unsharp，否则只 unsharp。
// unsharp 用位置参数：这个 ffmpeg build 不认 luma_matrix_size_x 这类具名选项（实测 Option not found）。
function probeVideoSize(filePath: string): Promise<{ w: number; h: number }> {
  return new Promise((resolve) => {
    ffmpeg.ffprobe(filePath, (err, meta) => {
      if (err) return resolve({ w: 0, h: 0 })
      const v = (meta.streams || []).find(s => s.codec_type === 'video')
      resolve({ w: Number(v?.width) || 0, h: Number(v?.height) || 0 })
    })
  })
}

// `body.input_size`（"1280x720"）= 喂给超分模型的尺寸。VOSR2 的 `upscale` 是 Int（`nodes_vosr.py`），
// 所以「1k→2k」只能靠「先把源缩到 1280x720、再让模型 ×2 到 2560x1440」—— 成本 ∝ 模型工作的像素
// （本机两点：×1@2.07 MP = 12.0 s/帧、×2@3.69 MP = 20.9 s/帧，见台账 §二十四），而 1472x832 直接
// ×2 = 2944x1664 = 4.9 MP，比 3.69 MP 贵 1.33×。拿不到合法 WxH 就返回 null（= 保持源尺寸）。
function parseSize(v?: string): { w: number; h: number } | null {
  const m = /^(\d+)x(\d+)$/.exec(String(v || '').trim())
  return m ? { w: Number(m[1]), h: Number(m[2]) } : null
}

async function doMerge(
  mergeId: number, episodeId: number, videos: string[],
  opts?: { interpolateFps?: string; upscale?: string; upscaleFactor?: number; inputSize?: string },
) {
  // 生成 concat 列表文件
  const listDir = path.join(STORAGE_ROOT, 'temp')
  fs.mkdirSync(listDir, { recursive: true })
  const listPath = path.join(listDir, `${uuid()}.txt`)

  const listContent = videos
    .map(v => `file '${toAbsPath(v)}'`)
    .join('\n')
  fs.writeFileSync(listPath, listContent, 'utf-8')

  // 输出文件
  const outputDir = path.join(STORAGE_ROOT, 'merged')
  fs.mkdirSync(outputDir, { recursive: true })
  const outputFilename = `${uuid()}.mp4`
  const outputPath = path.join(outputDir, outputFilename)
  // 1008 加：修复模式要在缩放之前就决定（VOSR2 那条不许 ffmpeg 先放大，见下面 vf 的注释）
  const upscaleMode = String(opts?.upscale || process.env.SEEDVR2_UPSCALE || '').trim()
  const vosrMode = /^vosr/i.test(upscaleMode)
  // 分叉只看第一条的源尺寸（同一集的分镜同源、尺寸一致，不必逐条探）
  const src = await probeVideoSize(toAbsPath(videos[0]))
  // 送进 concat 的尺寸：非 VOSR2 = 交付尺寸（`OUT_W/OUT_H`，见上面注释）；VOSR2 = **喂给模型的尺寸**
  // （`body.input_size`，没给就用源尺寸）—— 放大是模型的活，交付尺寸 = 这个尺寸 × 倍率，所以 concat 之后不再缩。
  const feed = vosrMode
    ? (parseSize(opts?.inputSize) || { w: src.w, h: src.h })
    : { w: OUT_W, h: OUT_H }
  // 收尾分叉按**送进滤镜的高度**而不是源高：预缩到 720 就不该走 gblur 那支（它是为 1080p 直采的边缘阶梯写的）
  const finish = feed.h >= 1000 ? ',gblur=sigma=0.5,unsharp=5:5:1.0' : ',unsharp=5:5:1.0'
  // VOSR2 那条不在这里放大到交付尺寸（放大是模型的活）。三条理由（都有出处）：
  //   · `inference.py` 的 `_resize_to_target` 会把整批 IMAGE **先 bicubic 预放大再上 GPU**，所以 GPU 峰值
  //     = 批大小 × 目标像素；1920×1080 再 ×2 = 3840×2160 = 45 个 512-tile/帧（tile 512、latent stride
  //     56 = 448 px），1280×720 ×2 = 2560×1440 = 24 tile/帧 —— 差近 2×，而 tile 数是线性的（DiT 和
  //     DINOv2 都是每 tile 一次前向，VOSR2Tool 的实测表就是这么拆的）。
  //   · ffmpeg 先放一遍等于付两次钱（模型自己也会 bicubic 预放大）。
  //   · VOSR2Tool（RTX 5060 8 GB 实测）自己的第一杠杆就是「先用 ×1、之后缩放回目标」，同一个理由。
  // 要「1k→2k」就传 `input_size=1280x720` + `upscale_factor=2`：ffmpeg 只做**缩小**（不付两次放大的钱），
  // 模型在 3.69 MP 上工作、直出 2560x1440。不传 input_size = 保持源尺寸（1472x832 ×2 = 2944x1664 = 4.9 MP）。
  const vf = `scale=${feed.w}:${feed.h}:force_original_aspect_ratio=increase,crop=${feed.w}:${feed.h}${finish}`

  await new Promise<void>((resolve, reject) => {
    ffmpeg()
      .input(listPath)
      .inputOptions(['-f', 'concat', '-safe', '0'])
      .outputOptions([
        '-fflags', '+genpts',
        // 放到交付尺寸（见 OUT_W/OUT_H 注释）；VOSR2 模式保持源尺寸等模型 ×2（见上面 vf 的注释）。
        // 源已是同一 pipeline 的产物，分辨率一致，concat 后统一缩放，不必逐条分镜各做一次。
        // 收尾按源高分叉（见 probeVideoSize 上方注释）。
        '-vf', vf,
        '-c:v', 'libx264',
        '-preset', 'medium',
        '-crf', '23',
        '-c:a', 'aac',
        '-ar', '48000',
        '-b:a', '192k',
        '-movflags', '+faststart',
      ])
      .output(outputPath)
      .on('end', () => resolve())
      .on('error', (err) => reject(err))
      .run()

  })

  // 清理临时文件
  fs.unlinkSync(listPath)

  const mergedRelative = `static/merged/${outputFilename}`

  // 1007 加：可选的 SeedVR2 修复（`body.upscale="seedvr2"` 或 env `SEEDVR2_UPSCALE=1`，默认关 = 行为与之前逐字节一致）。
  // 架构 = 低分直采 + 交付端 ffmpeg 放大到 1920×1080（上面已做）+ SeedVR2 一步修复回细节。
  // 挂在 merge 而不是每条分镜：整集一次作业，且不动生成链（接力窗口 22 帧、落盘帧数都不受影响）。
  // 只在成功时原地覆盖（comfyui-seedvr 里 copyFileSync 排在全部校验之后）⇒ 失败仍是 ffmpeg 放大那版。
  // 修复是观感增益不是正确性依赖，所以这里吞掉错误、只记日志，绝不拖垮导出。
  // 1008 加：`body.upscale="vosr2"` 走 VOSR2（上面那条 vf 分叉就是为它 —— 它要的是「模型做放大」而不是
  // 「ffmpeg 先放大、模型再 ×1」）。两个都是可选臂，默认关。
  if (upscaleMode && upscaleMode !== 'off' && upscaleMode !== '0') {
    const cfg = { baseUrl: process.env.COMFYUI_BASE_URL || 'http://127.0.0.1:6006' } as any
    try {
      if (vosrMode) {
        await upscaleVideoViaVOSR(mergedRelative, cfg, {
          upscale: Number(opts?.upscaleFactor || process.env.VOSR2_UPSCALE_FACTOR || 2),
        })
      } else {
        await upscaleVideoViaSeedVR(mergedRelative, cfg)
      }
    } catch (err: any) {
      logTaskError('MergeTask', 'episode-merge-upscale', {
        mergeId, episodeId, upscale: upscaleMode, error: String(err?.message || err).slice(0, 300),
      })
    }
  }

  // 1007 加：可选的 NVIDIA DLSS 补帧（`body.interpolate_fps="60"` 或 env `DLSS_INTERPOLATE_FPS`，默认关 = 行为与之前逐字节一致）。
  // 挂在 merge 而不是每条分镜：① 整集一次作业（实测 2 s/48 帧 → 30.9 s，15 s 条 ≈ +4.2 min，整集 ≈ +24.5 min）
  // ② 不动生成链 —— 接力窗口（22 帧）和落盘帧数都不受影响，补帧只改交付件的 fps。
  // 只在成功时原地覆盖（comfyui-dlss 里 copyFileSync 在全部校验之后）⇒ 失败仍是 24 fps 成片。
  // 补帧是观感增益不是正确性依赖，所以这里吞掉错误、只记日志，绝不拖垮导出。
  const interpFps = String(opts?.interpolateFps || process.env.DLSS_INTERPOLATE_FPS || '').trim()
  if (interpFps) {
    try {
      await interpolateVideoViaDLSS(
        mergedRelative,
        { baseUrl: process.env.COMFYUI_BASE_URL || 'http://127.0.0.1:6006' } as any,
        { fps: interpFps },
      )
    } catch (err: any) {
      logTaskError('MergeTask', 'episode-merge-interpolate', {
        mergeId, episodeId, fps: interpFps, error: String(err?.message || err).slice(0, 300),
      })
    }
  }

  // 获取时长（补帧之后再测，库里记的是最终交付件的值；时长不变、帧率变了）
  const duration = await getVideoDuration(outputPath)

  // 成片海报帧（导出页封面用）
  await extractVideoPoster(mergedRelative)

  // 更新 merge 记录
  await db.update(schema.videoMerges)
    .set({ status: 'completed', mergedUrl: mergedRelative, duration, completedAt: now() })
    .where(eq(schema.videoMerges.id, mergeId))

  // 更新 episode
  await db.update(schema.episodes)
    .set({ videoUrl: mergedRelative, updatedAt: now() })
    .where(eq(schema.episodes.id, episodeId))

  logTaskSuccess('MergeTask', 'episode-merge', { mergeId, episodeId, output: mergedRelative, duration, clips: videos.length })
}

function getVideoDuration(filePath: string): Promise<number> {
  return new Promise((resolve) => {
    ffmpeg.ffprobe(filePath, (err, metadata) => {
      if (err) { resolve(0); return }
      resolve(Math.round(metadata.format.duration || 0))
    })
  })
}
