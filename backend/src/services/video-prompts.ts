/**
 * 批量视频提示词任务 — 异步为缺少 video_prompt 的分镜逐个运行 prompt_generator Agent
 * 进程内内存态：按集跟踪一份任务，运行中不重复启动；重启后状态丢失
 */
import { eq } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { mastra } from '../mastra/index.js'
import { buildAgentRequestContext } from '../agents/context.js'
import { logTaskError, logTaskProgress, logTaskStart, logTaskSuccess } from '../utils/task-logger.js'
import { LORA_REGISTRY } from './adapters/comfyui-video.js'

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
    // 无审核版集（标题含「无审核」）⇒ 床上硬规则换成 1006 实测的取景规则；审核版仍是腰部以上那条。
    // 判据走集标题，不加 schema 字段（一条线就够，设置页改标题即可切换）。
    const uncensored = /无审核/.test(ep?.title || '')
    const anatomyRule = uncensored
      ? `**无审核版取景硬规则（1006 实测 + 1019 用户定案「导演决定是否有生殖器、分镜按 key 取触发词、生成按 key 挂 LoRA」）**：允许裸胸、乳头、外阴、腰以下入画；露乳房/露生殖器的镜头必须写近景或特写（只框胸口以上、或只框腰以下），全身远景画不出结构；**外阴画不画 = 这一镜的 lora_key（调用方在下面把 key 和它的词给你）**——给了 key 的镜头必须把那个词**原样**写进该 [Shot N] 的 detailed_description（词与权重是一套，生成时平台按 key 挂 LoRA）；没给 key 的镜头，外阴只写「大阴唇合拢的一条窄缝（the labia pressed together, one thin closed cleft）」、禁 spread/parted/opening/gaping（实测不带 LoRA 的 spread 画成一坨深色）；手指只写「贴着大腿内侧、停在缝外侧摩挲」，禁「卡在缝两侧」；仍禁并躺双腿互相缠绕/盘腰/夹住（跨中线穿模），接触一律点对点表面接触（膝落腰窝外侧、大腿外侧贴胯骨、掌覆乳）。`
      : `**床上并躺/侧躺硬规则**：一律腰部以上景别；两条提示词正文不得出现 腿/脚/小腿/膝/髋/腰（「腰部以上」除外）与 leg/calf/thigh/knee/hip/waist（「waist up」除外）；亲密接触只写手、手臂、肩、脸。`

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
        // 模型不会自己数【镜头N】：把镜头清单与应有刀数直接写进指令（1018 实测：
        // 2 镜的 12 秒被写成 4 刀，成片在同一场景里切来切去）
        const shotTexts = (sb.description || '').split(/【镜头\d+】/).slice(1).map(s => s.trim()).filter(Boolean)
        const shotPlan = shotTexts.length
          ? `\n**本镜镜头清单（硬约束，不许新增）**：description 有 ${shotTexts.length} 个【镜头N】，两条提示词都必须正好 ${shotTexts.length} 个镜头、${shotTexts.length - 1} 次切镜：\n${shotTexts.map((t, i) => `【镜头${i + 1}】${t.slice(0, 50)}${t.length > 50 ? '…' : ''}`).join('\n')}\n把 ${segCount} 个 3 秒段按顺序分配给这 ${shotTexts.length} 个镜头；同一镜头跨 1-2 段，段首写「镜头保持/继续」，切镜只出现在上面 ${shotTexts.length - 1} 个镜头边界上；full_ref 的 [Shot N] 也必须是 ${shotTexts.length} 个。`
          : ''
        // 1019 用户「分镜根据key获取触发词」：词由代码从登记表取，不让模型自己编
        let loraInfo = ''
        if (sb.loraKey) {
          const reg = LORA_REGISTRY[sb.loraKey]
          const word = reg ? reg.concept || reg.t : undefined
          loraInfo = word
            ? `\n**本镜 lora_key = ${sb.loraKey}**：触发词/概念词 \`${word}\` 必须原样写进英文 full_ref 的 [Shot N]（生成时平台按 key 挂 ${reg!.file}）——不许自己编别的词；这一镜要露生殖器，取景句子只框腰以下。`
            : `\n**本镜 lora_key = ${sb.loraKey} 不在登记表** ⇒ 当没给：不写露、按合拢窄缝处理。`
        }
        await agent.generate([{
          role: 'user',
          content: `请为分镜 #${sb.storyboardNumber}(ID:${sb.id})生成视频提示词(video_prompt) 与全参考提示词(video_prompt_full_ref)。视频模型:${videoLabel}。**本镜视频时长 ${sec.toFixed(1)} 秒，按 3 秒分段共 ${segCount} 段，最后一段的终点写 ${sec.toFixed(1)} 秒，不要写超出这个时长的内容**。${shotPlan}${loraInfo}
请先调用 read_storyboard_context 获取该分镜的画面描述(含【镜头N】子镜头与台词/旁白)、氛围及时长，据此生成 video_prompt(第一行是信息头：列出该分镜出场的人物与场景，用 @角色名/@场景名 引用；之后按 3 秒分段换行、用 @角色名/@场景名/@道具名 引用参考素材；**3 秒段只是时间切片、不是镜头**：同一个【镜头N】跨多个 3 秒段时保持同一景别/机位，段间写「镜头保持/继续」、不写「切到」；只有 description 的【镜头N】边界才切镜，整条提示词的切镜次数必须等于【镜头N】数 − 1，不新增子镜头；不跨场景)。同时按技能「六段式英文全参考」生成 video_prompt_full_ref（英文，含 <Subject>/<Picture> 标签，对应同一分镜）。然后调用 update_storyboard 保存到分镜 ID:${sb.id}。update_storyboard 参数只传 storyboard_id、video_prompt、video_prompt_full_ref 三个键,不要回传该分镜的其他任何字段,不要重新拆分整集。
**工具纪律**：第一步 read_storyboard_context；拿到内容后直接写两条提示词并调用 update_storyboard 保存。**不要再调用任何其他工具**（read_prompt_library 已从本 Agent 摘除，workspace 文件工具也不可用）—— 分镜的画面描述、人物与场景都在 read_storyboard_context 的返回里，多调只会烧步数（1016 实测：一条 60 步全花在无谓探索上、一个字没落库；同一条不探索时 3 步就存好）。
${anatomyRule}
**声音硬规则**：无对白 ≠ 无声。每个无对白段都要写可听见的呼吸/布料摩擦/床架轻响等动作音或环境音，不许用「极静/无声/无人说话/faint/barely audible」把整段压成静音（1018 实测：faint 措辞的成片音频 -55 dB = 没声音）。不新增台词。
**full_ref 三必带（1019 实测：full_ref 里表情/眼神词 14/16 段为零 ⇒ 成片人物不看对方、脸上没表情）**：每个 [Shot N] 的 detailed_description 都要写英文 ① 表情过程（bites her lower lip / brow furrows then releases / eyes half-close / breath deepens / blush spreads to her ears）② 视线落点与移动（her gaze drops to his hand, then flicks away）③ 穿着状态（blouse opened below the collar, chest bare / the quilt pooled at the foot of the bed）。中文 video_prompt 里已有的这些描写**必须原样带进英文 full_ref**，不许压缩掉——真正送模型的是 full_ref（episode.vue:3980 把它当 body.prompt 发）。微表情（眼睑/睫毛级）不写。${handoff}`,
        }], { maxSteps: 24, requestContext })
        // 以实际落库为准判定成败：两个字段都要，只查 video_prompt 会把
        // 「full_ref 恒 NULL」误报成成功（本次 bug 即被这条掩盖）
        const [fresh] = await db.select().from(schema.storyboards).where(eq(schema.storyboards.id, sb.id))
        const missing = [
          !(fresh?.videoPrompt || '').trim() && 'video_prompt',
          !(fresh?.videoPromptFullRef || '').trim() && 'video_prompt_full_ref',
        ].filter(Boolean)
        // 切镜数与 description 的【镜头N】数对齐（update_storyboard 已拒绝错误保存，
        // 这里兜底：Agent 没修就判失败，不让旧提示词蒙混成 completed）
        const shotCount = (sb.description || '').match(/【镜头\d+】/g)?.length || 0
        const vpCuts = (fresh?.videoPrompt || '').match(/切到|切回|切至/g)?.length || 0
        const frCuts = (fresh?.videoPromptFullRef || '').match(/\b(?:camera|shot)\s+(?:cuts|transitions|changes|switches)\s+to\b/gi)?.length || 0
        if (shotCount && (vpCuts !== shotCount - 1 || frCuts !== shotCount - 1)) {
          missing.push(`切镜数(vp ${vpCuts} / full_ref ${frCuts}，应为 ${shotCount - 1})`)
        }
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
