/**
 * 视频海报帧提取 — 供 <video poster> 使用，避免列表页为显示首帧而缓冲整个视频
 */
import path from 'path'
import { getAbsolutePath } from './storage.js'
import { ffmpeg, checkFfmpegSuite } from './ffmpeg.js'

/** 由视频相对路径推导海报帧路径：static/videos/x.mp4 → static/videos/x_poster.jpg */
export function posterPathFor(relativePath: string): string {
  return relativePath.replace(/\.[^./]+$/, '_poster.jpg')
}

/** 段间接力用：抽末帧（static/videos/x.mp4 → static/videos/x_last.png）。失败返回 null。 */
export function lastFramePathFor(relativePath: string): string {
  return relativePath.replace(/\.[^./]+$/, '_last.png')
}

export async function extractLastFrame(relativePath: string): Promise<string | null> {
  try {
    const { ffmpeg: ffmpegOk } = await checkFfmpegSuite()
    if (!ffmpegOk) return null

    const outRel = lastFramePathFor(relativePath)
    await new Promise<void>((resolve, reject) => {
      ffmpeg(getAbsolutePath(relativePath))
        .inputOptions(['-sseof', '-0.2'])
        // 这张是列表里每行都要加载的图，不缩就是 1.7 MB × N 行
        .outputOptions(['-frames:v', '1', '-vf', 'scale=640:-1'])
        .save(getAbsolutePath(outRel))
        .on('end', () => resolve())
        .on('error', reject)
    })
    return outRel
  } catch (err) {
    console.warn(`[video-poster] 末帧提取失败 ${relativePath}:`, (err as Error).message)
    return null
  }
}
/** 抽取视频 0.5s 处画面作为海报帧（宽 640，等比缩放，与原视频同目录）。失败返回 null，不阻断主流程。 */
export async function extractVideoPoster(relativePath: string): Promise<string | null> {
  try {
    // ffmpeg 二进制损坏（跨平台拷贝 node_modules / 下载不完整）时静默跳过，
    // 避免 fluent-ffmpeg 延迟回调里的同步 EFTYPE 崩掉整个进程
    const { ffmpeg: ffmpegOk } = await checkFfmpegSuite()
    if (!ffmpegOk) return null

    const posterRel = posterPathFor(relativePath)
    const posterAbs = getAbsolutePath(posterRel)
    await new Promise<void>((resolve, reject) => {
      ffmpeg(getAbsolutePath(relativePath))
        .screenshots({
          timestamps: ['0.5'],
          filename: path.basename(posterAbs),
          folder: path.dirname(posterAbs),
          size: '640x?',
        })
        .on('end', () => resolve())
        .on('error', reject)
    })
    return posterRel
  } catch (err) {
    console.warn(`[video-poster] 海报帧提取失败 ${relativePath}:`, (err as Error).message)
    return null
  }
}
