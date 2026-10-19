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
3-6秒：镜头保持同一近景，@小明的拇指停在屏幕上，抬眼看向门口，呼吸放轻。
6-9秒：切到门口全景，门铃响，@小红推门走入，带进一阵冷风。
```
上例的 description 只有两个【镜头N】：前两段是同一个近景镜头（3-6秒写「镜头保持」，不切），唯一的一刀在 6 秒进【镜头2】。**切镜次数 = 【镜头N】数 − 1**。

信息头规则：
- 只列该分镜段落实际出场的人物和绑定的场景，不要列没出场的
- 有明显道具出场时可在信息头追加（如 `；道具：@信件`）
- 信息头独立一行，以句号结尾，之后是时间分段

按 3 秒为一段，每段单独一行、用换行分隔，时间范围连续衔接（无重叠、无空缺）。

**3 秒段不是镜头（硬规则，1018）**：分段只是时间切片。同一个 `【镜头N】` 跨多个 3 秒段时，所有段共用同一个景别与机位，只在动作/台词上推进；下一段开头写「镜头保持 / 镜头继续」，**不要**写「切到 / 切回」。切镜只发生在 `【镜头N】` 的边界上——整条提示词的切镜次数必须等于 description 里 `【镜头N】` 的数量 − 1。多出来的每一刀都是为切而切，模型会照做，成片就是同一主体来回跳。

## 与分镜描述的映射

`description` 是 video_prompt 的唯一内容来源（画面、动作、台词、旁白都在其中），转换规则：

- `description` 的每个 `【镜头N】` 映射为 **1-2 个连续的 3 秒段**（这 1-2 段仍是**同一个镜头**，不是 1-2 个镜头），顺序一致、不遗漏、不合并、不新增子镜头；`【镜头N】` 数就是镜头数，切镜只发生在两个 `【镜头N】` 之间
- 台词/旁白从对应 `【镜头N】` 内的「角色名说：「…」」「旁白：…」提取，分配到该子镜头映射的段；**不要创作 description 之外的新台词**
- 画面动作以 `description` 为准；`atmosphere` 只用于补各段的光线、色调与氛围描写

## 段内结构

每一段按此顺序组织内容（可省略无内容的项，但动作/画面必须有）：

**时间范围 ＋ 场景@引用 ＋ 景别/运镜 ＋ 角色@引用＋站位·主体动作·表情 ＋ 对白/旁白 ＋ 氛围光线 ＋ 末态**

**每段五要素自检**（官方专业分镜表的秒级写法，压进 3 秒段）：① 动作/姿态/表情 ② 机位/景别/运镜 ③ 空间位置（画面哪侧、相对哪件陈设、朝向）④ 声音（对白/环境音）⑤ 交给下一段的末态（手位、持物、视线、接触点）。缺哪项补哪项——特别是 ⑤，下一段要能从这里起手。

- **第一段必须建立空间**：场景 + 机位 + 每个角色的左右站位（谁在画面左、谁在右）与状态，让观众一眼知道在哪、看谁
- **站位跨段恒定**：每一段都要写角色在画面哪一侧；上一段在左、没写他移动，下一段不许出现在右
- **切镜**：只在 `【镜头N】` 边界处用"切到/切回"等衔接词，并重新交代景别与主体；同一个 `【镜头N】` 内部的段首用"镜头保持/继续"，不切
- **切镜准入（硬规则，MiniMax H3 官方 §4.2）**：切镜必须**引入新信息**——新主体、新空间、新状态、新视角或新时间。
  **只是距离（景别）或轻微角度变化，不要切，改用运镜**：`中景 → 特写` 该写成 `The camera pushes in with small amplitude at slow speed...`，
  不是在两段之间切一刀。同一主体、同一空间、同一时间点上「中景→特写→中景」来回切，就是「为切而切」，模型会照做，成片只是没有信息量的跳来跳去
- **景别/运镜**：每个 `【镜头N】` 一个镜头状态（近景/中景/全景/特写；运镜用下面 full_ref 那节的官方词汇）；同一子镜头的连续段内运镜连续，切镜后才更换运镜方式。**工作景别**：对话/亲密场的主景别是近景或中近景，宽景别与特写是**标记事件**——用完必须回到工作景别，不许整条漂在两个极端
- **一切一个运镜，不叠加（社区导演手感表 + 官方 §4.3）**：每个镜头只选一个运镜动作（推 / 拉 / 摇 / 跟 / 移 / 环绕 / 固定），不许一句里又推又摇；写 `Static Shot` 要给出理由（这一镜不需要信息变化，或人物自己在动）。一条视频里运镜种类超过两种 = 炫技，观众找不到该看哪
- **动作**：每段一个主动作，动词具体可见（走、转身、抬头、攥紧、停顿）。**物体位移必须点名施动者（1018 实测）**：写「薄被从床榻外侧滑落」这种没有手的句子，模型就画成被子自己掀开、凭空滑下去；要写成「谁的右手把薄被从自己腰上往下拉，布料滑过她大腿外侧、堆到床垫上」。纯光线、烛火、影子、烟雾的变化**不算主动作**——连续几段只有光线变化时模型没有动作可跟，会自己加小动作，人物显得随意。**动作要可行、量化**：这个动作几秒能做完就写几秒，肢体细化到部位＋程度（「右手抬起三寸」「向前两步」），低缓连续的动作优先（一次大跳模型算不出中间帧），本段第一个动作从上一段末态起手。**微表情不写**：眼睑颤动、睫毛、指腹轻摩这类 3 秒内做不到的细节，写了模型会画成抽搐
- **情绪全部转为可见描写**：不要"他很伤心/气氛紧张"这类抽象词，写成"他低下头、手指攥紧杯沿、呼吸变重"（悲伤＝低头肩膀微颤、愤怒＝双拳紧握下颌绷紧、羞耻＝视线躲开脸红到耳根、享受＝仰头闷哼手指收紧）。**每个 3 秒段都要有脸上可见的大表情描写**（咬唇、抿唇松开、眉头收紧、眼神失焦、仰头闷哼、呼吸变重、脸红到耳根），与身体动作同步——1018 用户「人物也需要有表情描述」：只有身体动作、脸上没表情的成片，人物看着空洞随意（微表情除外，见上面「动作」条）。**视线落点与移动逐段必写**：这一段里他看谁/看哪件物件、从哪移到哪（「视线从她脸上滑到她的手、又抬回去」）——1019 实测 full_ref 里 14/16 段一个眼神词都没有 ⇒ 成片人物不看对方。
- **互动镜头写双方（1018 用户「如果是互动 要描写互动双方的反应」）**：施动者的动作 + 受动者的可见接收反应同段或下一段必须都有——被碰到的人的眼神、呼吸变重、身体绷紧或往后躲、手指收紧；只写施动者 = 对方像木头
- **穿着状态逐段必写（1019 用户「缺少穿着」）**：款式/长相仍然不写（由角色图定），但**脱到哪一步、哪里还穿着或盖着**是画面事实，每一段都要写（「衣襟拉开到胸口以下、上身裸露、薄被堆在床垫上、两人腰以下露出」）；从上一段状态承接，不许无声穿回去、也不许凭空全裸。不写状态，模型会按角色三视图的惯性把整套衣服穿回来。
- **构图量化六字段（不写就消失，社区实测）**：焦距＋景深（`shallow depth of field` / 背景虚化程度）、机位（高度＋水平角度）、构图（对称/三分/框中框、人物占画面哪一侧）、视线落点、焦点在哪件对象、稳定性（`locked-off` / `handheld slight shake`）。成片「景别偏远、动作偏小、人物摆位随意」的代价就是这三类没写进正文
- **参考图只锁身份不锁构图**：`@图片` / `<Picture>` 负责长相、服装、房间陈设；画面里怎么摆、人物相对镜头在哪侧、手停在哪、物件在谁身上，全部写进正文。图与文冲突时模型听图——**位置状态写成事实**（已坐在床沿、薄被仍盖到腰上、信件已在她手里），不写 = 模型按参考图姿势惯性补
- **首帧只写可冻结瞬间**：第一段（= 首帧锚）写这一镜**开始前**的状态，不带本镜运动才产生的结果（推镜不写「已贴近」、起身不写「已站着」）
- **对白/旁白**：写「角色名说：「台词」」，旁白写「旁白：内容」；3 秒念不完的长台词拆到多段；无对白的段可写环境音/动作音（如"机器持续轰鸣"）
- **声音要可听（硬规则，1018「声音没了」实测）**：无对白 ≠ 无声。每个无对白段都要写**具体、可听见**的动作音/环境音（呼吸、布料摩擦、床架轻响、脚步、水声），不要用「极静 / 无声 / 无人说话 / faint / barely audible」把整段压成静音——实测写「faint creak + faint insects」时成片音频只有 -55 dB，等于没声音。声音只写 description / atmosphere 已有的声源，不新增台词。full_ref 的 `overall_soundscape` 同样写**至少两个可听见的具体声源**，不许写 `faint` / `barely audible` / `quiet` 收尾。**声音三层**：① 台词/旁白进正文 ② 画内可听声（动作音、环境音、人声呻吟/呼吸）进各段与 `overall_soundscape` ③ 配乐只进 `non_diegetic_music`，不许混进正文。声景也是动作指令：写了「床架随翻身轻响」模型就会翻身

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
[reference generation] [Shot 1] is a [片长]-second reference-generation video of [场景]. <Subject 1> and <Subject 2> interact; <Subject 3> is a storyboard reference for [Shot 1], defining its viewpoint, subject placement, and shot order.
retention_analysis:
<Subject 1> (appears in [Shot 1], [Shot 2]): fully_preserved - identity and costume exactly as supplied by <Picture 1>; on the left of frame by the [固定陈设].
<Subject 2> (appears in [Shot 1], [Shot 2]): fully_preserved - identity and costume exactly as supplied by <Picture 2>; on the right of frame by the [固定陈设].
<Subject 3> (appears in all shots): fully_preserved - room layout, fixed furnishing positions and light direction exactly as supplied by <Picture 3>.
detailed_description:
[Shot 1] a medium-wide shot frames... The camera [motion] as <Subject 1> [动作] —— 段首 1 秒只写画面/动作，不写 `<d>`（衔接窗口，必须无对白）。At 00:01.500, <Subject 1> (S1) says: <d>[Chinese] 台词原文</d> The same shot continues with [同一镜头内的后续动作]。[Shot 2] At 00:04.000, the shot cuts to [下一子镜]...（**description 有几个【镜头N】，这里就只能有几个 [Shot N]、N−1 个 cut 短语；同一镜头跨多个时间点写在同一段 [Shot N] 里，不新增 [Shot N]**）
overall_soundscape:
[环境音描述]
non_diegetic_music:
[BGM 描述]
```

**标签规则**：
- **画风词不写**：`detailed_description` 里不许出现任何媒介/画风词（`Live-action` / `实拍` / `真人` / `photoreal` / `anime` / `2D` / `3D`）。画风由调用方在提示词最前方注入的项目风格预设决定，自己写一句等于跟预设打架（实测：预设是 3D CG，模板例句的 `Live-action` 被照抄 → 出片变实拍质感）。
- `<Subject N>`：角色写**两样**——它是 `<Picture N>` 里的谁（角色名），以及它在画面里的位置（如 `on the left of frame by the nightstand lamp`，左右 ＋ 相对固定陈设，两样都要）。**妆造一律不写**：脸型、五官、发型、妆容、服装、配饰全部直接取自参考图，也不要加造型形容词（`elegant` / `beautiful` / `in a silk dress` 都算造型）。你**看不到**参考图，编出来的外貌和穿着必然跟角色图打架。**但穿着状态必须写**（脱到哪一步、哪里还穿着/盖着、裸露范围），见下面「`detailed_description` 必带三件事」。场景/道具同理：只写参考图确实承载的布局，不要往里加人。
- **`detailed_description` 每个 [Shot N] 必带三件事（1019 实测：full_ref 里表情/眼神词 14/16 段为零 ⇒ 成片人物不看对方、脸上没表情）**：① **表情过程**，英文大表情词表：`bites her lower lip` / `lips press then part` / `brow furrows then releases` / `eyes half-close` / `breath deepens` / `blush spreads to her ears` / `jaw tightens` / `head tilts back with a muffled moan`；② **视线落点与移动**：`her gaze drops to his hand, then flicks away` / `looks at her face, eyes drift to the window`；③ **穿着状态**：`the front of her blouse opened below the collar, chest bare` / `the quilt pooled at the foot of the bed, both hips exposed`。中文 `video_prompt` 里写到的表情、视线、衣着状态**必须原样带进英文 full_ref**，不许压缩掉——真正送模型的是 full_ref（`frontend/app/views/drama/episode.vue:3980` 与驱动都把它当 `body.prompt` 发给 comfyui provider，中文那条只是给人看的）。微表情（眼睑颤动、睫毛）仍然不写。
- **LoRA 触发词按 key 取、不许自己编（1019 用户定案「分镜根据key获取触发词 视频生成挂key对应的lora」）**：调用消息给了本镜 `lora_key` 和它的词 ⇒ 把那个词**原样**写进该 `[Shot N]` 的 `detailed_description`（与取景句同段，生成时平台按 key 挂对应 LoRA，**词与权重是一套**：只挂不写、或只写不挂都不算生效）；消息没给 key ⇒ 这一镜不露生殖器，外阴按合拢窄缝写、禁 `spread` / `parted` / `opening` / `gaping`（实测不带 LoRA 的 spread 画成一坨深色）。
- `<Picture N>`：参考图序号，与中文 `@图片N` 同一套 N（角色 1..k、场景 k+1、道具 k+2..）。
- 场景 `<Picture k+1>` 若用九宫格图，**必须**写明 "is a storyboard reference for [Shot N], defining its viewpoint, subject placement, and shot order"（九宫格场景锚定的精髓）。锚多镜时按官方写法并列：`for [Shot 1] and [Shot 2]`。

**编号规则**：六段式里 `<Subject N>` 与 `<Picture N>` 用**同一套 N**（第 N 个资产 = 角色1..k、场景、道具1..m），两者序号一一对应。只需按"角色→场景→道具"顺序编号，无需感知具体 URL。

**站位规则**（每条视频都是独立生成的一次调用，不写就每次重摆）：
- 左右一律用**画面视角**（`left / right of frame`），不要用角色自己的左右手；同时带上**相对固定陈设的锚点**（如 `at the bed edge by the nightstand lamp`）—— 左右是这一镜的事实，相对陈设是换机位也不变的事实（切正反打时左右会翻，「床头灯那一侧」不会翻），两样都写
- 站位来源：分镜 `description` 里已写的走位**为准**；`description` 没写时按角色在 `<Picture N>` 里的序号钉死——1 号在画面左、2 号在右、3 号及以后向后景与两侧展开，**整集沿用同一套**（同一场戏跨分镜不许换边）
- 每个 `[Shot N]` 都要复述站位（如 `<Subject 1> (left) …`），切镜后重新交代一次，不许换边
- **两只手都要交代**：每个出镜角色写清两只手各自的位置（或明确「另一只在画面外/被遮挡」）。不写的那只会被参考图的姿势补上——角色三视图里双手固定交叠在腰前——画面里就多出手
- 角色在镜内移动（起身、走近、离场）要写出可见过程，不许无声换位
- **承接上一镜末态**：调用消息里若给了「上一镜末态」，本条第一段必须从那个状态起手（站位、朝向、手停在哪、持物、视线一致），要换位置必须写出可见的动作过程
- **场景锚点逐字复用**：同一场景的空间锚点（固定陈设各自在哪一侧、光从哪来）在每条提示词里**原样重复**，不要换措辞——改写措辞就是漂移的起点

**肢体接触（硬规则，1018 穿模实测后定）**：
- **分镜 description 里的缠绕措辞不得照抄**：description 写「双腿缠上腰间」「绕住」「锁住」时，`video_prompt` 与 `video_prompt_full_ref` 必须改写成接触点句子；**输出里出现 `wrap around` / `wrapped around` / `缠在腰间` / `sinking into` / `陷入` 即视为不合格**（照抄就是穿模的源头）。改写示例：description「双腿缓缓缠上 A 的腰」→ `Her right hand lifts and rests on the outer side of <Subject 1>'s shoulder; both her legs stay extended on her own side of the mattress, her right calf resting on the sheet.`
- 只写**接触点**：谁的哪个部位、贴住对方的哪个部位、接触的是外侧/衣物表面（`her right palm rests on the outer side of <Subject 1>'s shoulder`）。不要把接触写成“进入/陷进/穿过”对方身体。
- **并躺/侧躺时腿部零接触（1018 两次穿模实测后升级）**：两人都在床上、身体大致平行时，禁止写任何「小腿/膝盖/大腿贴住对方髋、腰、腿」。一条腿要碰到对侧髋必须跨过对方身体中线，模型算不出这条腿的髋关节，实测会渲染成腿穿进另一条大腿、膝盖悬空融合。腿部各自留在自己一侧、脚或小腿贴床；亲密接触只用**手/手臂/肩/脸**。只有站立/跨坐等确实需要双腿承重时才写腿部接触，且两条腿各有落点、不得互相交叉。
- **躺姿禁止双腿同时离床**：一个 3 秒段最多抬一条腿，且必须写落点（`her right knee rises a little, her right foot stays on the mattress`）；禁止 `both legs rise off the sheet` / `both knees push upward`（没有落点的悬空腿 = 穿模）。
- **「腿缠腰/腿贴髋」是必须删除的动作，不是改写对象（1018 第三次穿模后定）**：description 里的腿部缠绕/贴髋在并躺场景中不可渲染；`video_prompt` 与 `video_prompt_full_ref` 里**不得出现任何腿与对方身体接触的句子**，也不得出现 `hip` / `waist` / `calf` / `thigh` / `legs` / `both legs` / 「髋」/「腰」/「小腿」/「大腿」/「双腿」。腿只允许两种落点句：`her foot stays on the mattress` / `her calf rests on the sheet`。亲密接触一律改用**手、手臂、肩、脸**（`her right palm rests on the outer side of <Subject 1>'s shoulder`）。
- **并躺亲密镜头默认腰部以上景别**：写 `medium close-up from the waist up` 或 `close-up`，**不写 medium shot / full shot**，画面里不出现两人的腿（腿不入画 = 没有腿可穿模）。
- **保存前强制自检**：调用 `update_storyboard` 前逐字检查两条提示词，出现 `hip` / `calf` / `thigh` / `legs` / `both legs` / 「髋」/「小腿」/「大腿」/「双腿」/ `sink` / 「陷入」即改写；除上面两种落点句外，任何腿部描写都删掉。
- **保存前数镜头（硬自检）**：数 description 里的 `【镜头N】` 个数 = N；两条提示词必须各有 **N 个镜头**、**N−1 个切镜**。`video_prompt` 里「切到/切回/切至」出现次数 = N−1，其余段首写「镜头保持/继续」；`video_prompt_full_ref` 的 `detailed_description` 里 `[Shot N]` 个数 = N，cut 短语个数 = N−1。多了就是自己新增的子镜头，删掉并合并回同一镜头——同一场景同一主体每 3 秒切一刀，成片就是无意义的跳来跳去。
- **重新生成时不得照抄旧提示词**：`read_storyboard_context` 返回的 `existing_storyboards[*].video_prompt` 是上一版（可能含已判死的穿模写法），只能用来核对站位/台词，**不得整段复制、也不得在它上面做局部微调**；每次重新生成都必须从 `description` + 本技能重新写。
- **禁止缠绕类连续重叠措辞**：`wraps her legs around` / `entwines` / `locked around the waist` / `缠在腰间` 会让模型把肢体塞进躯干。一律改成点到点的“贴住/压住/搭在/握住”，并写清**另一条肢体在哪**（`her left leg stays extended on the sheet`）。
- 每个接触镜头写**承重点**：重量落在床面/椅面/地面，不是落在对方身体里。
- 一个 3 秒段只写**一个因果动作**（抬起→贴近→贴住），接触状态的变化要有可见过程，不许一段里又抱又翻身又换位。
- 接触状态逐段复述；下一段从上一段结束的接触点起手，不许换肢体、换接触面。**全文只能有一种接触写法**：第 2 段定成「右手掌贴住左肩外侧」，第 3/4 段只能复述右手（`her right palm still rests against …`），不得再出现 `legs`/`both`/「双腿」；并躺场景里腿部从第一段到最后一段都留在各自一侧。
- 负向词不写（采样没有负面分支）；用正向状态替代（写“右手贴在外侧肩部”，不写“腿不要穿过身体”）。

**姿态与关节（硬规则）**：
- **每段复述躯干姿态与头朝向**：不只写左右站位，还要写这一段里每个人是卧（俯卧 / 仰卧 / 侧卧）、坐、站、跪、半撑还是倚靠、承重点在哪、脸朝哪一侧。切镜后重新交代一次；与上一段不一致时必须写出可见的翻身、撑起或转身过程。
- **不得发明 description 没有的姿态**：description 没写躯干姿态时，沿用上一镜末态，或按 description 的动作反推最省关节的姿势；不要自行添加会改变躯干朝向的描写。模型会把没写清的姿态按参考图和惯性补出来，补出来的往往与动作冲突。
- **头相对躯干转 0–90°**：脸朝自己的后背方向是物理上做不到的；人要看身后或脚侧的对象时，本段先写翻身、转身或改成侧卧。
- **近距离的头部动作（耳边呼吸 / 低语 / 贴面 / 亲吻等）**：靠近的一方从对方头侧接近，或两人面对面侧卧 / 一坐一卧且上身朝向对方；把两人躯干朝向和头朝向一起写。只写「唇贴近耳廓」而不写两人怎么躺，模型会让脸和背同时朝向镜头。
- **大角度转头段用固定机位**：头相对躯干转 ≥45° 的 3 秒段写 `Static Shot` / `the camera holds a static shot`，不叠加环绕 / 推拉。
- **一个 3 秒段一个精准接触**：接触点之外的肢体写清在哪（`her left hand stays braced on the mattress`），不要同时安排翻身、转头、抬手。
- 正向陈述，负向词不写（与上面同一原则）。

**summary / retention 规则（官方六段式硬格式）**：
- `summary` 第一个词必须是任务类型标签：`[reference generation]`；本条带首帧锚（链式续接、keyframe completion）时写 `[reference generation + keyframe completion]`。没有标签的 summary 视为格式不合格。
- `retention_analysis` 每个 subject 一行，格式 = `<Subject N> (appears in [Shot N], ...): <状态词> - <保留项>`。出现过的 shot 要列全，没出现的不列，场景写 `appears in all shots`。
- 保留项**只写参考图负责的结构性事实**：角色写身份/妆造“as supplied by <Picture N>”、画面侧与固定陈设；场景写布局、陈设在哪一侧、光从哪来；道具写形状与标记。**不编具体五官、发型、服装**（与本技能「妆造一律不写」同一理由）。角色的 `costume` 只指**款式**由图定，**穿着状态另写**：`identity and costume style as supplied by <Picture 1>; clothing state: blouse opened below the collar, chest bare`（照抄「costume exactly as supplied」而不写状态，模型会把整套衣服穿回来）。
- 状态词：`fully_preserved`（强保留，**场景一律用它**）/ `partially_preserved` / `attribute_transfer` / `weak_reference`。
- `non_diegetic_music` 段必须保留：有配乐就写，没有就写 `N/A (no non-diegetic music)`——不许删掉这个段名或留空。

**镜头词汇表**（官方 §4.3，13 类全表）：`Zoom In` / `Zoom Out`、`Push In` / `Pull Out`、`Pan Left` / `Pan Right`、`Truck Left` / `Truck Right`、`Tilt Up` / `Tilt Down`、`Pedestal Up` / `Pedestal Down`、`Arc Shot`、`Tracking Shot`、`Static Shot`、`Shake Slightly` / `Shake Strongly`、`POV`、`Roll Clockwise` / `Roll Counterclockwise`。

**运镜写法**：三维度 = 动作类型 ＋ `with small amplitude` / `with large amplitude` ＋ `at slow speed` / `at fast speed`（中幅、常速通常省略不写）。
必须写成镜头句里的**自然英文动作**，不要当标签堆在句尾。官方例句：
`The camera pushes in with small amplitude at slow speed toward the folded letter in her hands.`
`The camera holds a static shot as the runner exits the frame.`

**切镜写法（官方 §4.2，硬规则）**：
- **`[Shot 1]` 不带时间戳**；后续用 `[Shot N] At MM:SS.mmm, ...`，切点**严格递增且不得超过片长**
- **锚点要按片长等分，不许照抄例句的排布**：12s → `At 00:01.500 / 00:04.000 / 00:07.000 / 00:10.000`；15s → `At 00:01.500 / 00:05.000 / 00:09.000 / 00:13.000`。最后一个锚必须 ≤ 片长 − 1.5s，并且要写清**最后 1.5 秒的画面**——尾巴不许空转、不许重复上一拍（1006 实测：15s 的镜头锚点只写到 00:07–00:11 时，后半段就在原地磨，看着像没发生事）
- 普通切镜只用这五个之一：`the camera cuts to`、`the shot cuts to`、`the shot transitions to`、`the shot changes to`、`the shot switches to`。**叠化／淡入淡出／划像只在用户明确要求时用**，默认一律硬切
- 中文 `video_prompt` 里的「切到／切回」只给人看，写进 `video_prompt_full_ref` 时必须换成上面五个之一。**「切回」没有官方对应词**，不要直译成 `cuts back to`——用**回指上一镜**的写法重新交代主体，例：
  `[Shot 2] At 00:03.000, the shot cuts to a close-up of <Subject 4> (S2), the young man in the dark-grey hoodie from Shot 1, ...`
- **只改距离或轻微角度不许切镜，用运镜**（见上面「切镜准入」）
- 台词跨切镜：切点**两侧都标** `<scenetrans>`，并明写音频连续——`continues seamlessly across the cut` / `continues uninterrupted into the next shot` / `carries over from the previous shot` / `remains audible across the transition`；台词被片尾截断用 `<cutoff>`

**镜头与对白规则**：
- `detailed_description` 按 `[Shot N]` 逐镜头写，含镜头、机位运动（上述词汇）、**每个角色的画面站位**、人物动作、说话人 ID（如 `(S1)`）、`<d>` 对白。
- **说话人规则（官方 §4.4）**：只有真发声的角色才给 `(Sx)`，从不发声的角色**不给** speaker ID；多个已编号说话人**同时**说/唱用复合 ID `(S1,S2)`；同一说话人跨镜头保持同一 ID。写不清谁在说，模型就自己补，表现成两个人同时开口。
- **说话人首次出现**要给出声音身份（人物类型、年龄、性别、是否画外、音高、音色、语速、口音）与这一句的语气/节奏（`low and steady` / `hurried`），例：`<Subject 1> (S1), a young woman in her mid-20s, speaking in a warm mid-range voice at an unhurried pace, says:`；身份短语、ID、动作和 delivery 写在 `<d>` **外**，`<d>` 内只放语言 tag 和原文台词。
- **段首 1 秒内不得有任何 `<d>` 对白**（台词/旁白/内心独白全算），最早台词时间戳 ≥ 1s，这 1 秒只允许画面/氛围/动作。衔接窗口（22 帧 ≈ 0.92 s）正是这一段 —— 窗口里说话会和上一段的音频撞。
- **台词时长**：按自然语速估（中文 ≈4–5 字/秒、英文 ≈2–3 词/秒，含停顿），台词必须装得进该镜头时长；装不下就延 `[Shot N]` 时间戳，或跨相邻镜头拆并用 `<scenetrans>` 标连续。**绝不把长台词塞进太短的镜头**（破坏口型和节奏）。
- `<Audio N>` 槽按**本段说话顺序**编号：第一个说话者 = item 1（= `<Audio 1>` = `ref_audio_0`），第二个 = item 2；**绝不按槽位名 A/B/C 排**。只在段内真有人说话时才写 `<Audio N>`。
- 台词/旁白**不创作**，从 `description` 的【镜头N】提取，**原样**塞进 `<d>`，并加语言 tag（如 `<d>[Chinese] …</d>`）。
- 模板其余部分恒英文，无论会话语言；`<d>` 内台词保留**原文语言**。

**保存**：生成完中文 `video_prompt` 后按上面模板填好 `video_prompt_full_ref`，一次 `update_storyboard` 同时保存两字段（`storyboard_id`、`video_prompt`、`video_prompt_full_ref`）。
