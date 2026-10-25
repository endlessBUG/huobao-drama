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
// 1018 深夜用户：「刚才的效果不好」→ 先试了仓库 4 步 turbo LoRA，仍判不好 →
// 定案「换成1采 20步 试试 只改这个 不要lora」⇒ 走桥的 native 图（`_wf_video_native`），
// 单采 20 步、`no_lora:true` 摘掉 4 步 turbo、也不再透传分镜 lora。
// 1024 用户「重做 换成不要lora 1采 20步 试试」⇒ 回 1018 深夜定案：走桥的 native 图、单采 20 步、
// no_lora:true 摘掉任何 LoRA（PDD 5 步那档判「效果不好」，撤回）。PDD 图仍在盘上（h3_refall_pdd5_gpute.json），
// 要再加速改回 PROD_GRAPH + steps 即可。回退记录见 docs/comfyui-h3-configs.md「当前最优」。
const PROD_GRAPH = 'native'
// 1025 19:5x 用户看片判「可以」⇒ 不挂 LoRA 的镜走 PDD 5 步快图（task 683 = 542 s 整单 vs native 20 步 992 s，
// 同尺 MAD 5.15 ≤ 5.82、高频 338 vs 644 更软但用户认）。**只给无 LoRA 的镜**：桥的 saved-graph 分支
// （`__init__.py:1123-1128` 调 `_wf_saved`）只填提示词/画布/帧数/参考/首尾帧/seed/前缀，**不认 body `lora`**
// ⇒ 解剖镜挂到这张图上会静默丢 LoRA。挂 `lora_key` 的镜照旧走 native（20 步 + LoRA，1023 定案）。
const PROD_GRAPH_FAST = 'h3_refall_pdd5_gpute.json'
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

// LoRA 登记表：**按类型 key 登记，key = 这条 LoRA 给模型加的功能**（1019 用户「每个lora应该有个类型key
// 传列表给导演 让导演决定有哪个key，然后分镜根据key获取触发词 视频生成挂key对应的lora」「key是描述模型功能的」）。
//   key      = 功能（导演按镜头需要什么功能来挑；写进 storyboards.lora_key）
//   file     = 生成时挂的文件（桥 native 图的节点 210，`__init__.py:463-465`）
//   t        = 要**前置**的触发 token（作者把 token 当开关的那类）
//   concept  = 要**写进句子**的英文短语（解剖那类）—— 不前置：前置生造 token 会撞六段式格式
//   prompt   = 这条 LoRA 的**最优提示词**（1019 用户「我是说lora的定义里 加上最优提示词」「描述 lora 的
//              提示词要放到 lora 的定义里 然后引进用来 而不是放到主提示词里」）：主提示词里那段描述它的
//              话从这里取、原样引进，模型不许自己编；不写这个字段 = 它的触发词本身就是全部描述语
//   note     = 功能的详细说明 + 实测（显示在工作台下拉名字后面、也是导演挑 key 的依据；
//              用户「lora 后面要写上 lora 的作用」「lora登记的时候也要登记触发词」）
// 没登记的文件 = 下拉里只显示文件名、没有 key、不塞词。登记了就必须写 note（测试锁这条）。
export const LORA_REGISTRY: Record<string, {
  file: string; t?: string; concept?: string; prompt?: string; note: string;
  // 1023 用户「登记lora的时候要登记配置信息 / 分镜选择lora的时候要产出 lora的配置」：`config` = 这条
  // LoRA 的配置（用法 + 出处）。导演挑 key 时那份清单会把它产出（`agents/index.ts`）、UI 下拉路由也带
  // 它（`routes/comfyuiLoras.ts`）、生成时 steps/strength 也从这里取（本文件 adapter）。只填有证据的
  // 字段（作者卡片 / 实测 / 落点），没数据的不编。
  config?: {
    strength?: number; steps?: number; sampler?: string; trigger?: string;
    base?: string; trainedOn?: 'video' | 'image'; source?: string;
    num_frames?: number; do_i2v?: boolean;
  };
  // 1019 用户「这里要根据角色选择合理的提示词。 这里是通用提示词」：prompt 里可以留 `{skin}` 占位，
  // 由代码按这一镜的角色肤色换成对应档 —— 登记表那段是通用骨架，不写死某一个人的颜色。
  skinVariants?: { words: string[]; text: string }[]; skinDefault?: string;
}> = {
  skin_realism: { file: 'h3-realism-people-t2v-i2v-r2v.safetensors', t: 'r34l1sm',
    config: { strength: 1.0, steps: 20, trigger: 'r34l1sm', base: 'MiniMax H3', trainedOn: 'video', source: 'civitai h3-realism-people' },
    note: '功能：真人皮肤质感、去塑料光泽（实测：画面暗 10%、形状不变）' },
  // 作者 README 原话（繁体中文+英文对照）：「正強度偏向 2d 動漫風格，負強度則為寫實」，
  // 且「一開始訓練此 lora 的目的其實是因為 H3 的 2d 動漫風格比較偏向 3d，不夠平面化」——
  // 也就是说这条天生就是治「半 3D 质感」的。推荐区间 -5~5、±3 就足以定风格（不是我们默认的 1.0）。
  // 落点实测 208/208 全中（qkv_proj/out_proj/fc1/fc2，与现役 turbo 同一套目标），无触发词。
  style_2d3d_slider: { file: 'H3_Ref2V_Anime_Slider_v1.safetensors',
    config: { strength: 3.0, steps: 20, base: 'MiniMax H3', trainedOn: 'video', source: 'civitai H3_Ref2V_Anime_Slider' },
    note: '功能：2D 动画 ↔ 真人 风格滑杆（正强度偏 2D、负偏写实；作者说 ±3 才定风格、默认 1.0 太弱；无需触发词；落点 208/208 实测）' },
  // 1023 用户「用这个（Free Pussy 2934054）删原来的lora 换20步 注册这个lora和提示词」⇒ 文件换
  // `free_pussy.safetensors`（Civitai 2934054、**video-trained**、作者「trained on a metric fuckton of
  // pussy」= 数据最多的一条、trigger `pussy`、作者没给推荐强度 → 默认 1.0 起、看片再抬）、删 2885332、
  // steps 回 20（不再分档）。落点已对**生产 NVFP4 unet**（`minimax_h3_ref2va_pruned_nvfp4`）验过 0 缺失
  // （208 键全中）。提示词沿用这轮的通用改进（正面机位治「竖肉」+ 双侧构成 + plump tender 粉嫩肥美 +
  // {skin} 分档）—— 它是通用骨架、不绑某条 LoRA。下面 1019/1022 的 2885332 史保留作背景。
  // 1019 用户定案（「就这个了 其他的都删掉」）：外阴解剖只留这一条 —— civitai 2885332 v0.2
  // （version id 3306941，148MB，LoKr rank16 bf16，ostris/ai-toolkit，作者自报「测试品、10 条片」）。
  // 触发词登记（用户「lora 登记的时候也要登记触发词」）：Civitai 的 trigger_word = null、trainedWords
  // 为空 ⇒ 没有专用 token，概念就是英文短语 `pussy spread`（作者按官方 H3 提示词指南写 caption）。
  // 被否掉的文件已删（HMInnie 2853405、HMPussy V1 2846342 的 74MB stills 半条、Vagina 2835594）——
  // 上一轮「太丑」的根因 = **单挂 stills 半条跑 20 步视频**（作者：视频半条是另一个 597MB 文件、两条一起挂、强度 0.35）。
  // **最优提示词**（1019 用户「lora 的定义里 加上最优提示词」）—— 出处逐条：景别收到 `close-up`（实测
  // `extreme close-up` 会把器官画满整幅 = 「阴部太大了」）；`labia rosy pink` 颜色词（肤色是普通英文描述词、
  // 不靠 LoRA —— HMInnie README 的 Labia colour 轴 = matching skin/pink/rosy/brown，文件已删、词留下）；
  // `soft neutral light`（实测 `candlelight directly illuminating` 把粉压成橙）；`detailed pussy` =
  // 「让模型真去描这块」的开关（`docs/prompt-vulva-terms.md` §七 第 22 条：不给 focus/detailed/realistic
  // 这类开关，模型会把那块画成没有结构的色片 —— 1006 实测；§30 明写「借它的词，别借它的格式」所以当自然短语用）。
  // **1021 用户「不要描述阴道的形状 可以说颜色」⇒ 尺寸词整段摘掉、换成禁止词行**：原先的
  // `a small narrow vulva, labia modest in frame`（1019 为「阴部太大了」加的）与 LoRA 自己的概念
  // `pussy spread`（张开）是**反义**，写在同一句里 = 模型折中成「不明显」。A/B 实测坐实（同 seed、同
  // 1024×768、同 124 帧、只差挂不挂：`data/generated/ab124-16.mp4` vs `ab124-236.mp4`，18 分）：A 有粉色
  // 像素（下半中右块 0.11-0.15%）而 B 全帧 0.00%、A 的粉色块与作者 #6 同区、**幅度只有他的 1/27**（他 4.09%）。
  // 挂法四层全对（桥 `__init__.py:463-465` 接线、`comfy/lora.py:185-190` 认这套 PEFT 命名、落点 208/208
  // 全命中含 `token_refiner`、`comfy/weight_adapter/lora.py:247-251` alpha 无衰减）⇒ 削弱来自
  // `comfy/model_patcher.py:912-923`：被 patch 的层先反量化到 fp16、加完 delta 再 `comfy.float.
  // stochastic_rounding` **重新量化回 NVFP4**（每元素 ~2 bit），而他训练底模是 `qtype: "convrot8"`
  // （int8，8 bit/元素）⇒ 同一条 delta 在我们这天然弱一档；`comfy/cli_args.py` 里 lora/quant flag 零命中
  // = 这条路没有开关。强度 1.0/0.7 画面同（577/578 各 1633 s、一字不差）。
  // **颜色那一格按角色换档**（用户 1019「这里要根据角色选择合理的提示词。 这里是通用提示词」）：
  // 词表照抄 HMInnie README 的 Labia colour 轴；`skinDefault` = pink（用户 1019 判「不够粉嫩」）。
  // 角色 `appearance` 现在全空 ⇒ 实际恒走 default；要真分档得先在资产层把肤色填进 appearance。
  // **1022 用户「换回原来的」= 回 2885332（video-trained、你说「质感不错」、不毁原内容）**：SynthPussy
  // （image-trained、500 静图）@1.5 判「太丑、影响到原视频内容了」—— 它的先验哪怕 @0.3 也弱、@1.5 又毁内容；
  // HMPussy/Cunnilingus 在 fp4 上密度都很低（全走 `ops.py:318` 重新量化那条、无一 nvfp4-原生）。2885332@1.5
  // 是 fp4 上密度最高的一条（arm34 正面 2.10% / arm20 2.78%）。文件回 2885332、强度回 1.5（它的甜点位）。
  // **保留这轮的通用改进**（不是 SynthPussy 专属、是修 2885332 的「竖肉/不够粉」）：正面机位（治「竖肉」=
  // 旧版 `overhead` 顶视把外阴前后轴压成一条竖线）+ 双侧构成（两瓣+开前庭+顶端阴蒂）+ `plump tender`（你要的
  // 粉嫩肥美）+ 挂 LoRA 的镜 30 步（arm20 中缝 +6→+34）。旧的 `No shape or size words...` 指令句仍不要（指南零指令）。
  // 被否掉的文件已删（HMInnie 2853405、HMPussy V1 2846342 的 74MB stills 半条、Vagina 2835594）——
  // 上一轮「太丑」的根因 = **单挂 stills 半条跑 20 步视频**（作者：视频半条是另一个 597MB 文件、两条一起挂、强度 0.35）。
  // 触发词：Civitai trigger_word = null、trainedWords 空 ⇒ 没有专用 token，概念就是英文短语 `pussy spread`。
  // **1021 用户「不要描述阴道的形状 可以说颜色」**：不写尺寸词（small/narrow/wide/deep 等），颜色走 {skin} 分档。
  // 景别收到 `close-up`（实测 `extreme close-up` 把器官画满整幅 = 「阴部太大了」）；`detailed pussy` = 让模型真描这块的开关。
  pussy_spread: { file: 'free_pussy.safetensors', concept: 'pussy',
    config: { strength: 1.0, steps: 20, trigger: 'pussy', base: 'MiniMax H3', trainedOn: 'video', source: 'civitai 2934054 Free Pussy' },
    prompt: 'a close-up from the front, framed between her spread thighs, her vulva facing the camera, pussy spread, detailed pussy, the vulva formed by two symmetric outer labia on the left and right with an open vestibule between them, inner labia visible, the clitoris at the top where the inner labia meet, the urethral opening and vaginal opening visible in the open center, {skin}, plump tender labia, soft neutral light on her lower body.',
    skinVariants: [
      { words: ['黑', '深', '小麦黑', 'brown', 'dark', 'suntan'], text: 'labia brown, a shade darker than her thighs' },
      { words: ['黄', '麦', 'olive', 'tan', 'medium', 'warm'], text: 'labia colour matching her own skin tone' },
      { words: ['白', '瓷', 'fair', 'pale', 'ivory', 'light'], text: 'labia rosy pink' },
    ], skinDefault: 'labia rosy pink',
    note: '功能：把外阴画成张开形态（导演决定「露出外阴」的镜选它）· 概念词 = pussy；1023 换成 Free Pussy（2934054、video-trained、数据最多、不毁内容、落点已对生产 NVFP4 验 0 缺失）+ 正面机位（治竖肉）+ 双侧构成 + 粉嫩肥美（plump tender）；默认强度 1.0、挂 LoRA 镜 20 步' },
  sex_motion: { file: 'HMNSFW-AIO-V2.5.safetensors', t: 'hmmotion',
    config: { strength: 0.7, steps: 20, trigger: 'hmmotion', base: 'MiniMax H3', trainedOn: 'video', source: 'civitai HMNSFW-AIO-V2.5' },
    note: '功能：性爱动作/姿态 AIO V2.5（作者建议强度 0.5–0.9，只动 mlp）' },
  distill_ref2v_4step: { file: 'minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16.safetensors',
    config: { steps: 4, base: 'MiniMax H3', trainedOn: 'video', source: '官方 ref2v turbo 4step' },
    note: '功能：4 步蒸馏（少步数）—— 桥已默认挂在第一层，再选它等于挂两遍' },
  distill_ref2v_8step: { file: 'minimax_h3_ref2v_turbo_8step_v1.0_768p_comfyui_bf16.safetensors',
    config: { steps: 8, base: 'MiniMax H3', trainedOn: 'video', source: '官方 ref2v turbo 8step 768p' },
    note: '功能：8 步蒸馏（768p 版）—— 换它要连采样步数一起改' },
  distill_fl2v_4step: { file: 'minimax_h3_fl2v_turbo_4step_v1.0_768p_comfyui_bf16.safetensors',
    config: { steps: 4, base: 'MiniMax H3', trainedOn: 'video', source: '官方 fl2v turbo 4step' },
    note: '功能：fl2v（首帧那条）的 4 步蒸馏 —— ref2v 别选' },
  distill_fl2v_8step: { file: 'minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors',
    config: { steps: 8, base: 'MiniMax H3', trainedOn: 'video', source: '官方 fl2v turbo 8step' },
    note: '功能：fl2v 8 步蒸馏 —— ref2v 别选' },
  distill_fl2v_lightx2v: { file: 'minimax_h3_fl2v_lightx2v_turbo_4step_v0.1_comfy_resized_avg_rank_21_bf16.safetensors',
    config: { steps: 4, base: 'MiniMax H3', trainedOn: 'video', source: 'lightx2v fl2v 4step rank21' },
    note: '功能：第三方 lightx2v 重定量的 fl2v 4 步（rank 21）—— ref2v 别选' },
  qwen_viggle_4step: { file: 'Qwen-Image-2.1-viggle-turbo-4step-r64-comfyui-T8.safetensors',
    config: { steps: 4, base: 'Qwen-Image-2.1', trainedOn: 'image', source: 'viggle turbo 4step' },
    note: '功能：Qwen-Image-2.1 生图的 4 步蒸馏 —— 对 H3 视频无效（键名对不上，会被静默跳过）' },
  wan_i2v_distill: { file: 'lightx2v_I2V_14B_480p_cfg_step_distill_rank64_bf16.safetensors',
    config: { steps: 4, base: 'Wan 14B', trainedOn: 'video', source: 'lightx2v wan i2v distill' },
    note: '功能：Wan 14B 的蒸馏 —— 对 H3 视频无效' },
}

// 文件名 → 登记项（下拉与老调用方传的是文件名，key 反查用这张）
export const LORA_BY_FILE: Record<string, { key: string; file: string; t?: string; concept?: string; note: string;
  config?: { strength?: number; steps?: number; sampler?: string; trigger?: string; base?: string; trainedOn?: 'video' | 'image'; source?: string; num_frames?: number; do_i2v?: boolean } }> =
  Object.fromEntries(Object.entries(LORA_REGISTRY).map(([key, v]) => [v.file, { key, ...v }]))

/** 这条 LoRA 的「最优提示词」= 主提示词里描述它的那段话，从登记表取、原样引进（1019 用户
 *  「描述 lora 的提示词要放到 lora 的定义里 然后引进用来 而不是放到主提示词里」）。
 *  没单独写 prompt 字段的 = 它的触发词本身就是全部描述语。
 *  `skinText`（这一镜出场角色的 appearance/styling 文本）只用来换 `{skin}` 那一格 —— 登记表本身是通用的，
 *  角色相关的部分由代码按数据选，不让小模型自己编肤色（1019 用户「这里要根据角色选择合理的提示词」）。 */
export function loraBestPrompt(key?: string | null, skinText?: string | null): string {
  const reg = key ? LORA_REGISTRY[key] : undefined
  if (!reg) return ''
  const best = reg.prompt || reg.concept || reg.t || ''
  if (!best.includes('{skin}')) return best
  const low = (skinText || '').toLowerCase()
  const hit = (reg.skinVariants || []).find(v => v.words.some(w => low.includes(w.toLowerCase())))
  return best.replace('{skin}', hit?.text || reg.skinDefault || reg.skinVariants?.[0]?.text || '')
}

export class ComfyUIVideoAdapter implements VideoProviderAdapter {
  provider = 'comfyui'

  async buildGenerateRequest(config: AIConfig, record: VideoGenerationRecord): Promise<ProviderRequest> {
    const base = (record.prompt || '').trim()
    if (!base) throw new Error('ComfyUI 视频生成要求必须提供提示词（prompt）')
    // 词由 key 决定（1019 用户「分镜根据key获取触发词」）：token 型（`t`）前置；concept 型的词已经
    // 写进提示词正文（`video-prompts.ts` 按 key 注入的），调用方给 `loraTrigger:false` = 一个字都不动。
    // 已经在正文里就别再前置一遍（1019 实测 #17 的 full_ref 自带 r34l1sm ⇒ 前置会变成两次，共享这一处
    // 判掉，UI / 驱动 / 兜底补写三条路都过这里）
    const tr = record.lora && record.loraTrigger !== false ? LORA_BY_FILE[record.lora] : undefined
    const prompt = !tr?.t || base.toLowerCase().includes(tr.t.toLowerCase()) ? base : `${tr.t} ${base}`

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
        // 1018 深夜第二次（用户「换成1采 20步 试试 只改这个 不要lora」）：native 图的单采 20 步、
        // 不带任何 LoRA（`no_lora:true` 摘掉桥的 4 步 turbo 节点 2；分镜的 lora 也不再透传）。
        // steps 填 native 的 BasicScheduler(simple)。首尾帧仍走 AddGuide（0 / -1）。
        // 参考锚：243 帧 20 步 674 s（test/fresh_x2432s20.mp4）；294 帧约 20 分钟（GPU TE 已把固定税降到 ~53 s）。
        // 1023 用户「换20步」+「分镜选择 lora 时产出 lora 的配置」⇒ steps 从这条 LoRA 的 config 取
        // （Free Pussy config.steps=20；没挂 LoRA / config 没写 steps = 默认 20）。arm20 的「30 步更深」
        // 是 2885332（10-clip 测试品、底太薄）才需要的补偿；换成数据最多的 Free Pussy 后 20 步够、省 1.45× 时间。
        // 1024 用户「重做…不要lora 1采 20步」⇒ 回 native 单采 20 步、no_lora:true（PDD 撤回）。
        // steps 仍从 LoRA config 取（1023），没挂 LoRA / config 没写 = 默认 20；native 图吃 body steps。
        steps: record.lora ? (LORA_BY_FILE[record.lora]?.config?.steps ?? 20) : 20,
        no_lora: true,
        first_frame: firstFrameFile,
        last_frame: lastFrameFile,
        // graph:"native" 走桥的 _wf_video_native；no_lora 下模型直吃 UNETLoader，不带任何 LoRA。
        // 1025：`record.graph` 曾在 1018 定案时被写死成 PROD_GRAPH，导致 body 里显式传的 graph 全被吞
        // （和 1017 那个"漏抄 graph"是同一类病，只是这次是硬覆盖）。显式传的优先；不传时按有无 LoRA 分档：
        // 无 LoRA = PDD 5 步快图（1025 用户「可以」，542 s），有 LoRA = native 20 步（saved 图吃不到 body lora）。
        graph: record.graph || (record.lora ? PROD_GRAPH : PROD_GRAPH_FAST),
        guide: guideFile,
        prev_latent: record.prevLatent || undefined,
        save_name: record.saveName || undefined,
        trim: record.trimFrames || 0,
        // 1019 用户「如果有 后续分镜要挂lora」⇒ 恢复透传。桥的 native 图在 `if lora:` 插节点 210
        // （LoraLoaderModelOnly，__init__.py:463-465），与 `no_lora`（:451 摘 4 步 turbo）互不干扰：
        // turbo=False 时 model = ["1",0] 直吃 UNETLoader、再叠 210。不传 lora = 这格不进图、逐字节老行为。
        // 1019 用户「视频生成挂key对应的lora」：`record.lora` 已经是文件名 —— 调用方（`tasks.ts`）
        // 在没显式传 lora 时按分镜的 `lora_key` 查登记表补上（key → file）。不传 = 这格不进图、逐字节老行为。
        lora: record.lora || undefined,
        // 强度：调用方显式传 > 这条 LoRA 的 config.strength（1023 登记表带配置、Free Pussy 1.0）> 1.0
        lora_strength: record.lora ? (record.loraStrength ?? LORA_BY_FILE[record.lora]?.config?.strength ?? 1.0) : undefined,
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
  // 1024x768 = 20 步无 LoRA 旧口径 2.774 s/帧（243 帧 674 s 实测；1018 深夜用户指定「1采 20步 不要lora」）。
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
