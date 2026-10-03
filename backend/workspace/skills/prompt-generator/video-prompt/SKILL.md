---
name: video-prompt
description: 视频提示词规范 — 根据分镜段落内容生成按时间分段、段内可切镜的视频生成提示词
---

# 视频提示词（分镜段落 → video_prompt）

根据单个分镜段落的 description（含【镜头N】子镜头结构与台词/旁白）/ atmosphere / duration，生成驱动 AI 视频生成的 `video_prompt`。**一个分镜段落 = 一段 8-15 秒的视频，内部允许切镜**：段与段之间可以是不同镜头，用硬切衔接；但**全程不跨场景**、不闪回。**切镜要过准入**——必须引入新信息，只是换景别或轻微角度改用运镜（见下文「切镜准入」）。

## 格式

`video_prompt` 的**第一行是信息头**：先介绍这条视频有哪些人物和场景，然后再接时间分段。人物、场景一律用 @ 引用（生成时会替换为对应参考图片标记，让视频模型先对上"谁"和"在哪"）。

```
出场人物：@小明、@小红；场景：@咖啡厅。
0-3秒：@咖啡厅，近景固定镜头，@小明低头看手机，手指反复敲桌面，表情焦虑。
3-6秒：切到门口全景，门铃响，@小红推门走入，带进一阵冷风。
6-9秒：切回中景，@小红微笑着走向小明坐下，小明说：「你终于来了。」
```

信息头规则：
- 只列该分镜段落实际出场的人物和绑定的场景，不要列没出场的
- 有明显道具出场时可在信息头追加（如 `；道具：@信件`）
- 信息头独立一行，以句号结尾，之后是时间分段

按 3 秒为一段，每段单独一行、用换行分隔，时间范围连续衔接（无重叠、无空缺）。

## 与分镜描述的映射

`description` 是 video_prompt 的唯一内容来源（画面、动作、台词、旁白都在其中），转换规则：

- `description` 的每个 `【镜头N】` 映射为 **1-2 个连续的 3 秒段**，顺序一致、不遗漏、不合并、不新增子镜头
- 台词/旁白从对应 `【镜头N】` 内的「角色名说：「…」」「旁白：…」提取，分配到该子镜头映射的段；**不要创作 description 之外的新台词**
- 画面动作以 `description` 为准；`atmosphere` 只用于补各段的光线、色调与氛围描写

## 段内结构

每一段按此顺序组织内容（可省略无内容的项，但动作/画面必须有）：

**时间范围 ＋ 场景@引用 ＋ 景别/运镜 ＋ 角色@引用＋站位·主体动作·表情 ＋ 对白/旁白 ＋ 氛围光线**

- **第一段必须建立空间**：场景 + 机位 + 每个角色的左右站位（谁在画面左、谁在右）与状态，让观众一眼知道在哪、看谁
- **站位跨段恒定**：每一段都要写角色在画面哪一侧；上一段在左、没写他移动，下一段不许出现在右
- **切镜**：切镜后的段开头用"切到/切回"等衔接词，并重新交代景别与主体；切镜点应对齐分镜 `description` 中的 `【镜头N】` 结构
- **切镜准入（硬规则，MiniMax H3 官方 §4.2）**：切镜必须**引入新信息**——新主体、新空间、新状态、新视角或新时间。
  **只是距离（景别）或轻微角度变化，不要切，改用运镜**：`中景 → 特写` 该写成 `The camera pushes in with small amplitude at slow speed...`，
  不是在两段之间切一刀。同一主体、同一空间、同一时间点上「中景→特写→中景」来回切，就是「为切而切」，模型会照做，成片只是没有信息量的跳来跳去
- **景别/运镜**：每段一个镜头状态（近景/中景/全景/特写；运镜用下面 full_ref 那节的官方词汇）；单个子镜头内运镜连续，切镜后可更换运镜方式
- **动作**：每段一个主动作，动词具体可见（走、转身、抬头、攥紧、停顿）
- **情绪全部转为可见描写**：不要"他很伤心/气氛紧张"这类抽象词，写成"他低下头、手指攥紧杯沿、呼吸变重"
- **对白/旁白**：写「角色名说：「台词」」，旁白写「旁白：内容」；3 秒念不完的长台词拆到多段；无对白的段可写环境音/动作音（如"机器持续轰鸣"）

## 引用规则

- `@场景名` — 场景引用，名字必须与场景列表中的地点完全一致
- `@角色名` — 角色引用，名字必须与角色列表中的名字完全一致
- `@道具名` — 道具引用，名字必须与道具列表中的名字完全一致；道具在画面中明显可见、被使用或特写时引用
- 生成时会自动把 `@名字` 替换为对应参考图片标记（如 `@小明` → `@图片1小明`），因此名字必须精确匹配，不要缩写或加额外符号
- **每段至少一个 @ 引用锚定画面**；角色出场的段必须 @ 该角色；只引用该分镜段落已绑定的场景/角色/道具

## 时间轴规则

- 段数 = 分镜段落 duration ÷ 3 秒（向上取整），各段时间范围相加必须等于段落总时长
- 内容节奏：第一段建立 → 中段推进动作/冲突 → 末段落到结果或情绪点

## 禁止事项

- 跨场景切换、闪回（一个段落只发生在一个场景内）
- **为换景别／轻微角度而切镜**（该用运镜）；同一主体、同一空间、同一时间点上反复切景别
- 引用列表之外的场景/角色名
- 抽象心理描写、文学化比喻（模型只认可见画面）
- 语言与会话语言指令不符

## 保存

调用 `update_storyboard` 仅更新该分镜段落的 `video_prompt` 字段，不要改动其他字段，不要重新拆分整集。


## 六段式英文全参考（video_prompt_full_ref）

`video_prompt` 是给人看的中文提示词；`video_prompt_full_ref` 是真正送 ComfyUI/MiniMax 桥的**模型侧**提示词，**必须是六段式英文**（模板恒英文，与会话语言无关；`<d>` 内台词保留原文语言）。

六段式模板（agent 填实际内容）：
```
subject_definitions:
<Subject 1> is [角色名] from <Picture 1>, on the left of frame by the [固定陈设].
<Subject 2> is [角色名] from <Picture 2>, on the right of frame by the [固定陈设].
<Subject 3> is the [场景名] scene from <Picture 3>, an interior bedroom with a window on the right.
summary:
[Shot 1] is a 12-second reference-generation video of [场景]. <Subject 1> and <Subject 2> interact; <Subject 3> is a storyboard reference for [Shot 1], defining its viewpoint, subject placement, and shot order.
retention_analysis:
<Subject 1> fully_preserved
<Subject 2> fully_preserved
<Subject 3> fully_preserved   # 场景锁定
detailed_description:
[Shot 1] a medium-wide shot frames... The camera [motion] as <Subject 1> [动作] and says: <d>[Chinese] 台词原文</d> [Shot 2] At 00:03.000, the camera cuts to...
overall_soundscape:
[环境音描述]
non_diegetic_music:
[BGM 描述]
```

**标签规则**：
- **画风词不写**：`detailed_description` 里不许出现任何媒介/画风词（`Live-action` / `实拍` / `真人` / `photoreal` / `anime` / `2D` / `3D`）。画风由调用方在提示词最前方注入的项目风格预设决定，自己写一句等于跟预设打架（实测：预设是 3D CG，模板例句的 `Live-action` 被照抄 → 出片变实拍质感）。
- **画风词不写**：`detailed_description` 里不许出现任何媒介/画风词（`Live-action` / `实拍` / `真人` / `photoreal` / `anime` / `2D` / `3D`）。画风由调用方在提示词最前方注入的项目风格预设决定，自己写一句等于跟预设打架（实测：预设是 3D CG，模板例句的 `Live-action` 被照抄 → 出片变实拍质感）。
- `<Subject N>`：角色写**两样**——它是 `<Picture N>` 里的谁（角色名），以及它在画面里的位置（如 `on the left of frame by the nightstand lamp`，左右 ＋ 相对固定陈设，两样都要）。**妆造一律不写**：脸型、五官、发型、妆容、服装、配饰全部直接取自参考图，也不要加造型形容词（`elegant` / `beautiful` / `in a silk dress` 都算造型）。你**看不到**参考图，编出来的外貌和穿着必然跟角色图打架。场景/道具同理：只写参考图确实承载的布局，不要往里加人。
- `<Picture N>`：参考图序号，与中文 `@图片N` 同一套 N（角色 1..k、场景 k+1、道具 k+2..）。
- 场景 `<Picture k+1>` 若用九宫格图，**必须**写明 "is a storyboard reference for [Shot N], defining its viewpoint, subject placement, and shot order"（九宫格场景锚定的精髓）。锚多镜时按官方写法并列：`for [Shot 1] and [Shot 2]`。

**编号规则**：六段式里 `<Subject N>` 与 `<Picture N>` 用**同一套 N**（第 N 个资产 = 角色1..k、场景、道具1..m），两者序号一一对应。只需按"角色→场景→道具"顺序编号，无需感知具体 URL。

**站位规则**（每条视频都是独立生成的一次调用，不写就每次重摆）：
- 左右一律用**画面视角**（`left / right of frame`），不要用角色自己的左右手；同时带上**相对固定陈设的锚点**（如 `at the bed edge by the nightstand lamp`）—— 左右是这一镜的事实，相对陈设是换机位也不变的事实（切正反打时左右会翻，「床头灯那一侧」不会翻），两样都写
- 站位来源：分镜 `description` 里已写的走位**为准**；`description` 没写时按角色在 `<Picture N>` 里的序号钉死——1 号在画面左、2 号在右、3 号及以后向后景与两侧展开，**整集沿用同一套**（同一场戏跨分镜不许换边）
- 每个 `[Shot N]` 都要复述站位（如 `<Subject 1> (left) …`），切镜后重新交代一次，不许换边
- 角色在镜内移动（起身、走近、离场）要写出可见过程，不许无声换位
- **承接上一镜末态**：调用消息里若给了「上一镜末态」，本条第一段必须从那个状态起手（站位、朝向、手停在哪、持物、视线一致），要换位置必须写出可见的动作过程
- **场景锚点逐字复用**：同一场景的空间锚点（固定陈设各自在哪一侧、光从哪来）在每条提示词里**原样重复**，不要换措辞——改写措辞就是漂移的起点

**retention 规则**：`retention_analysis` 每个 subject 一个状态词——`fully_preserved`（强保留，**场景一律用它**）/ `partially_preserved` / `attribute_transfer` / `weak_reference`。

**镜头词汇表**（官方 §4.3，13 类全表）：`Zoom In` / `Zoom Out`、`Push In` / `Pull Out`、`Pan Left` / `Pan Right`、`Truck Left` / `Truck Right`、`Tilt Up` / `Tilt Down`、`Pedestal Up` / `Pedestal Down`、`Arc Shot`、`Tracking Shot`、`Static Shot`、`Shake Slightly` / `Shake Strongly`、`POV`、`Roll Clockwise` / `Roll Counterclockwise`。

**运镜写法**：三维度 = 动作类型 ＋ `with small amplitude` / `with large amplitude` ＋ `at slow speed` / `at fast speed`（中幅、常速通常省略不写）。
必须写成镜头句里的**自然英文动作**，不要当标签堆在句尾。官方例句：
`The camera pushes in with small amplitude at slow speed toward the folded letter in her hands.`
`The camera holds a static shot as the runner exits the frame.`

**切镜写法（官方 §4.2，硬规则）**：
- **`[Shot 1]` 不带时间戳**；后续用 `[Shot N] At MM:SS.mmm, ...`，切点**严格递增且不得超过片长**
- 普通切镜只用这五个之一：`the camera cuts to`、`the shot cuts to`、`the shot transitions to`、`the shot changes to`、`the shot switches to`。**叠化／淡入淡出／划像只在用户明确要求时用**，默认一律硬切
- 中文 `video_prompt` 里的「切到／切回」只给人看，写进 `video_prompt_full_ref` 时必须换成上面五个之一。**「切回」没有官方对应词**，不要直译成 `cuts back to`——用**回指上一镜**的写法重新交代主体，例：
  `[Shot 2] At 00:03.000, the shot cuts to a close-up of <Subject 4> (S2), the young man in the dark-grey hoodie from Shot 1, ...`
- **只改距离或轻微角度不许切镜，用运镜**（见上面「切镜准入」）
- 台词跨切镜：切点**两侧都标** `<scenetrans>`，并明写音频连续——`continues seamlessly across the cut` / `continues uninterrupted into the next shot` / `carries over from the previous shot` / `remains audible across the transition`；台词被片尾截断用 `<cutoff>`

**镜头与对白规则**：
- `detailed_description` 按 `[Shot N]` 逐镜头写，含镜头、机位运动（上述词汇）、**每个角色的画面站位**、人物动作、说话人 ID（如 `(S1)`）、`<d>` 对白。
- 台词/旁白**不创作**，从 `description` 的【镜头N】提取，**原样**塞进 `<d>`，并加语言 tag（如 `<d>[Chinese] …</d>`）。
- 模板其余部分恒英文，无论会话语言；`<d>` 内台词保留**原文语言**。

**保存**：生成完中文 `video_prompt` 后按上面模板填好 `video_prompt_full_ref`，一次 `update_storyboard` 同时保存两字段（`storyboard_id`、`video_prompt`、`video_prompt_full_ref`）。
