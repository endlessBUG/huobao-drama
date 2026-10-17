/**
 * 批量视频提示词任务 — 异步为缺少 video_prompt 的分镜逐个运行 prompt_generator Agent
 * 进程内内存态：按集跟踪一份任务，运行中不重复启动；重启后状态丢失
 */
import { eq } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { mastra } from '../mastra/index.js'
import { buildAgentRequestContext } from '../agents/context.js'
import { logTaskError, logTaskProgress, logTaskStart, logTaskSuccess } from '../utils/task-logger.js'

export interface VideoPromptBatchStatus {
  status: 'running' | 'done' | 'error'
  total: number
  completed: number
  failed: number
  current_storyboard_id?: number
  started_at: string
  finished_at?: string
  error?: string
}

const tasks = new Map<number, VideoPromptBatchStatus>()

/** 启动批量生成（立即返回）；运行中返回 started:false,total:-1；无待生成分镜返回 started:false,total:0；
 *  传入 storyboardIds 时只处理所选分镜（即使已有提示词也重新生成），否则处理全部缺失提示词的分镜 */
export async function startVideoPromptBatch(
  episodeId: number,
  dramaId: number,
  opts: { model?: string; configId?: number } = {},
  storyboardIds?: number[],
): Promise<{ started: boolean; total: number }> {
  if (tasks.get(episodeId)?.status === 'running') return { started: false, total: -1 }

  const sbs = await db.select().from(schema.storyboards)
    .where(eq(schema.storyboards.episodeId, episodeId))
    .orderBy(schema.storyboards.storyboardNumber)
  const pending = storyboardIds?.length
    ? sbs.filter(sb => storyboardIds.includes(sb.id))
    : sbs.filter(sb => !(sb.videoPrompt || '').trim())
  if (!pending.length) return { started: false, total: 0 }

  // 视频模型标签：跟随该集锁定的视频配置，供 Agent 按模型特性生成
  const [ep] = await db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId))
  let videoLabel = '默认'
  if (ep?.videoConfigId) {
    const [cfg] = await db.select().from(schema.aiServiceConfigs).where(eq(schema.aiServiceConfigs.id, ep.videoConfigId))
    if (cfg) videoLabel = `${cfg.name} (${cfg.provider})`
  }

  const task: VideoPromptBatchStatus = {
    status: 'running',
    total: pending.length,
    completed: 0,
    failed: 0,
    started_at: new Date().toISOString(),
  }
  tasks.set(episodeId, task)

  logTaskStart('VideoPrompt', 'batch', { episodeId, dramaId, total: pending.length, model: opts.model || undefined })
  ;(async () => {
    const agent = mastra.getAgent('prompt_generator')
    if (!agent) throw new Error('视频提示词 Agent 不可用')
    const requestContext = buildAgentRequestContext({
      episodeId,
      dramaId,
      modelOverride: opts.model || undefined,
      textConfigId: opts.configId || undefined,
    })
    // 镜间衔接锁：每条提示词都是独立一次调用，agent 看不到同场别的分镜，跨镜规则（同一场戏不许换边）
    // 根本没机会被遵守。实测同一批 5 条里 2 条直接漏掉站位、其余各写各的 —— 拼起来就是左右横跳。
    // 社区做法：把「上一镜末态」喂给下一条，强制「上一镜末态 = 下一镜起点」。
    // 同场景内才承接（把卧室的走位传给客厅毫无意义），失败的镜不写入末态（不传播错误）。
    let prevScene: number | null | undefined
    let prevTail: { no: number; text: string } | null = null

    for (const sb of pending) {
      if (sb.sceneId !== prevScene) prevTail = null
      prevScene = sb.sceneId
      task.current_storyboard_id = sb.id
      logTaskProgress('VideoPrompt', 'batch-shot', { episodeId, storyboardId: sb.id, index: task.completed + task.failed + 1, total: task.total })
      try {
        // 本机模型一次只出一条固定长度的片段（comfyui-video.ts DEFAULT_LENGTH=124 ≈ 5.17s），
        // 分镜的 duration 就是它。不给这个数，agent 会按「8-15 秒段落」的惯性写到 9 秒（3 段），
        // 多出来的段永远不会被渲染 —— 而且会把 9 秒的动作压进 5.2 秒里。
        const sec = Number(sb.duration) || 0
        const segCount = Math.max(1, Math.ceil(sec / 3))
        const handoff = prevTail
          ? `\n\n上一镜（分镜 #${prevTail.no}，同一场景）结尾的落定状态如下，**本条第一段必须从这里承接**——站位、朝向、手停在哪、持物、视线与之一致；要换位置必须写出可见的动作过程，不许无声换位：\n${prevTail.text}`
          : ''
        await agent.generate([{
          role: 'user',
          content: `请为分镜 #${sb.storyboardNumber}(ID:${sb.id})生成视频提示词(video_prompt) 与全参考提示词(video_prompt_full_ref)。视频模型:${videoLabel}。**本镜视频时长 ${sec.toFixed(1)} 秒，按 3 秒分段共 ${segCount} 段，最后一段的终点写 ${sec.toFixed(1)} 秒，不要写超出这个时长的内容**。
请先调用 read_storyboard_context 获取该分镜的画面描述(含【镜头N】子镜头与台词/旁白)、氛围及时长，据此生成 video_prompt(第一行是信息头：列出该分镜出场的人物与场景，用 @角色名/@场景名 引用；之后按 3 秒分段换行、用 @角色名/@场景名/@道具名 引用参考素材；段落内允许多镜头切镜，段与段可以是不同景别/角度/对象，但不跨场景，切镜点对齐分镜 description 的【镜头N】结构)。同时按技能「六段式英文全参考」生成 video_prompt_full_ref（英文，含 <Subject>/<Picture> 标签，对应同一分镜）。然后调用 update_storyboard 保存到分镜 ID:${sb.id}。update_storyboard 参数只传 storyboard_id、video_prompt、video_prompt_full_ref 三个键,不要回传该分镜的其他任何字段,不要重新拆分整集。
**工具纪律**：第一步 read_storyboard_context；拿到内容后直接写两条提示词并调用 update_storyboard 保存，中途最多再调 2 次 read_prompt_library。**不要用 workspace 的 grep / list_files / read_file 找素材** —— 分镜的画面描述、人物与场景都在 read_storyboard_context 的返回里，探索只会烧步数（1016 实测：一条 60 步全花在 workspace grep 上、一个字没落库；同一条不探索时 3 步就存好）。${handoff}`,
        }], { maxSteps: 24, requestContext })
        // 以实际落库为准判定成败：两个字段都要，只查 video_prompt 会把
        // 「full_ref 恒 NULL」误报成成功（本次 bug 即被这条掩盖）
        const [fresh] = await db.select().from(schema.storyboards).where(eq(schema.storyboards.id, sb.id))
        const missing = [
          !(fresh?.videoPrompt || '').trim() && 'video_prompt',
          !(fresh?.videoPromptFullRef || '').trim() && 'video_prompt_full_ref',
        ].filter(Boolean)
        if (!missing.length) {
          task.completed++
          // 末态 = **真实渲染结尾所在的那一段**，不是最后一段：prompt 可能一路写到 9 秒，
          // 而模型只出得到 5.2 秒，末段根本不会出现在画面里 —— 拿它当末态就是把不存在的画面喂给下一条。
          // 小数要能匹配：真实时长 5.17s → 末段写作 `3-5.2秒`，旧正则 /^\d+-\d+秒/ 因小数点不匹配，
          // 只剩 `0-3秒` 一段 → 末态退化成首段，下一条整段照抄上一条的开头（实测 #4/#5 连台词都重了）。
          const segs = (fresh.videoPrompt || '').split('\n').map(s => s.trim()).filter(s => /^\d+(?:\.\d+)?-\d+(?:\.\d+)?秒/.test(s))
          prevTail = { no: sb.storyboardNumber, text: segs[Math.min(segCount, segs.length) - 1] || '' }
        } else {
          task.failed++
          logTaskError('VideoPrompt', 'batch-shot', { storyboardId: sb.id, error: `agent finished but ${missing.join(' & ')} empty` })
        }
      } catch (err: any) {
        task.failed++
        logTaskError('VideoPrompt', 'batch-shot', { storyboardId: sb.id, error: err?.message })
      }
    }
  })()
    .then(() => {
      task.status = 'done'
      task.finished_at = new Date().toISOString()
      task.current_storyboard_id = undefined
      logTaskSuccess('VideoPrompt', 'batch', { episodeId, total: task.total, completed: task.completed, failed: task.failed })
    })
    .catch((err: any) => {
      task.status = 'error'
      task.finished_at = new Date().toISOString()
      task.error = err?.message || '批量生成失败'
      logTaskError('VideoPrompt', 'batch', { episodeId, error: err?.message })
    })
  return { started: true, total: pending.length }
}

export function getVideoPromptBatchStatus(episodeId: number): VideoPromptBatchStatus | null {
  return tasks.get(episodeId) || null
}
