// ponytail: 复制自 minimax-video.parseUrlArray — record.referenceImageUrls 是 generation.ts 的 JSON 串
function parseUrlArray(raw?: string | null): string[] {
  if (!raw) return []
  try {
    const arr = JSON.parse(raw)
    return Array.isArray(arr) ? arr.filter((u) => typeof u === 'string' && u.trim()) : []
  } catch {
    return []
  }
}
// 端点（本机 ComfyUI + ComfyUI-OpenAI-Bridge，OpenAI 兼容）:
//   POST {base}/v1/videos/generations    -> {"id":"..","status":"queued"}     (202，视频默认异步，约 3 分钟)
//   GET  {base}/v1/videos/generations/{id} -> {"id","status","file","url","error"}
//   GET  {base}/v1/files/{path}          -> mp4 字节
//
// 模型: minimax-h3-ref2v（参考图生视频，576x320，默认 124 帧 ≈ 5.2s @24fps）
// 关键差异 vs 官方 MiniMax：images 是「文件名」（落在 ComfyUI input/ 目录），不是 image_url。
// 故本 Adapter 生成前把每个参考图下载/读取进 ComfyUI input/ 目录，再传文件名。
// ponytail: 本地单机够用 —— 作业状态存 ComfyUI 内存，进程重启丢作业；但 mp4 产物仍在 output/。
import type {
  VideoProviderAdapter,
  ProviderRequest,
  AIConfig,
  VideoGenerationRecord,
  VideoGenResponse,
  VideoPollResponse,
} from './types'
import { baseOf, stageReferenceImages, toInputDir } from './comfyui-common'

// 工作流本身动态（JZL ref2v 支持 ref_image_0~8 / Autogrow max=9），不人为截断
const MAX_IMAGES = 9
// 2026-10-03 用户拍板：改走桥的 SelfLift 二采直出（body 带 selflift:true）。
// 前 2 步在 0.5× 低分辨率跑、构图在那里定，后 2 步在目标分辨率真画 —— 所以「抬生成分辨率会毁站位」
// 那条实测教训（352p/416p 优于 768p）在这里仍然成立：低分前缀保住了站位，高分段只补细节。
// 判据（storyboards.id=19，124 帧，同 prompt/refs/seed，ArcFace 余弦）：F2 0.395 vs 超分臂 0.174，
// 特写段右脸 0.542 > ref_a↔ref_b 基线 0.488（唯一越过噪声地板的臂）。锐度更低（18.2 vs 29.2）——
// 赢在「像」不在「清」，所以不再叠 FlashVSR。
// 代价：961s/条（低分 78s + 提升 4.4s + 高分 2×345s，8 瓦片）vs 旧链路 ≈7 分。
// 回退 = DEFAULT_SIZE 改回 '576x320'、UPSCALE 改回 2、body 去掉 selflift。
// 1003 改：默认 480p，分辨率提升靠 SelfLift 的 latent lift（432x240 前缀 → 864x480），不叠 FlashVSR。
// 之前 adapter 完全不看 record.resolution（写死 1152x640），所以「480p」是空设置 —— 这条把它接上。
const SIZE_480P = '864x480'
// 2026-10-05 用户看片定案：SelfLift 到 1.22 MP（1472x832 / 243 帧）—— 同 prompt/refs/seed 单变量
// 对照里它比 1.03 MP（1344x768）有结构（眼窝和上眼睑线在、鼻梁和嘴分得开、发丝成根），用户判「这次不错」。
// 1 MP 那个上限（MAX_PIXELS=768*1344）只卡参考视频（nodes.py:165），不卡输出画布，所以 1.22 MP 照跑。
// 代价：采样 514s vs 409s（+25.7%，正好是 token 多 22% 的量），整单约 34 min/条（冷跑）。
// 直出这个画布在 243 帧会 OOM（墙是 token 数 = 画布 × 帧数），所以只能靠 SelfLift 的分块拿 —— selflift 必须为 true。
// 以上是 4 步 turbo + SelfLift 时代的账，1016 定案后只作史（1472x832 走 rawSize 仍可用，20 步下 ≈16 min/条）。
//
// 1016 定案（用户看片拍板「就用这个」）：生产画布 = 1024×768 满画布、20 步单采、无 turbo LoRA。
// 依据：12 步带 LoRA >750s vs 无 LoRA 454s 单变量 ⇒ 每步 2.25× 的账在 LoRA（每步税 ≥+25 s）；
// 去 LoRA 后 nvfp4 裸权重 27.5 s/步 ⇒ 20 步实测 674 s/条（test/fresh_x2432s20.mp4，账在
// docs/comfyui-h3-configs.md「1016 定案」）。1472×832 在 20 步口径下 ≈16 min/条，超耐心预算，故画布同步收到 768p。
const DEFAULT_SIZE = '1024x768'
// 2026-10-07 加：以前 `is480` 之外全走 DEFAULT_SIZE，所以选「1080p」和选「720p」出图完全一样（空设置）。
// 1007 实测完：1920×1080 会被吸到 **1920×1072**（1080 不是 16 的倍数，H3 VAE 空间下采 = 16）= 2.07 MP，
// 不 OOM 但每条 **117.64 min**（vs 1.22 MP 的 9.94 min = 11.8×）、每像素信息只 1.18–1.39×（13 s 反而 0.96）
// ⇒ 涨的是微观纹理不是结构，而且边缘带 1–2 px 阶梯（锯齿）。用户 1007 判「1080 可以了」⇒ 采样停在 1.22 MP，
// 1080p 只是交付尺寸（`ffmpeg-merge` 的 OUT_W/OUT_H）。判据在 docs/comfyui-h3-configs.md §十七/§二十。
const SIZE_1080P = '1920x1080'
// 1007 下午：`record.resolution` 现在也可以直接写画布（`1728x960` 这种），走下面的 rawSize 分支。
// 挑 1728x960 而不是 1728x972 是有原因的：960/16=60、1728/16=108 都是**双数** ⇒ SelfLift 的 latent lift
// 正好 2.0；而 1920x1080 的 1080/16=67.5 被吸到 67（单数）⇒ 纵向 lift = 67/34 = 1.9706，那条非整数重采样
// 是 1080p 直采带阶梯的嫌疑来源之一。1.66 MP 介于已量的两档之间（1.22 MP = 9.94 min 常驻区、
// 2.07 MP = 117.64 min 换页区）⇒ 这一档是「更高分辨率 + 时间还能接受」唯一还没量过的活口。
// 原 FL2VA_SIZE='576x320' 删于 1016：首尾帧改走 native 的 AddGuide 链（桥），576×320 的 fl2va 图
// 只剩桥里 body `graph:"jzl"` 那条回退，平台适配器不再触达它。
const UPSCALE = 0
const FPS = 24
const DEFAULT_LENGTH = 124
// 模型训练区间 124-362 帧（JZL 节点 tooltip：124 ≈ 5s，训练区间约 124-362）；超出就出训练区，取上界。
const MIN_LENGTH = 124
const MAX_LENGTH = 362

/**
 * 分镜时长（秒）→ 模型帧数。两个硬约束：
 *  1. 帧数必须吸附到 17k+5 网格（节点 align_frame_count 是同款向上取整）。喂非对齐帧数**不报错**，
 *     会被 VAE 静默补帧（重复末帧）——表现成「尾巴卡住」，很容易误判成模型问题。
 *  2. 夹进训练区间 124-362（5.2-15.1s）。12s→294 帧(12.25s)，9s→226(9.42s)，8s→192(8.00s)。
 * 给不出秒数时退回默认 124 —— 与旧行为一致。
 */
export function framesForDuration(seconds?: number | null): number {
  if (!seconds || seconds <= 0) return DEFAULT_LENGTH
  let n = Math.round(seconds * FPS)
  while (n % 17 !== 5) n++
  return Math.min(MAX_LENGTH, Math.max(MIN_LENGTH, n))
}

// 社区 LoRA 的登记表：触发词口径 + 「它是干什么的」。note 直接显示在工作台那个下拉的名字后面
// （用户要求「lora 后面要写上 lora 的作用」），措辞与数抄各家 README / 我们自己的实测，不是编的。
// 没登记的文件 = 只显示文件名、不塞触发词。登记了就必须写 note（测试锁这条）。
export const LORA_REGISTRY: Record<string, { t?: string; replace?: RegExp; note: string }> = {
  'h3-realism-people-t2v-i2v-r2v.safetensors': { t: 'r34l1sm',
    note: '真人质感·去塑料光泽（实测：画面暗 10%、形状不变）' },
  // 作者 README 原话（繁体中文+英文对照）：「正強度偏向 2d 動漫風格，負強度則為寫實」，
  // 且「一開始訓練此 lora 的目的其實是因為 H3 的 2d 動漫風格比較偏向 3d，不夠平面化」——
  // 也就是说这条天生就是治「半 3D 质感」的。推荐区间 -5~5、±3 就足以定风格（不是我们默认的 1.0）。
  // 落点实测 208/208 全中（qkv_proj/out_proj/fc1/fc2，与现役 turbo 同一套目标），无触发词。
  'H3_Ref2V_Anime_Slider_v1.safetensors': {
    note: '2D 动画 ↔ 真人 风格滑杆（正强度偏 2D、负偏写实；作者说 ±3 才定风格、默认 1.0 太弱；无需触发词；落点 208/208 实测）' },
  // HMInnie 的 README 原话：触发词「replaces the word "pussy" in your prompt rather than sitting
  // in front of it」，并且每条训练 caption 都以机位子句开头（我们的六段式本来就有 close-up / framing 子句）。
  // 只换独立成词的 pussy：pussy lips / pussy juice / pussy focus 这些复合词留着（它们是库里验过的实词，
  // 换掉会变成「inniepussy juice」这种没人写过的东西）。
  'HMInnie_v1_e50.safetensors': { t: 'inniepussy', replace: /\bpussy\b(?!\s+(lips|juice|focus|presentation))/gi,
    note: 'innie 形状四轴（实测：结构最可读，但暗 24%）' },
  'Vagina_minimax-h3_epoch20.safetensors': {
    note: '通用解剖 HMPussy V1（训练分布就是 fingering/spreading/show-off）' },
  'HMNSFW-AIO-V2.5.safetensors': { t: 'hmmotion',
    note: '动作姿态 AIO V2.5（作者建议强度 0.5–0.9，只动 mlp）' },
  'minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16.safetensors': {
    note: '4 步蒸馏 —— 桥已默认挂在第一层，再选它等于挂两遍' },
  'minimax_h3_ref2v_turbo_8step_v1.0_768p_comfyui_bf16.safetensors': {
    note: '8 步蒸馏（768p 版）—— 换它要连采样步数一起改' },
  'minimax_h3_fl2v_turbo_4step_v1.0_768p_comfyui_bf16.safetensors': {
    note: 'fl2v（首帧那条）用的 4 步 —— ref2v 别选' },
  'minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors': {
    note: 'fl2v 8 步 —— ref2v 别选' },
  'minimax_h3_fl2v_lightx2v_turbo_4step_v0.1_comfy_resized_avg_rank_21_bf16.safetensors': {
    note: '第三方 lightx2v 重定量的 fl2v 4 步（rank 21）—— ref2v 别选' },
  'Qwen-Image-2.1-viggle-turbo-4step-r64-comfyui-T8.safetensors': {
    note: 'Qwen-Image-2.1 生图的 LoRA，对 H3 视频无效（键名对不上，会被静默跳过）' },
  'lightx2v_I2V_14B_480p_cfg_step_distill_rank64_bf16.safetensors': {
    note: 'Wan 14B 的蒸馏 LoRA，对 H3 视频无效' },
}

export class ComfyUIVideoAdapter implements VideoProviderAdapter {
  provider = 'comfyui'

  async buildGenerateRequest(config: AIConfig, record: VideoGenerationRecord): Promise<ProviderRequest> {
    const base = (record.prompt || '').trim()
    if (!base) throw new Error('ComfyUI 视频生成要求必须提供提示词（prompt）')
    const tr = record.lora && record.loraTrigger !== false ? LORA_REGISTRY[record.lora] : undefined
    // 只有登记了 t 的才碰词。HMPussy V1 的触发词就是普通词 pussy（我们提示词里本来就有 12 处），
    // 前置一遍是重复 —— 所以它只登记 note、不登记 t，prompt 一字不改（D 臂实测就是这么跑的）。
    const prompt = !tr?.t ? base : tr.replace ? base.replace(tr.replace, tr.t) : `${tr.t} ${base}`

    const inputDir = toInputDir(config)
    const images = await stageReferenceImages(parseUrlArray(record.referenceImageUrls), inputDir, MAX_IMAGES)
    // 帧锚走桥的 MiniMaxH3AddGuide（不是 ref 槽）：ref_image_0~8 与 keyframe 在同一个
    // cond_video_latents 里并存（comfy/model_base.py:2188-2196），不互斥。
    const guideFile = record.guideUrl ? (await stageReferenceImages([record.guideUrl], inputDir, 1))[0] : undefined
    if (images.length === 0) {
      // 桥会把 images 填默认 qingyi.jpg / xueqi.jpeg；此处显式传空即可，
      // 但为明确起见传 []（桥内部 _wf_video 会对不足 2 张补空串）
    }

    // 1016 首尾帧（用户「首尾帧也要支持」）：两张各自 staging（桥要的是 input/ 里的文件名）。
    // 缺失/空 = 不 staging、body 就没这个键 ⇒ 桥那边不进 AddGuide 链（图与不加帧时逐字节一致）。
    const firstFrameFile = record.firstFrameUrl
      ? (await stageReferenceImages([record.firstFrameUrl], inputDir, 1))[0]
      : undefined
    const lastFrameFile = record.lastFrameUrl
      ? (await stageReferenceImages([record.lastFrameUrl], inputDir, 1))[0]
      : undefined

    // 1016 定案：没填 resolution 的存量行 = 走生产默认画布，不再当 480p —— 480p 只由显式选择触发。
    // （DDL 里 `resolution TEXT DEFAULT '480p'` 管住新行；这里只管 NULL/空的历史行。）
    const is480 = record.resolution === '480p'
    // `resolution` 直接是画布（`1728x960`）时绕过所有档位名 —— JZL 节点自己把宽高吸到 32 网格，
    // 所以这里不校验，只透传。加这一条是为了量分辨率档位不用每次改代码（1007）。
    const rawSize = /^\d+x\d+$/.test((record.resolution || '').toLowerCase()) ? (record.resolution as string).toLowerCase() : null

    return {
      method: 'POST',
      url: `${baseOf(config.baseUrl)}/v1/videos/generations`,
      headers: { 'Content-Type': 'application/json' },
      body: {
        prompt,
        model: (record.model || config.model || 'minimax-h3-ref2v') || 'minimax-h3-ref2v',
        size: is480 ? SIZE_480P : (rawSize || (record.resolution === '1080p' ? SIZE_1080P : DEFAULT_SIZE)),
        length: framesForDuration(record.duration),
        images,
        ref_scale: 2.0,
        upscale: UPSCALE,
        // 1008 用户定案「720p 直采 → VOSR2 ×2 → 2K」⇒ 二采（SelfLift 的 latent lift + 高分那一步）不再做。
        // 账（台账 §当前最优，243 帧 @1.22 MP）：整单 514 s = 低分 3 步 192.8 + transition 12.3 +
        // 高分 1 步 8 块 308.9 ⇒ 下掉省的是 321 s/条，代价是画布掉到 1280×720、细节改由交付端 VOSR2 补
        // （`ffmpeg-merge` 的 `body.upscale="vosr2"`）。回退 = 这行改回 `!firstFrameFile`。
        selflift: false,
        // 1016 定案（用户拍板）：20 步单采 + 去 turbo LoRA —— 桥那支 `no_lora:true` 摘掉 LoraLoaderModelOnly
        // 节点、model 直吃 UNETLoader。首尾帧走同一条（用户「首尾帧也要支持」）：桥在 7 号 conditioning
        // 后面串 MiniMaxH3AddGuide（首帧 frame_idx 0 / 尾帧 -1），画布与步数没有例外。480p/1080p/rawSize
        // 同样 20 步（档位是用户显式选择，耗时自己承担；1080p 会到 ≈26 min）。实测锚 = x2432s20 674 s。
        steps: 20,
        no_lora: true,
        first_frame: firstFrameFile,
        last_frame: lastFrameFile,
        // 1017（用户「保存 然后接入」）：给文件名就换图跑（桥 `_wf_saved`，按消费者角色填动态量）；
        // 不给 = 桥默认 native（1016 定案那条），与之前逐字节一致。
        graph: record.graph || undefined,
        guide: guideFile,
        prev_latent: record.prevLatent || undefined,
        save_name: record.saveName || undefined,
        trim: record.trimFrames || 0,
        lora: record.lora || undefined,
        lora_strength: record.lora ? (record.loraStrength ?? 1.0) : undefined,
        // 不传 = 桥里那格整段不出现，图与老行为逐字节一致（和 lora 同一个口径）。
        // 1016 夜改：`false` 要能真发出去。桥 `__init__.py:1012` 判的是 `b.get("sparse") is False`，
        // 老写法 `record.sparse ? true : undefined` 把 false 和「没传」混成一谈 ⇒ dense 对照臂永远进不去。
        // 今晚 18 连卡（GPU 100% @ 42 W、step 0 不动、磁盘读 0、硬缺页 0，而同进程一条 512×384 的
        // krea2 出图 40 秒跑完 = 机器是好的）⇒ 用 body `sparse:false` 走 dense 对照。
        sparse: record.sparse ?? undefined,
        seed: record.seed ?? undefined,
      },
    }
  }

  parseGenerateResponse(result: any): VideoGenResponse {
    if (result.id) return { isAsync: true, taskId: String(result.id) }
    if (result.url) return { isAsync: false, videoUrl: result.url }
    throw new Error('ComfyUI 视频响应异常：缺少 job id')
  }

  buildPollRequest(config: AIConfig, taskId: string): ProviderRequest {
    return {
      method: 'GET',
      url: `${baseOf(config.baseUrl)}/v1/videos/generations/${taskId}`,
      headers: {},
      body: undefined,
    }
  }

  parsePollResponse(result: any): VideoPollResponse {
    const status = (result.status || '').toLowerCase()
    if (status === 'queued' || status === 'running' || status === 'pending') {
      // 桥 1012 起带真步数（ws 旁听 ComfyUI 的 progress 事件）；老桥没这个键就是 undefined
      const pr = result.progress && Number.isFinite(result.progress.pct) ? result.progress.pct : undefined
      return { status: 'processing', progress: pr }
    }
    if (status === 'succeeded') {
      return { status: 'completed', videoUrl: result.url, duration: (result.length || DEFAULT_LENGTH) / FPS }
    }
    return { status: 'failed', error: result.error || `ComfyUI 视频生成失败（status: ${status}）` }
  }

  extractVideoUrl(result: any): string | null {
    return result.url || null
  }

  // 实测锚（history `execution_start→execution_success`，124 帧整单、含解码+存盘）：
  // 576x320 = 126 s（1.016 s/帧）· 864x480 = 364 s（2.936）· 1472x832 = 270 s（2.177，4 步 turbo 时代）。
  // 1024x768 = 674 s/243 帧 = 2.774 s/帧（1016 定案 20 步无 LoRA 实测，换算 124 帧 ≈344 s）。
  // 1920x1080 没测过，按像素比从 1472x832 外推（3.70 s/帧）—— 冷跑/排队/装载都不在锚里，进度只是估算，
  // 上限 95%，真完成由 poll 的 succeeded 定。
  progressHint(record: VideoGenerationRecord): number | undefined {
    const frames = framesForDuration(record.duration)
    const rawSize = /^\d+x\d+$/.test((record.resolution || '').toLowerCase()) ? (record.resolution as string).toLowerCase() : null
    const size = rawSize || (record.resolution === '1080p' ? SIZE_1080P : record.resolution === '480p' ? SIZE_480P : DEFAULT_SIZE)
    const secPerFrame: Record<string, number> = { '576x320': 1.016, '864x480': 2.936, '1024x768': 2.774, '1472x832': 2.177, '1920x1080': 3.70 }
    const spf = secPerFrame[size]
    return spf ? Math.round(frames * spf) : undefined
  }
}
