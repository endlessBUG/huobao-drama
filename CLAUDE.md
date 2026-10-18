# CLAUDE.md

## Project Overview

火宝短剧（Huobao Drama）— AI 短剧/漫剧一站式制作工具。全 TypeScript 栈：小说 → 剧本改写 → 资产提取 → 生图 → 分镜拆解 → 生视频 → FFmpeg 拼接导出。支持 Electron 桌面版（macOS dmg）与服务器部署。

## 工作方式

**遇到困难的问题先搜索方案，再决定路线。** 不凭记忆盲试、不直接换条路重跑。搜索按序：上游源码（本机已装的 custom_nodes / node_modules）→ 官方仓库 issue 与文档 → 社区（HF 讨论区、Reddit、第三方指南）→ 本项目记忆与 `data/generated/` 历史脚本。搜完列出候选方案和各自的证据，再动手；结论要能指出是源码哪一行/哪次实测支撑的。

## Structure

```
backend/   — Hono + Drizzle ORM (better-sqlite3) + Mastra (AI agents)
backend/workspace/ — Agent 工作目录（Mastra Workspace jail 根）
backend/workspace/skills/ — Agent SKILL.md definitions（设置页可在线编辑）
frontend/  — Nuxt 3 + Vue 3 + TypeScript，ssr:false（纯 CSS，无 UI 框架）
desktop/   — Electron 桌面版：主进程 + esbuild 打包脚本 + electron-builder 配置
data/      — SQLite 数据库（huobao.sqlite3）+ 生成的静态文件（static/）
data/generated/ — 调试/产出物暂存区（未提交 git）：自启脚本 Start-Huobao.ps1、
  各类 .check_*.mjs / .dbq.cjs / .rerun_faces.cjs 调试脚本、test_frames/ 抽帧、autostart 日志与 pid
configs/   — 遗留死配置，代码零引用
```

## Commands

### Backend (`backend/`)
- `npm run dev` — tsx watch 开发服务（端口 5679）
- `npm start` — tsx 生产启动
- `npm run typecheck` — TypeScript 类型检查
- `npm run backfill-artwork` — 存量图片/视频补缩略图与海报帧

### Frontend (`frontend/`)
- `npm run dev` — Vite 开发服务（端口 3013，代理 /api 与 /static 到 5679）
- `npm run generate` — 产出含 index.html 的静态站点（`.output/public`；`nuxt build` 不产 index.html，不能用于静态托管）

### Desktop (`desktop/`，根目录 `npm run dist` 串联全流程)
- `npm run dev` — 打包后端 bundle + Electron 窗口运行
- `npm run build:backend` — esbuild 打包 backend/src → build/backend.mjs（ESM；externals: sharp/better-sqlite3/ffmpeg-static/ffprobe-static）
- `npm run build:main` — 打包主进程 → dist/main.js
- `npm run rebuild:native` — better-sqlite3 按 Electron ABI 重编（原生模块 ABI 变化后必须执行；postinstall 已自动做）
- `npm run dist` — prepare-resources + electron-builder 出 arm64/x64 dmg → release/
- `npm run dist:win` — 交叉打包 Windows NSIS 安装器（win-x64）；win 版 ffmpeg.exe 缓存在 build/win-bin/（缺失时脚本提示下载地址）

## Architecture

### Backend
- **HTTP**: Hono（入口 `src/index.ts`），路由挂 `/api/v1`，`/static` 服务 DATA_ROOT，生产托管前端静态目录
- **Database**: SQLite（better-sqlite3 + WAL），`SQLITE_PATH` 覆盖库文件位置；DDL 在 `src/db/sqlite-schema.ts`，启动时幂等重放；Drizzle 表定义 `src/db/schema.ts`（sqlite-core）
- **路径锚点**: `src/utils/paths.ts` 统一解析 DATA_ROOT/STORAGE_ROOT；桌面版由 Electron 主进程注入 env（`HUOBAO_DATA_DIR`/`SQLITE_PATH`/`WORKSPACE_PATH`/`FRONTEND_DIST`/`FFMPEG_BIN`/`FFPROBE_BIN`），dev 走仓库相对路径默认值
- **AI Agents**: Mastra，4 个 agent（script_rewriter / extractor / storyboard_breaker / prompt_generator），instructions 从 `workspace/prompts/*.md` + skills 动态拼接，模型按请求解析；fetch 补丁链适配国内中转站（关思考/温度/max_tokens）
- **媒体生成**: `services/generation.ts` 统一任务生命周期（sys_task 表），适配器模式：图片 openai/gemini/volcengine，视频 volcengine/minimax/comfyui（本机 ComfyUI，见下文）；adapter `buildGenerateRequest` 可返回 Promise（comfyui 需先落盘参考图）
- **视频拼接**: `services/ffmpeg-merge.ts`，FFmpeg 二进制内置（ffmpeg-static），可用 `FFMPEG_BIN`/`FFPROBE_BIN` 覆盖

### Frontend
- Nuxt 3 SPA，动态路由在 `nuxt.config.ts` 的 `pages:extend` 手动注册（views/drama/）
- `app/composables/useApi.ts` 统一 fetch 客户端（全相对路径，生产与后端同源）
- 核心工作台 `app/views/drama/episode.vue`（剧本→制作→导出流水线）

### Desktop
- 主进程 `desktop/src/main.ts`：单实例锁 → 空闲端口 → userData 准备（workspace 模板 copy-once + `.template-version` 版本标记）→ `utilityProcess.fork` 后端 → 轮询 health → BrowserWindow
- userData：打包版 `~/Library/Application Support/HuobaoDrama/`，dev 版 `HuobaoDrama-Dev/`（互不干扰）
- 后端 bundle 在 asar 内（externals 经 asar node_modules 解析，.node 自动重定向 unpacked）

## 本机 ComfyUI（视频 ref2v，E:\AI\ComfyUI，仓库外）

本地 ComfyUI + 自研 `ComfyUI-OpenAI-Bridge` 扩展（OpenAI 兼容 HTTP 桥），**不在本 git 仓库**，改桥代码必须重启 ComfyUI 才生效。接口文档（引用式，差异项已标注）：[docs/api/comfyui-api.md](docs/api/comfyui-api.md)。

配置与实测台账（引用式，只记实测过的数）：[docs/comfyui-h3-configs.md](docs/comfyui-h3-configs.md) —— 开头是**当前最优方案**，每次更新文档必须同时更新它；下面是形状×后端×每步/整单、`--enable-triton-backend` 这个真开关、内存与盘的账、跑不了的几条。

- **平台**: ComfyUI（端口 6006，`python main.py --port 6006`）+ `custom_nodes/ComfyUI-OpenAI-Bridge`。模型：视频 `minimax-h3-ref2v`（JZL ref2v，576x320，默认 124 帧 ≈ 5.2s@24fps，支持 9 张参考位 `ref_image_0~8`，Autogrow max=9）；图片 `krea2-turbo`
- **端点**（OpenAI 兼容）: `POST /v1/videos/generations` 返回 202 + job id（body: `prompt`/`model`/`size`/`length`/`images`[文件名列表，落在 ComfyUI `input/`]）；`GET /v1/videos/generations/{id}` 轮询 `status`=processing/succeeded/failed；`GET /v1/files/{rel-path}` 取 mp4。作业状态存桥进程内存 dict，**进程重启丢作业状态，mp4 仍在 `output/openai/`**
- **后端接入**: adapter `backend/src/services/adapters/comfyui-video.ts`（provider=`comfyui`，注册在 `adapters/registry.ts`）；参考图**先下载/读入 ComfyUI `input/` 目录再传文件名**（桥要文件名不是 URL），`MAX_IMAGES=9`；settings 页已暴露 `comfyui` provider 预设（baseUrl `http://127.0.0.1:6006`，model `minimax-h3-ref2v`）
- **生产图（1017 用户「保存 然后接入」，已存成文件）**: `custom_nodes/ComfyUI-OpenAI-Bridge/workflows/h3_refall_cpuTE.json` = 定案口径的实体（20 步单采 / 去 turbo LoRA / NVFP4 unet 11.67 GB + 无审核 NVFP4 TE 14.61 GB / Veda sp24 / 9 个参考槽 / 首尾帧两条 AddGuide 锚 / **文本编码器 `device:"cpu"`** —— `nodes.py:1023` 与 `:1036-1037`，仓库根的 `nodes.py`，不是 `comfy/nodes.py`）。body 传 `graph:"<文件名>"` 就走它（桥 `_wf_saved` 按**消费者角色**填动态量：提示词、画布、帧数、参考图顺序、seed、steps、输出前缀，再从终端反向 BFS 剪孤儿）；同图不钉 CPU 的回退 = `h3_refall.json`。**1017 血证**：`graph` 曾被 `backend/src/services/generation.ts:296` 那个逐字段列出来的 record 字面量漏抄 ⇒ 文件存在、适配器读 `record.graph`、但桥恒收到 `native`（1017 全部「saved 工作流已跑通」的旧证据因此作废），补那行后 task 489（13:42Z）才是第一次真跑；判「这一发到底走哪张图」= `curl :6006/queue` 读 4 号 CLIPLoader 的 `device`。
- **坑（必读）**:
  - **参考位顺序 = 谁占脸**：`episode.vue` 的 `getShotReferenceIndexMap`/`getShotReferenceImages` 顺序为**角色 → 场景 → 道具**。若场景排前、又只有 2 个槽位，场景图会吃掉一张人脸、第二个角色被截掉 → 生成视频一人演两角色（本平台的真实 bug，已修）
  - 桥只在 ComfyUI `/history/{prompt_id}` 返回 `success` 时才翻 `succeeded`：**mp4 已在 output 下但桥仍报 processing 属正常延迟**，别当失败重跑；DB 里最终结果由 `generation.ts` 再下载回 `static/videos/`（result_url 指 6006 的 `/v1/files/...`，video_url 指 `static/videos/...`）
  - ComfyUI 已加**单实例锁**（`start_clean.ps1` 等启动脚本）。多实例并发会 OOM 并互相抢输出
  - `tsx watch` 在 5679 上跑：改后端源码会**杀掉正在跑的视频任务**，报"服务重启，生成任务中断，请重试"。改代码前先等任务跑完，或改完重启 6006
- **启动与自启**: 开发服务用 `data/generated/Start-Huobao.ps1`（后台无窗口，自动探测 5679/3013 是否已监听跳过，日志/`pid` 写 `data/generated/`）。`data/generated/` 下各脚本已改为**路径无关**（以仓库根解析），可任意目录直接 `node` 跑（如 `node data/generated/.dbq.cjs`）
- **速度实验纪律（1015，做 A/B 前必读）**: ① 判耗时 = history 的 `execution_start→execution_success`（v0.39 把这两个时间戳塞在 `status.messages` 里，条目顶层没有；逐节点时长 history/meta 也不给，阶段拆分用**差分法**：`exec = F + steps×T`，跑 steps=1/2/4 解出固定项 F）② **同 seed 同输入会被 ComfyUI 全图缓存**（1015 实测 run2 只 5.47 s = 缓存不是计算）⇒ 任何 A/B 必须换 seed ③ 系统 free <2 GB 时执行数被 paging 污染（steps2 曾报 427 s > 4 步基线 284 s）⇒ 每批发一条基线对照，对照漂了整批作废 ④ 已判死的杠杆：Veda tile 24→16→12→8 全程只省 5 s（attention 早不是大头，地板 = MLP+权重搬运，作者 README 原话）；`--disable-comfy-compiler` A/B 零收益（286 vs 283，flag 保持关）；**int8 权重路线（1015 归因结案）**：plain int8（Singularity 21 GB）实测 +132 s 比 nvfp4 还慢，int8-convrot 社区参照（MATLOWAI 65 s、作者 14.0 s/步）全是 148-SM 卡，归一化到 36-SM 的 5060 Ti = 平手 ⇒ 62 s/步就是这台卡的地板；150@4步 在这台卡曾经的活路只剩 **换 148-SM 级卡 / 半分辨率 X2 —— 后者 1015 夜实测 138 s 已达成 ≤150**（`x2half`：512×384×243 采样 token÷4 + `H3X2StreamSave` ×2 解码回 1024×768、多人双参考、4 步、nvfp4、Veda 不动、带音频；**前提 = `[huobao-1015c]` `sd.py` 打包头补丁；1016 你判「画质太差」⇒ 原样不进生产**；B32 参考增强臂 `x2b32` **挂死判死**（22 min 停在 B32 阶段、显存打满 42 W、interrupt 弃跑 —— 他们的逐 tile 路径和四 disable 打架，未读透不再烧卡）；`x2half768`（768×576→1536×1152）复测首发 212/219、**同进程热跑 148 s ⇒ ≤150 达成（1016 你判画质「不错」；第二条 free 6 GB 只会虚高，虚高仍 148 = 保守硬证）**；差分已解 **T₅₁₂=16.2 / T₇₆₈=36.4 / F'≈73** ⇒ 半分辨率的账全在 token 数、与内核无关；还开 **640×480 中间档**（≈170，**1016 实测 `x2640` = 162 s**、1280×960+音轨，等你判画质）与 **12fps+GMFSS 补帧（512×384×122 ≈68 s + 补帧）**；否则回 ⑩ 换卡）（F 侧 noaudio、TE awq、FFN 分块、画布档 全部实测判死，1015；**2 步 160 s 你已判画质不好、单人组合 fresh 实测 207 = 141 加性高估 ⇒ 步数维与单人路全关**）；**Spark-H3 adaptive-BSA（zechengtang，SM120 wheel 已装）同协议实测 371/351 vs Veda 锚 349 = 平手**（fidelity 508 = 4 步下 20% 预热白烧 1 dense 步的结构账；他们 2.05/3.15× 是 8 步 345 帧 SDPA-dense 基线，换算过来兑现不了 —— **Veda 内部预算 + Spark 这条「注意力维全灭」等 `sla5` 判完再收回**）；**1015 夜翻案线索（多人主线）= 每 SM·token 效率差 2×**：社区 DMAD-X2 在 46-SM 的 4070 上 60 s 干完 63.2k token×4 步（544×960×124）带 X2 流送解码，归一化到我们 36-SM = 77 s，我们 283 s/187k token ⇒ **慢 2.04×、未归因**；候选 = 原生 `BlockSparseAttention` 的 **SLA 5% + `sink_conditioning=exact_kv_and_rows`**（tooltip：打包文本/音频/参考行精确看、~3% 成本，Veda 无此结构；`sla` 警告「要为该模式训练过的权重」，免训练对照 = `sol-attn tau1.5≈7%`）或 X2 把解码+NVENC 藏进流送；`sla5`/`solattn15` **已实测全判死（整单 378 / 382 s、每步 91→73 仍 > Veda 62；原生 `BlockSparseAttention` 在 sm_120 的 producer 路径慢）**（生效确认 `.err`：`sparse producer path: 59341 tokens` —— 顺手纠正 token 账：1024×768×243 真实序列 = 59.3k token，不是 187k ⇒ **社区的 2× 不在注意力，在 token 数（帧×像素）与 X2 把解码+NVENC 藏进流送**）；**真杠杆臂 = `x2half`**（512×384×243 = token ÷4 + `H3X2StreamSave` ×2 解码回 1024×768，预测 98-130 s ≤150；节点已装 pin `eb148a3d`、零 pip、torch 未动；解码器原料 5.25 GB 下载中，本地制备 9.6 s；风险 = 脸软，看片判） ⑤ 社区出处：Veda-on-ComfyUI issue **#3**（固定 tile 不随段长缩放：1344×768 下 32 tiles 5.2 s≈89%、14.4 s≈96%，远超训练分布；提案 `32/T37` 按 latent T 线性，未实现）、**#7**（4060 Ti 16 GB 实测 68.6→50.97 s/it ≈1.3×，不是 README 的 2.9×；另有用户报零增益）、ComfyUI **#15312**（H3 VAE 编码视频 OOM = 解码侧已知）、**MATLOWAI/minimax-h3-fused-turbo-int8-convrot**（HF，ref-delta+ turbo 烘焙单文件，16 GB 气球实测 65 s@1152×640×243 但卡是 148-SM；他的「LoRA 补丁会另存整份 unpatch 备份 ≈再 21 GB」是我们 RAM 压力的成因之一）、**sepiablue-ai/ComfyUI-MiniMax-H3-DMAD-X2**（GitHub+HF，4070 12 GB 实测 58–64 s/124f@544×960→1088×1920 带音频，SLA5+X2 流送+DMAD/MATLOW fused，`docs/validation.md` 逐条 SHA256 与整单秒数；归一化 = 我们每 SM·token 慢 2× 的来源候选）、**TeamAIQ/h3-lora-comparison**（PDMD/DMAD/MATLOW 三方并排画质页 https://teamaiq.github.io/h3-lora-comparison/）。现役数与目标线见 [docs/comfyui-h3-configs.md](docs/comfyui-h3-configs.md)「当前最优」。**1016 用户定案：生产 = 20 步单采 @1024×768 满画布、去 turbo LoRA、nvfp4 + Veda sp24、双参考六段骨架提示词**（人物绑定已修）—— 新进程首发执行 **674 s**（`test/fresh_x2432s20.mp4`，1024×768/243f/24fps/带音轨）；账 = **无 LoRA 线 `exec = 124 + 27.5×步`**（12 步 454 / 20 步 674 两条独立同解） vs turbo 线 `36 + 62×步` = **同画布每步 2.25×**（归因臂 `x2432s12l` 在跑）；**平台已接线（1016 夜，未结⑰ 结案）**：桥 `_wf_video_native` 吃 body `steps/no_lora/first_frame/last_frame`（桥默认仍 4 步 turbo，平台显式传 20/true）、adapter 写死定案（`DEFAULT_SIZE='1024x768'`、`steps:20`、`no_lora:true`、`UPSCALE=0`）、UI `genVid` 带分镜首/尾帧图；**首尾帧走 native AddGuide**（核心 `MiniMaxH3AddGuide`、`frame_idx` 0/-1、节点 43-46，与 `ref_image_0~8` 同单不互斥；老 fl2va 576×320/4 步只剩 body `graph:"jzl"`）—— 探针（**这条没走平台流程**）实测 **675 s**（锚 674、+1 噪声门内 = 首尾帧零额外成本）、首帧 vs 锚 **PSNR 31.2/SSIM 0.92**、**精确末帧**（第 242 帧）vs 锚 **28.5/0.86**、交叉对照 10.3 ⇒ 判尾帧必须取精确末帧（`-sseof -0.2` 抓到 238 帧、只有 20.6 会误读成「尾帧锚弱」）；仍开 = docs 未结④（native 段间 latent 直传，接力在原生图 = 不接，平台 E2E 段间是硬切不是缝）。≤150 快档备用 = `x2half768` 热跑 148 s（1536×1152，你判「不错」）；4 步 1024×768 地板 = 283 热 / 349 首发
- **1017 定案口径（15:45 定稿，用户「我是说 b3f4e610」= 看 `output/openai/h3_b3f4e610_00001_.mp4` = task 492 的 243 帧单段判「这次可以」）**：~~每段 **10 秒 = 243 帧**、`MAXSEG = 2`~~ ⇒ **1018 用户「改回去」：现役 = `SEG=15`/`MAXSEG=1`、12 秒 = 294 帧一段出完（≈12.25 s）；15:45 的判死前提是 E: 只剩 2.7 GB，腾盘后 task 495 已证每步不爬 ⇒ 294 帧按新前提重验（**1018 01:08Z 实测 task 500 = 29 分 41 秒一段、12.250 s 成片，全 offload 但每步 46-60 秒不爬 ⇒ 旧的「294 帧必死」只在 E: 快满时成立；仍超 9 分钟线**；**1018 12:07Z 加 `--reserve-vram 1.5` 复跑 task 504 = 20 分 10 秒（20 步全程 35.8-36.8 秒/步、step 12 换挡未复现、成片 12.250 s，单样本）**）**。旧口径的账保留：12 秒分镜 = 243 + 124 帧（15.324 秒素材、超 3.3 秒 —— `comfyui-video.ts:82-89` 的 `framesForDuration` 把帧数夹进训练区间 **124-362**，任何尾段至少 5.17 秒，「尾段拿余数 2 秒」物理上做不到），20 步单采 @1024×768、去 turbo LoRA、带音轨、`graph = workflows/h3_refall_cpuTE.json`（**14.61 GB 文本编码器钉 CPU** = 今晚唯一真生效的显存杠杆：native 那条它一上 GPU 就把 11.67 GB 的 unet 整个顶出去 = 320-395 秒/步）；**整条流水线只在开场重启一次 6006、后面每条分镜每段同进程连跑**。账（全部实测）：每个新进程 ≈470 秒是冷读（TE + unet 从只剩 **2.7 GB** 空闲的 E: 重读、页面文件就在 E: ⇒ 每步越来越慢）、每条 12 秒 = 1034 + 880 = **31.9 分钟**（1018 补丁后复测：1053 + 725 = **29.6 分钟**，含拼段与整集合成 30 分 00 秒、两条 task 都 completed）、11 条 ≈ 5.8 小时。**「一条一段出完（294 帧）」已判死**（task 494，15:13:02 发车：`0.00 MB usable / 11945.45 MB offloaded` = unet 全挂内存/盘、tqdm 39.54 → 313.58 秒/步、step 6/20 用 22:33、剩 14 步 ≈75 分钟 ⇒ 撞后端 100 分钟上限，15:45 主动放弃）—— 我 15:05 拿「边际 1.3 秒/帧」推翻 1016 17:05 那条老规矩是错的：**那个边际只在部分常驻（5 GB loaded）时成立，全 offload 时每步的账随帧数一起涨**。**要再快只剩三条（1017 16:05Z 更新）**：① **腾盘已做**（用户「可以 做、」）：删 28.45 GB 判死权重（quantfunc int4 11.52 + Q2_K 6.22 + SCAIL-2 7.55 + seedvr2 3.16，清单 `data/generated/deleted-1017.txt`；Singularity int8 19.53 与 fl2va nvfp4 11.67 没动），E: 2.69 → 31.14 GB ⇒ **「每步越来越慢」治好**：task 495（243 帧、同图同画布）tqdm **28.82 → 28.54 秒/步**（对照 task 494 的 39.54 → 313.58），但装载行逐字未变（`0.00 MB usable / 11945.45 offloaded`）⇒ **常驻没回来、每步仍搬 11.9 GB**（28.5 vs 常驻锚 15.78 秒/步），冷读税也仍是 **≈465 秒**（发车→采样起；发车那刻物理内存空闲 0.004 GB）⇒ 243 帧整段 ≈20 分钟。② **页面文件挪到 C:**（空 131.6 GB）+ 重启机器 —— 唯一还能砍冷读税的，等用户一句话。③ `comfy/cli_args.py:102` 的 **`--cpu-vae`**（`nodes.py:775` 的 `VAELoader` 没有 `device` 输入，只能走启动参数）—— 给 unet 腾 3.18 GB 换部分常驻，不砍税，**未测**（测一发要再交 ≈465 秒）。**用户 16:05 新规矩「超过9分钟要停掉」⇒ 今晚没有任何一段能进 9 分钟**（实测最快：124 帧首发 12.8-13.1 分钟、同进程连跑 124 帧 14.7 分钟、热页缓存 native 6 分 48 秒不可复制）⇒ 等用户选：抬到 15 分钟 / 挪页面文件重启 / 9 分钟按**采样段**算（124 帧 5.3-6.5 分钟 ✓、243 帧 9.5 分钟）。数与出处都在 docs「当前最优」。
- **1018 用户定案：镜头链式首帧 + fl2va NVFP4 首帧图**：① 驱动 `data/generated/.ep7_remake.mjs` 的 `shotFirst = prevFrame || sb.first_frame_image || ...` —— **上一条成片精确末帧优先**，尾帧锚 `last_frame_url` 整条停用（平台 qwen 多参考单图曾把 task 500 拽到错房间/两人同装，根因 = qwen adapter 只喂 `refs[0]`，1018 已按 `TextEncodeQwenImage21` 的 `image_1..image_16` 修）；② **场景参考图回到九宫格优先**（用户「场景参考图 用九宫格啊」），前端 `getShotReferenceImages` 与驱动同步 `grid_image_url || image_url`；③ 首帧图走新 image adapter `backend/src/services/adapters/comfyui-h3-still.ts`（provider `h3-still`、base 6006、配置 id 5、priority −1 ⇒ 不当默认；图 = `MiniMaxH3ImageToVideo` 无 keyframe + length 5 + 20 步 + `ImageFromBatch(0,1)`，UNET `minimax_h3_fl2va_pruned_nvfp4`、TE heretic nvfp4 钉 CPU）——**task 502 实测 254.39 s/张**（20 步采样只 11 s，其余是 14.96 GB TE + 12 GB unet 冷读），产物 1024×768；前端首帧按钮自动选它且不传参考图。④ **1018 用户规矩「以后的 不要重启 要优先解决问题」**：驱动 `restartComfy()` 已加旁路（6006 健康 + 队空 + 上一单 history `success` ⇒ 同进程连跑、0 加载税；仅上一单 error/interrupted 或队非空才硬杀）；`/free {"unload_models":true}` 会卸模型、等于再付 8 分钟，不是替代品；慢的根因按显存溢出查，不拿重启当解法。⑤ **1018 15:0x 两笔实测**：`--disable-cuda-malloc` 判死（task 508 native allocator 步 1 起 148.75 秒/步，同 294 帧 cudaMallocAsync 段 1-15 是 36.2–36.4；步 16 换挡 73.8→216.8 = FB 15587/464 MiB、BAR1 16355/16384、41 W 的池不还内存，VRAM_Debug `freed 0`）⇒ flag 已从启动脚本删；**首帧断链根因** = 驱动按条重启后 `prevFrame=null`，sb88 落到库里过期 `first_frame_image`（c00eb25c，成片首帧 vs 它 PSNR 12.0；`References: 4 spans` 证明 AddGuide 本身生效）⇒ 驱动起跑前按 ORDER 抽前一条成片精确末帧当种子，已打出 `续跑种子：上一条 #87 …`。细则在 docs「当前最优」。
- **1018 16:2x 速度臂（用户目标「降低到 600s以内 测」= 达成）**：**GPU 侧 TE + `--disable-smart-memory` + PDD 5 步 LoRA = 整单 494.82 s**（task 512，1024×768/294 帧/带音轨，发车→merged 8 分 54 秒；产物 `static/videos/d6cbb3a4-…mp4`）。三个杠杆缺一不可：① CLIPLoader `device:"default"`（CPU 文本编码 6.5-7 分钟 → GPU ~32 s，固定税 427→53 s；TE `loaded partially 10108.65 usable / 9397.24 loaded / 5559.15 offloaded`）；② `--disable-smart-memory`（`model_management.py:924` 的 `memory_to_free=1e32`：unet 载入前把 TE 整块卸掉，否则重演 1017 的 TE 顶掉 unet；task 509 单变量对照证明它本身不抬步时 35.8 ≈ 36.2）；③ PDD 加速 LoRA（fbjr 转换 alibaba-pai 官方 PDD；节点 `custom_nodes/comfyui_minimax_h3_pdd`、权重 `models/loras/minimax_h3_ref2va_pdd_8step_comfy.safetensors`，`steps:5` = 作者 README 的 8 步 2% 内档位，8 步是蒸馏档；图 `workflows/h3_refall_pdd{5,8}_gpute.json`，节点 17 model 接 Veda、sigmas 接采样器、删 BasicScheduler、采样器 euler；驱动 `EP7_GRAPH=h3_refall_pdd5_gpute.json`）。**8 步判超**：294 帧 82.25/81.78/81.28 s/步 ⇒ 656 s 采样，预计整单 ≈780 s，跑到 3/8 停；**243 帧完整补测（#95）= 平台 631 s / ComfyUI 622 s（69 s/步），仍超 600 线 31 s**；**每步 81 vs 基线 36 的根因 = 294 帧下 unet 仍全 offload（`0.00 MB usable … lowvram patches: 308`）⇒ 308 条 PDD patch 每次权重流送重贴**（task 509 无 PDD + smart-off = 35.8 s/步即对照）；6 步外推 ≈579 s 贴近上限未测。细节与阶段拆分在 docs「当前最优」。
- **1018 提示词批量修复 + ep7 sb4-12 重生**：`prompt_generator` 的 `readPromptLibrary` 已摘（小模型同参数连调 56 次打满 maxSteps 的根因），批量消息同步删引用；`generate-video-prompts` 9 条 **6 成 3 败**，重试 4 条仅 #95 成。剩 #90/#97/#91 + 批量「成功」但违规的 #92/#93/#94/#96（手停「腰线」）与 #98（照抄「双腿盘腰」）走 agent「只输出不保存」+ 平台 `PUT /api/v1/storyboards/:id` 落库（agent 生成、未手改）；**9/9 全部腰部以上、零腿部接触**（#97 舔足改手背/指尖、#98 盘腰整段删、#92 腰窝改背脊下段）。**批量只认字段非空 ⇒ 重生前必须先清空**；小模型仍会输出 `.` 或幻觉别剧人名。细节在 docs 未结⑦。

## Database
SQLite 单文件（默认 `data/huobao.sqlite3`，桌面版在 userData）。启动时 `initSqliteSchema` 幂等建表 + 风格预设种子。MySQL→SQLite 一次性迁移：`cd backend && npx tsx scripts/import-mysql-to-sqlite.ts [--force]`（逐表行数校验、写前备份）。

## Key Config
- AI 服务配置存 DB（`ai_service_configs` 表），设置页维护，不在配置文件
- 环境变量全集见 README「环境变量」；`configs/config.yaml` 是死配置（勿参考）
- `PUBLIC_BASE_URL`：Seedance 引用本地参考资源需公网地址，桌面版无此能力（有中文报错）
