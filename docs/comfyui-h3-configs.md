# MiniMax H3（ComfyUI）配置与实测台账

只记**实测过的数**，每条注明形状、后端、口径。没跑通的不写成结论。
CLAUDE.md 里只留一条引用，细节在这。
**每次更新这份文档，同时更新下面「当前最优」——它必须是文档里第一个能读到的东西。**

> **历史已删（1018，用户「删掉所有历史记录 保存当前版本」）**：1012–1018 的旧台账（VOSR2/SeedVR2、X2 半分辨率线、SLA/sol-attn、T8 BlockCache、1015-1017 的差分实验与段长之争等）不在文件里；要翻旧账 `git log -- docs/comfyui-h3-configs.md`。

## 当前最优（2026-10-18）

### 生产默认（1018 深夜用户「换成1采 20步 试试 只改这个 不要lora」）：native 单采 20 步、零 LoRA、GPU 侧 TE

**现役配置**：平台 `backend/src/services/adapters/comfyui-video.ts` 写死 `PROD_GRAPH='native'`、`steps:20`、`no_lora:true`，且不再透传分镜 lora（`lora` 两行已注释）。
桥 `_wf_video_native` 生成的图：UNETLoader(nvfp4) → Veda sp24 → BasicGuider；`BasicScheduler(simple)` 20 步 + `res_multistep`；CLIPLoader `device:"default"`（文本编码器在 GPU）；首尾帧走 `MiniMaxH3AddGuide`（frame_idx 0 / -1）；参考图走 `ref_image_0~8`。

**为什么退到 20 步**：1018 深夜两条快档都被用户判「效果不好」——PDD 5 步（task 512，494.82 s）与 4 步 turbo LoRA（task 540，438 s，首帧 PSNR 9.9 没锚住）。20 步无 LoRA 是 1016 的定案档；1018 深夜用户看 task 542 成片（sb98，`static/videos/b5a64c43-…mp4`）判「这个可以 代码以后都用这个方案」⇒ **已锁定为长期方案**。首帧 PSNR 检查在 20 步这条仍报 9.7（驱动自动重发），但用户按画面判通过，重发已停；锚检查阈值 25 只当提示、不再当否决。

**耗时实测（task 542）**：294 帧 20 步 = 发车→completed **14 分 24 秒**（864 s，GPU TE），与预估 ≈14 分钟一致。

**速度账（20 步 @1024×768）**：243 帧 674 s 实测（`test/fresh_x2432s20.mp4`，旧 cpuTE）；294 帧旧实测 20 分 10 秒（task 504，cpuTE 固定税 427 s）。**GPU 侧 TE 把固定税从 427 s 降到 ~53 s**（task 512 分阶段：fire→采样起 53 s，其中 TE 装载+编码 ~37 s；`--disable-smart-memory` 是前提，unet 载入前整块卸掉 TE，`model_management.py:924`）⇒ 294 帧 20 步预计 ≈14 分钟（task 542 实测值回填这里）。

**已下架/被否的臂**：PDD5 图（`h3_refall_pdd5_gpute.json`）与 PDD8 图留盘但平台不选；4 步 turbo 由 `no_lora:true` 摘除；分镜 lora 不再透传（要恢复 = adapter 两行取消注释 + 确认桥节点 210）。saved 图的 LoRA/BasicScheduler 限制随 PDD5 下架一并失效。

**验证入口**：`curl :6006/queue` 读 4 号 CLIPLoader 的 `device`（必须 `default`）、10 号 `BasicScheduler.steps=20`、图里无 `LoraLoaderModelOnly`。


### 提示词结构锁（1018 用户「镜头切来切去 / 声音没了」）

- **切镜数 = description 的【镜头N】数 − 1**。硬校验在 `backend/src/agents/tools/storyboard-tools.ts` 的 `update_storyboard`：中文数「切到/切回/切至」、英文数 5 个 cut 短语（`the camera/shot cuts/transitions/changes/switches to`），不符直接拒绝保存并把应有刀数写回给 Agent；批量 runner（`video-prompts.ts`）落库后再查一次，不符记 failed。
- 批量消息带 `shotPlan`：把 description 的镜头清单、镜头数、应有刀数直接写给模型（模型不会自己数）。
- 分镜拆解技能：**8-12 秒默认 2 个子镜头，12-15 秒最多 3 个**；同一组人物的中近景 ↔ 双人中近景 / 正反打属于同一镜的距离变化，用推拉/摇移，不切。
- **声音**：无对白 ≠ 无声；`overall_soundscape` 至少两个可听见的具体声源，禁 `faint` / `barely audible` / 极静 / 无人说话。实测：旧提示词写 faint 的 sb94/sb95 成片 **-55 dB**（等于没声音），有对白的 sb96 **-28.3 dB**；生成侧没有静音 bug（全部有 AAC 轨）。
- **数据损坏已修**：提示词 Agent 会回传整行占位值（`""` / `"..."`），旧过滤只挡 null/undefined ⇒ sb95/sb96/sb91 的 description/atmosphere/angle/image_prompt 被清空。现在空串与纯省略号一律当「没改」丢弃；description 不含【镜头N】时不许覆盖。受影响字段已按同场标准值重建。
- 1018 18:5x 验证：6 条提示词全部 `vp切 = full_ref cut = 镜头数−1`（#94 3 镜 2 刀；#95/#96/#97/#91 2 镜 1 刀；#98 3 镜 2 刀）。#94 原 description 有 4 个镜头（后两个近乎同机位），已合并为一个镜头内缓拉的双人中近景。

### 现役链路（用户 1018 定案：尾帧接首帧 + 首帧图走 fl2va NVFP4）

- **镜头衔接 = 上一条成片的精确末帧 → 下一条首帧**：驱动 `data/generated/.ep7_remake.mjs` 的 `shotFirst = prevFrame || sb.first_frame_image || (第一条 ? 定场图 : null)`；`prevFrame` 优先级最高。**尾帧锚整条停用**（`body.last_frame_url = undefined`）——平台的 `last_frame_image` 是 qwen 多参考单图，曾把 task 500 拽到错房间。驱动起跑前按 ORDER 抽前一条成片精确末帧当种子（日志 `续跑种子：上一条 #87 …`）。
- **场景参考图 = 九宫格优先**（用户「场景参考图 用九宫格啊」）：前端 `getShotReferenceImages` 与驱动同步 `grid_image_url || image_url`；参考位顺序仍是 **角色 → 场景 → 道具**（场景排前会吃掉人脸槽）。
- **首帧图走 fl2va NVFP4**：image adapter `backend/src/services/adapters/comfyui-h3-still.ts` + 模板 `h3-still-workflow.json`（`MiniMaxH3ImageToVideo` 无 keyframe、length 5、20 步、`ImageFromBatch(0,1)`；UNET `minimax_h3_fl2va_pruned_nvfp4`、TE heretic nvfp4 钉 CPU）。DB 配置 id 5（provider `h3-still`、priority −1 ⇒ 不当默认）；前端首帧按钮自动选它且不传参考图。**实测 254.39 s/张**（20 步采样只 11 s，其余是 TE + unet 冷读），产物 1024×768。
- **驱动重启规矩（用户「以后的 不要重启 要优先解决问题」）**：6006 健康 + 队空 + 上一单 history `success` ⇒ 同进程连跑、0 加载税；仅上一单 error/interrupted 或队非空才硬杀。

### 生产档（现役 = 上方 native 20 步零 LoRA）

| 项 | 值 |
|---|---|
| 采样 | **单采 20 步** @ **1024×768 满画布**；`BasicScheduler(simple)` + `KSamplerSelect(res_multistep)` + cfg 1.0（`BasicGuider`+`SamplerCustomAdvanced`） |
| 权重 | `minimax_h3_ref2va_pruned_nvfp4`（用户锁死，不动） |
| LoRA | **无**（`no_lora:true` 摘掉 4 步 turbo；分镜 lora 也不透传） |
| 注意力 | Veda sp24（native 图读 env `HUOBAO_H3_SPARSITY`，默认 24） |
| 参考 | 双参考 + 六段骨架提示词带 `<Picture 1>/<Picture 2>` 标签（绑定修复实证：左=青衣、右=雪琪银新月冠/耳环/额印） |
| 首尾帧 | native `MiniMaxH3AddGuide`（`frame_idx` 0 / -1、节点 43-46；与 `ref_image_0~8` 同单不互斥）。探针实测首帧 vs 锚 PSNR 31.2/SSIM 0.92、**精确末帧**（第 242 帧）28.5/0.86、交叉对照 10.3 ⇒ **判尾帧必须取精确末帧**（`-sseof -0.2` 抓到 238 帧会误读） |
| 实测 | 243 帧首发执行 **674 s**（`test/fresh_x2432s20.mp4`）；294 帧 **task 542 = 14 分 24 秒**（864 s，GPU TE，用户看片判「这个可以」）；旧 cpuTE 的 294 帧 20 分 10 秒（task 504）作废 |
| 接线 | adapter `comfyui-video.ts` 写死 `PROD_GRAPH='native'`、`steps:20`、`no_lora:true`、`DEFAULT_SIZE='1024x768'`、`UPSCALE=0`；桥 `_wf_video_native` 按 body 组图（CLIP `device:"default"`、AddGuide 首尾帧） |

### 配置详情（现役）

| 项 | 值 |
|---|---|
| 主模型 | `minimax_h3_ref2va_pruned_nvfp4.safetensors`（12.53 GB）；回退 `..._pruned_int8_convrot`（20.97 GB） |
| 文本编码器 | `qwen3vl_32b_heretic_minimax_h3_nvfp4.safetensors`（15.68 GB，无审查）—— 生产图 **`device:"default"`（GPU）**；cpuTE 旧图已下架 |
| 视频 / 音频 VAE | `minimax_h3_video_vae_int8_convrot` + `minimax_h3_audio_vae_fp32`（都上 GPU） |
| 注意力 | Veda 学习稀疏（`Veda-on-ComfyUI` + `models/veda/minimax_h3_r2va_veda_preview_fp8.safetensors`），`HUOBAO_H3_SPARSITY=24` |
| 加速 LoRA | **生产无**（`no_lora:true`，分镜 lora 也不透传）；PDD 5 步图留盘但平台不选 |
| 采样器 | 生产 `res_multistep` + `simple` 20 步 |
| 段落 | `SEG=15` / `MAXSEG=1` ⇒ 12 秒分镜 = **294 帧一段出完**（≈12.25 s）；`framesForDuration` 把帧数夹进训练区间 124-362 |
| 实例 / 启动参数 | ComfyUI **v0.39.2** + `.venv-cu130`（torch 2.14.1+cu130）on **5060 Ti**（UUID 钉卡）；`--disable-dynamic-vram --disable-comfy-compiler --disable-mmap --disable-pinned-memory --disable-smart-memory --reserve-vram 1.5 --cache-none`；env `HUOBAO_H3_SPARSITY=24` / `TORCH_ALLOW_TF32_CUBLAS_OVERRIDE=1` / `PYTHONUTF8=1` |
| 自启 | `Start-ComfyUIHidden.ps1`（参数已与上表同步，含 `--disable-smart-memory`） |
| 图片生成 | 平台默认 qwen-image-2.1（`ai_service_configs` id 4）；首帧图走 h3-still（id 5） |
| 段间接力 | **native 上不接**（平台 E2E 段间是硬切；latent 直传节点还没移植） |

## 未结

① **5 步 PDD 画质待看片判**（`static/merged/f4630870-16ab-499b-8f6e-7b49de21d4ac.mp4`）——作者口径 8 步蒸馏档 2% 以内，实际画面由用户定。
② **6 步 PDD** 外推 ≈579 s（贴近 600 上限，未实测；比 5 步更接近 8 步质量，作者口径 1% 以内）。
③ **8 步进 600 的两条路**：把 308 条 patch 烘进权重（免每步重贴）、或让 unet 部分常驻（缩帧数/降激活）。
④ native 段间 latent 直传未接（`guide/prev_latent/save_name` 在原生图没有对应节点）。
⑤ 首帧图 h3-still 仍走 TE 钉 CPU，冷启动 254 s/张 —— 是否也换 GPU TE 未测。
⑥ **接触提示词（sb89，1018 结案）**：视频提示词 skill 已加「缠绕措辞不得照抄 + 接触点写法」硬规则；task 518/519 证明只把「缠」改成「小腿贴髋」仍穿模——并躺时一条腿要碰到对侧髋必须跨过身体中线，模型算不出这个髋关节。按 B站/社区共识（模型无真 3D 空间感，易穿模部位移出画框）升级为硬规则：**并躺场景腿部零接触、整段删除「腿缠腰/腿贴髋」、默认腰部以上景别、保存前自检 `hip/calf/thigh/legs/sink`**。task 520 用平台 agent 新提示词（中文 0 个「腿/脚/小腿/髋」，英文 0 个 `leg/calf/foot/thigh/hip`）实测 **475.46 s**（发车→completed 481 s），1024×768/294 帧/12.25 s，腰以下不入画、无腿部穿模。**当前 sb89 成片 = task 520**（`static/videos/3eaf5c4c-dbc0-4867-8b90-c5f2252aca20.mp4`）。
⑦ **链式首帧 vs 切镜冲突（1018 #95 实证）**：#95 分镜第 1 段是「床面平视特写、两人并躺、十指交扣」= 切镜，但驱动无条件把 #94 末帧当首帧（#95 第 0 帧 vs #94 末帧 PSNR 30.0 dB、构图一致）⇒ 成片 0-3.33 s 延续上一镜，**交叠的手零出现**；3.33 s 切到俯卧特写（不是床面平视的手部特写），6.17 s 再切到双人侧脸（唇贴嘴/脸颊而非耳廓）。8 步 631 s 只证了渲染干净，不证分镜。后续以切镜开头的分镜应先关链式首帧（`shotFirst = prevFrame` 需加切镜例外），否则锚图会压过提示词。

⑧ **提示词批量接口（1018 已修 + sb4-12 全部重生）**：根因 = `readPromptLibrary` 挂在 `prompt_generator` 工具表里，小模型同参数连调 56 次打满 maxSteps；已从 `backend/src/agents/index.ts` 的 `AGENT_TOOLS.prompt_generator` 摘除该工具，并同步删掉 instructions 与批量消息里的引用（`video-prompts.ts`）。修复后 `generate-video-prompts` 9 条 **6 成 3 败**（10:49:06→10:51:59，失败 = #90/#97/#91）；重试 4 条仅 #95 成功。失败三镜 + 批量「成功」但违反硬规则的 5 条（#92/#93/#94/#96 写手停在「腰线」、#98 照抄「双腿盘腰」）全部改走平台 agent「只输出不保存」+ `PUT /api/v1/storyboards/:id` 机械落库（内容 agent 生成、未手改）：#97 舔足改手背/指尖接触、#98 盘腰整段删除、#92 的「腰窝/腰线」改「背脊下段」；**9/9 全部腰部以上景别、零腿部接触**。**校验（脚本逐条过）**：9 条 video_prompt/full_ref 均非空；中文无 腿/脚/小腿/膝/髋/腰（「腰部以上」与台词内「脚也来？」除外）、无「缠/陷入」；EN 无 leg/calf/thigh/knee/hip 与 wrap around（`foot` 仅 `at the foot of the bed` 陈设位、`waist` 仅 `waist up`）；每句 `<d>` 前均有 `At MM:SS.mmm` 且 ≥00:01.500。**坑**：批量接口只认「字段非空」，带旧值重生会把失败误报成成功——先清空再发；小模型对露骨/长镜仍会输出 `.` 或幻觉出别剧人名（#90 直连 chat 曾把「林肃言/许知意/沈砚舟」写进本集分镜）。

⑨ **俯卧扭头 180°（#95 3.33-6.17 s，1018 用户指出）**：左边俯卧的 A（裸背、发间白花）在同一帧里**背朝镜头、喉部正面也朝镜头**、下巴抬起且脸朝脚的方向——俯卧要看向身后的人必须低头收下巴（喉部压向床垫），抬下巴则只能朝头的方向看；两个方向同时成立 = 头相对躯干翻了约 180°（猫头鹰脖）。3.5/4.0/4.5/5.0/5.5 每帧成立，不是瞬态。**检测方法教训**：4 fps 头部条带只看了「脸朝右」的轮廓，漏了「背向与喉向同侧」这个静态矛盾；以后逐帧查背/喉朝向，不用运动扫描代替解剖检查。修法（按用户规矩，不手改提示词）：在 video-prompt（或 storyboard）skill 加「俯卧时不得扭头看向身后/脚侧的人；B 应从 A 头侧俯身，或 A 半侧身/侧躺」规则，平台重生 #95 提示词后重跑。
