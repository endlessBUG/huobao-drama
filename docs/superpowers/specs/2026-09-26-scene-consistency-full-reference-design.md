# 场景一致性：MiniMax H3 Full-Reference 提示词改造（P0/P1/P3）

日期：2026-09-26
状态：Draft（待用户审）

## 一、背景与目标

火宝短剧用本机 ComfyUI + MiniMax H3 `ref2v` 生成视频。当前分镜视频提示词是**中文叙事**（`@角色名/@场景名` 3 秒分段），模型实际看到的是"中文 + 若干无法对应的人脸参考图"，结果：**角色脸对、但场景漂移、机位乱、人物位置不固定**。

调研（B站 + MiniMax 官方文档 + JZL 节点代码）确认根因：

1. **JZL 节点的 `JZL_MiniMaxH3ReferenceToVideo2`** 自带 docstring：`<Picture i>`/`<Video k>`/`<Audio j>` 是参考条件编码标签，**提示词要用相同标签引用**。我们没有写任何 `<Picture N>`，参考图对模型退化为"氛围参考"（官方术语 `weak_reference`）→ 场景一致性最差。
2. **官方 Full-Reference 改写格式** 要求：**六段式英文**（`subject_definitions / summary / retention_analysis / detailed_description / overall_soundscape / non_diegetic_music`），用 `<Subject N>`/`<Picture N>` 标签。语言硬性要求英文。
3. **B站九宫格+俯视图+skill提示词约束** 的精髓 = 官方格式里 `<Picture N>` 作**构图/站位参考**（storyboard reference）——我们没做。

## 二、方案总览

| 项 | 内容 | 优先级 |
|---|---|---|
| **P0** | 视频提示词新增**六段式英文 Full-Reference**（`<Subject N>`/`<Picture N>` + retention）——核心修复，直接对症 | 必须 |
| **P1** | 桥 `ref_scale` 1.0 → 2.0（默认，可覆盖）——参考图"权重"更高 | 必须 |
| **P3** | 首帧锚定 fl2va（`first_frame` = 场景宽镜头图），**可选开关** | 必须（但走单 KSampler 链） |
| **A** | 场景技能新增**九宫格（3x3 多角度）场景图**，作 ref2v 的 `<Picture N>` 构图锚点 | 必须 |

四个改动是配套的：P0 的 `<Picture N>` 需要 A 提供九宫格场景图；P1 放大参考图权重；P3 给"单镜头强锁定"场景多一档选择。

## 三、参考图序号映射（P0 的基石）

参考图传给模型的顺序（前端 `getShotReferenceImages` / `getShotReferenceIndexMap`，**角色 → 场景 → 道具**，最多 9 张）：

| 序号 `<Picture N>` | 内容 |
|---|---|
| 1..k | 角色（按分镜绑定顺序） |
| k+1 | 场景（用九宫格图；没有则宽镜头图） |
| k+2.. | 道具 |

**规定**：六段式里 `<Subject N>` 与 `<Picture N>` 都用**同一套 N**（第 N 个资产 = 角色1..k、场景、道具1..m），两者序号一一对应。这样 agent 只需按"角色→场景→道具"顺序编号，无需感知具体 URL。中文 `video_prompt` 现有的 `@图片N` 映射（同一套 N）保持不变、不受影响。

## 四、P0 — 六段式英文 video_prompt_full_ref

### 4.1 存储（双轨）
- `storyboards` 表新增一列：`video_prompt_full_ref TEXT`（英文六段式）。
- 现有 `video_prompt`（中文、`@`引用）**保留不动**：人工可读、可编辑、非 ComfyUI 厂商照用。

> 双轨原则：`video_prompt` = 中文描述；`video_prompt_full_ref` = 真正送 ComfyUI 桥的提示词。ComfyUI 生成时优先取 `video_prompt_full_ref`，取不到才回退 `video_prompt`。

### 4.2 Agent 产出
`prompt_generator` agent 生成视频提示词时，**一次 `read_storyboard_context`** 后同时产出两份，一次 `update_storyboard` 保存两字段：
1. `video_prompt`：现有中文 3 秒分段格式（不变）。
2. `video_prompt_full_ref`：六段式英文（新格式）。

**六段式模板**（agent 填实际内容）：
```
subject_definitions:
<Subject 1> is the [外貌描述] woman from <Picture 1>.
<Subject 2> is the [外貌描述] man from <Picture 2>.
<Subject 3> is the [场景名] scene from <Picture 3>, an interior bedroom with a window on the right.
summary:
[Shot 1] is a 12-second reference-generation video of [场景]. <Subject 1> and <Subject 2> interact; <Subject 3> is a storyboard reference for [Shot 1], defining its viewpoint, subject placement, and shot order.
retention_analysis:
<Subject 1> fully_preserved
<Subject 2> fully_preserved
<Subject 3> fully_preserved   # 场景锁定
detailed_description:
[Shot 1] Live-action, cinematic, a medium-wide shot frames... The camera [motion] as <Subject 1> [动作] and says: <d>[语言tag] 台词原文</d> [Shot 2] At 00:03.000, the camera cuts to...
overall_soundscape:
[环境音描述]
non_diegetic_music:
[BGM 描述]
```
- **全文英文**，仅 `<d>` 内台词保留**原文**（带语言 tag，如 `<d>[Chinese] …</d>`）。
- `<Subject N>`：角色/场景/道具的**可见内容**描述（人脸、穿着、场景布局）。
- `<Picture N>`：参考图序号（同 §三映射）。**场景 `<Picture k+1>` 若用九宫格图，必须写明 "is a storyboard reference for [Shot N], defining its viewpoint, subject placement, and shot order"**（这是九宫格精髓）。
- `retention_analysis`：每个 subject 一个状态词——`fully_preserved`（强保留，场景用）/ `partially_preserved` / `attribute_transfer` / `weak_reference`。**场景一律 `fully_preserved`**。
- `detailed_description` 按 `[Shot N]` 逐镜头，含镜头、机位运动（官方镜头词汇表：Zoom In/Out, Push/Pull, Pan, Truck, Tilt, Arc, Tracking, Static, Shake…）、人物动作、`(S1)`/`(S2)` 说话人 ID、`<d>` 对白。
- 台词/旁白**不创作**，从 `description` 的【镜头N】提取，原样塞 `<d>`。

### 4.3 文件改法
- **新增** `workspace/skills/prompt-generator/video-prompt/` 下"六段式英文提示词"整节（含上述模板 + 标签规则 + 序号规则 + 镜头词汇表 + 对话规则）。中文 SKILL.md 里新增一节；`.en.md`/`.ja.md`/`.ko.md` 同步加（六段式模板本身是英文、通用）。
- **改** `workspace/prompts/prompt_generator.md` 视频提示词工作流：步骤 2 改为"同时生成 `video_prompt`（中文）与 `video_prompt_full_ref`（六段式英文）"；步骤 4 `update_storyboard` 只传 `storyboard_id`、`video_prompt`、`video_prompt_full_ref` 三键。`.en/.ja/.ko` 同步。
- **新列** `video_prompt_full_ref` 到 `schema.ts`（`storyboards`）+ `sqlite-schema.ts`（DDL：`video_prompt TEXT, video_prompt_full_ref TEXT`）。
- **`language.ts`**：`buildLanguageDirective` 例外项加一句：`The English full-reference field video_prompt_full_ref must ALWAYS be written in English regardless of session language. It is model-facing, not user-facing.`（zh 模式下 directive 不加，靠 SKILL.md 自身规定；非 zh 模式靠这句例外压制语言指令）。
- **`storyboard-tools.ts`**：`update_storyboard` 的 `inputSchema` 加 `video_prompt_full_ref: z.string().optional()`；`execute` 映射到 `updates.videoPromptFullRef = fields.video_prompt_full_ref`。

### 4.4 前端
- 视频检查器（`episode.vue` 669–686 行）在中文 `video_prompt` 文本框**下方**新增第二面板（仿角色页"最终提示词"面板）：**读-only**，标题"ComfyUI 英文提示词 (full-reference)"，`<pre>` 渲染 `video_prompt_full_ref`，右侧加**复制**按钮。不加文本框（防用户手改坏格式）。
- `genVideoPrompt` 生成的 agent 请求消息里追加一句："并生成 video_prompt_full_ref（六段式英文）"（或写死在 SKILL.md，让 agent 自动做——推荐后者，消息不动，靠技能驱动）。
- `genVid(sb)`：`prompt = isComfyUI ? (sb.videoPromptFullRef || sb.videoPrompt) : resolveVideoPromptRefs(sb)`。需判断当前视频 provider 是否为 comfyui（`videoModel.value` / `selectedVideoConfig.value` 里查）。

### 4.5 验证
- 生成后读回 `storyboards.video_prompt_full_ref`，正则校验六段 header 齐全、含 `<Subject`、`<Picture`、`retention_analysis`、`fully_preserved`。
- 人工：用现有分镜重跑一次，看 ComfyUI 出的视频场景是否稳定。

## 五、P1 — ref_scale 2.0

- **桥**（`ComfyUI-OpenAI-Bridge/__init__.py`，**仓库外、改完要重启 ComfyUI**）：`_wf_video(..., ref_scale=2.0)` 默认 2.0；`videos()` 路由读 `b.get("ref_scale")`，有则用（允许覆盖），传进 `_wf_video`，写进 `node 302["inputs"]["ref_scale"]`。
- **后端适配层** `backend/src/services/adapters/comfyui-video.ts`：`buildGenerateRequest` 的 body 加 `ref_scale: 2.0`（或读 `config.comfyuiRefScale` 覆盖）。
- 语义：`ref_scale` 控制参考图在 conditioning 画布上的占位面积（越大参考图权重越高、场景越被"钉住"）。默认 2.0。
- **注意**：改桥必须 `restart ComfyUI`，桥内存作业会丢（mp4 产物保留）。

## 六、P3 — 首帧锚定 fl2va（可选开关）

**现状**：`JZL_MiniMaxH3ReferenceToVideo2` 无 first-frame 输入。JZL 另有 `JZL_MiniMaxH3ImageToVideo`（单段）/ `MiniMaxH3Unified(mode=first_last_frame)`（封装它），接受 `first_frame`。

**方案**：桥新增 `mode` 分支。`_wf_video` 保持 ref2v；新增 `_wf_fl2va(first_frame, ...)`：
- 条件节点换成**首帧生视频节点**（`JZL_MiniMaxH3ImageToVideo`，first_frame = 场景宽镜头图），其余 KSampler 链（`BasicGuider / RandomNoise / KSamplerSelect / BasicScheduler(res_multistep,4steps) / SamplerCustomAdvanced`）与现有 ref2v 链**一致**。
- `first_frame` 图由 `genVid` 传进：分镜绑定场景且场景**宽镜头图**（`scenes.imageUrl`）存在时，作为 `first_frame_url` 传入视频任务；**staging 是后端适配层的事**（现有 `stageReferenceImages` 下载 `referenceImageUrls` 到 input/）——新增一条：把宽镜头图也 stage 成一个文件，body 加 `first_frame: <fname>`。桥不下载 URL，只收文件名。
- **开关**：视频生成参数区（`episode.vue` 生成视频处）加一个 checkbox"首帧锚定 (fl2va)"（仅当 provider=comfyui 时显示）。开启且场景有宽镜头图（`scenes.imageUrl`）→ fl2va；否则回退 ref2v。默认关闭。
- 六段式复用同一份 full_ref（`summary` 里加/改 task type 为 `keyframe completion`，场景 `<Picture k+1>` 行可写 "is the actual first frame of [Shot 1]"）。**注意**：fl2va 节点没有 ref_image 插槽，`<Picture N>` 在 fl2va 模式下是纯文本（不映射任何参考图），无害。agent 生成时不需要感知 P3 开关，同一条 full_ref 两档通用；要精确 fl2v 版本再手动重生成。

**风险**：fl2va 官方偏好**单镜头**（"FL2VA generally favors a single shot so the model can interpolate continuously"）。多镜头切镜的分镜下效果可能弱于 ref2v。故做成**可选开关**，用户按场景挑。验证：拿一个单镜头分镜开/关对比。

## 七、A — 九宫格场景图（场景技能）

### 7.1 存储
- `scenes` 表新增两列：`grid_prompt TEXT`、`grid_image_url TEXT`。
- （宽镜头图 `image_url` / `prompt` 保留不动；它是 P3 首帧 + 无九宫格时的 ref2v 场景锚。）

### 7.2 内容
九宫格 = **同一场景 3x3 网格，9 个固定视角，无人物**。视角集合（固定 9 张，按序）：正面、左45°、右45°、背面、鸟瞰俯视图、地面平视、左墙视角、右墙视角、主道具/出入口特写。全部：同一地点、同一光照、**画面中没有任何人物**、风格跟随项目。

**分辨率**：生成尺寸固定 **1536x1536**（3x3 每格 ~512px，首帧 fl2va 的 `_resize` 到 576x320 损失可控）——用户确认。

### 7.3 产出链路
- **新增** `save_scene_grid_prompt` 工具（`image-prompt-tools.ts`），仿 `save_scene_final_prompt`，存 `scenes.grid_prompt`。
- **改** `scene-prompt` SKILL：输出从单一宽镜头 prompt 变为**两个**——① 宽镜头 prompt（原样，存 `prompt`）；② 九宫格 prompt（新模板，9 视角，无人物）。`.en/.ja/.ko` 同步。
- **`prompt_generator.md`**：场景工作流加一步"场景最终提示词与九宫格提示词分别调用 `save_scene_final_prompt` / `save_scene_grid_prompt`"。
- **新增路由** `POST /scenes/:id/generate-grid-image`（scenes.ts）：仿 `generate-image`，用 `scene.grid_prompt`（fallback：stylePrompt + 地点 + 九宫格模板 + "无人物"），调 `generateImage({ sceneId, dramaId, prompt, model, configId, sceneGrid: true })`。
- **`generation.ts`**：`GenerateImageParams` 加 `sceneGrid?: boolean`；`SysTaskRecord` 同步；`handleImageComplete`：`record.sceneGrid` → 写 `scenes.gridImageUrl`，否则照旧 `imageUrl`。
- **`useApi.ts`**：`sceneAPI.generateGridImage(id, ...)`。
- **前端**：场景明细弹窗加第二按钮"生成九宫格"（仿"重新生成场景图"），+ 九宫格图展示/状态。`genSceneGridImg(sceneId)` 触发。
- **`getShotReferenceImages` / `getShotReferenceIndexMap`**：场景槽改用 `scene.gridImageUrl || scene.imageUrl`（九宫格优先）。

### 7.4 为什么
九宫格给模型多视角的空间锚，是 B站"场景一致性"核心手法，官方格式里正是 `<Picture N> is a storyboard reference`。宽镜头图仍是首帧（P3）；两者各司其职。

## 八、测试

1. **单测**（`backend/tests/`）：`update_storyboard` 接受 `video_prompt_full_ref`；六段式正则校验函数（header/`<Subject`/`<Picture`/`fully_preserved`/`<d>`）。
2. **桥 selftest**：`python __init__.py`（自测 `_selftest()`，已存在，现只验 ref2v）补两行断言：`v["302"]["inputs"]["ref_scale"] == 2.0`；fl2va 新工作流无悬空连线且 `first_frame` 已接线。
3. **集成/冒烟**：拿一个现有分镜重跑 ComfyUI（用户实际跑）：
   - 关闭 P3：ref2v + 九宫格 + ref_scale 2.0 → 看场景是否稳定、人脸是否保留。
   - 开启 P3：fl2va → 对比。
   - 改 `video_prompt_full_ref` 字段确认 UI 只读展示正确。
4. **回归**：非 ComfyUI 厂商（Minimax/火山/Aliyun Wan）仍用中文 `video_prompt`，不受影响；场景图生成、九宫格生成互不干扰。

## 九、风险与验证点（诚实声明）

- **P3 是实验性档位**：fl2va 对多镜头效果未验证，故做开关。真正"场景一致性"主力是 **P0+A+P1**（ref2v + 九宫格 + ref_scale 2.0），P3 是可选加强。
- **桥改动需重启 ComfyUI**：改 `__init__.py`（P1/P3）后必须重启，内存作业丢失、mp4 保留。
- **语言一致性**：六段式强制英文 vs 项目语言指令冲突，已用 `language.ts` 例外 + SKILL.md 规定双重保障，需实测 zh 与 en 两种模式下 full_ref 都出英文。
- **九宫格质量**：一次 3x3 生图（方案 A）的九宫格是否真的"同场景 9 角度"需看生成结果调 prompt。
- **首帧图分辨率**：fl2va 的 first_frame 会被 `_resize` 到生成尺寸，九宫格/宽镜头图的分辨率需够高。

## 十、非目标（YAGNI）
- 不做"自动选 P3"（先手动开关，数据够了再说）。
- 不新增独立"视频模式选择 UI 大改造"（仅一个开关）。
- 不碰非 ComfyUI 厂商的提示词链路。
- 不做 fl2va 两段（2 采）上采样——先用单 KSampler 链，显存/画质够就不做。
