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
- **坑（必读）**:
  - **参考位顺序 = 谁占脸**：`episode.vue` 的 `getShotReferenceIndexMap`/`getShotReferenceImages` 顺序为**角色 → 场景 → 道具**。若场景排前、又只有 2 个槽位，场景图会吃掉一张人脸、第二个角色被截掉 → 生成视频一人演两角色（本平台的真实 bug，已修）
  - 桥只在 ComfyUI `/history/{prompt_id}` 返回 `success` 时才翻 `succeeded`：**mp4 已在 output 下但桥仍报 processing 属正常延迟**，别当失败重跑；DB 里最终结果由 `generation.ts` 再下载回 `static/videos/`（result_url 指 6006 的 `/v1/files/...`，video_url 指 `static/videos/...`）
  - ComfyUI 已加**单实例锁**（`start_clean.ps1` 等启动脚本）。多实例并发会 OOM 并互相抢输出
  - `tsx watch` 在 5679 上跑：改后端源码会**杀掉正在跑的视频任务**，报"服务重启，生成任务中断，请重试"。改代码前先等任务跑完，或改完重启 6006
- **启动与自启**: 开发服务用 `data/generated/Start-Huobao.ps1`（后台无窗口，自动探测 5679/3013 是否已监听跳过，日志/`pid` 写 `data/generated/`）。`data/generated/` 下各脚本已改为**路径无关**（以仓库根解析），可任意目录直接 `node` 跑（如 `node data/generated/.dbq.cjs`）
- **速度实验纪律（1015，做 A/B 前必读）**: ① 判耗时 = history 的 `execution_start→execution_success`（v0.39 把这两个时间戳塞在 `status.messages` 里，条目顶层没有；逐节点时长 history/meta 也不给，阶段拆分用**差分法**：`exec = F + steps×T`，跑 steps=1/2/4 解出固定项 F）② **同 seed 同输入会被 ComfyUI 全图缓存**（1015 实测 run2 只 5.47 s = 缓存不是计算）⇒ 任何 A/B 必须换 seed ③ 系统 free <2 GB 时执行数被 paging 污染（steps2 曾报 427 s > 4 步基线 284 s）⇒ 每批发一条基线对照，对照漂了整批作废 ④ 已判死的杠杆：Veda tile 24→16→12→8 全程只省 5 s（attention 早不是大头，地板 = MLP+权重搬运，作者 README 原话）；`--disable-comfy-compiler` A/B 零收益（286 vs 283，flag 保持关）；**int8 权重路线（1015 归因结案）**：plain int8（Singularity 21 GB）实测 +132 s 比 nvfp4 还慢，int8-convrot 社区参照（MATLOWAI 65 s、作者 14.0 s/步）全是 148-SM 卡，归一化到 36-SM 的 5060 Ti = 平手 ⇒ 62 s/步就是这台卡的地板；150@4步 在这台卡只剩 **换 148-SM 级卡 / 前沿双臂 SLA5 + 半分辨率 X2（1015 夜在跑，见下条线索）**（F 侧 noaudio、TE awq、FFN 分块、画布档 全部实测判死，1015；**2 步 160 s 你已判画质不好、单人组合 fresh 实测 207 = 141 加性高估 ⇒ 步数维与单人路全关**）；**Spark-H3 adaptive-BSA（zechengtang，SM120 wheel 已装）同协议实测 371/351 vs Veda 锚 349 = 平手**（fidelity 508 = 4 步下 20% 预热白烧 1 dense 步的结构账；他们 2.05/3.15× 是 8 步 345 帧 SDPA-dense 基线，换算过来兑现不了 —— **Veda 内部预算 + Spark 这条「注意力维全灭」等 `sla5` 判完再收回**）；**1015 夜翻案线索（多人主线）= 每 SM·token 效率差 2×**：社区 DMAD-X2 在 46-SM 的 4070 上 60 s 干完 63.2k token×4 步（544×960×124）带 X2 流送解码，归一化到我们 36-SM = 77 s，我们 283 s/187k token ⇒ **慢 2.04×、未归因**；候选 = 原生 `BlockSparseAttention` 的 **SLA 5% + `sink_conditioning=exact_kv_and_rows`**（tooltip：打包文本/音频/参考行精确看、~3% 成本，Veda 无此结构；`sla` 警告「要为该模式训练过的权重」，免训练对照 = `sol-attn tau1.5≈7%`）或 X2 把解码+NVENC 藏进流送；`sla5` 臂在跑（0.39 已有节点、零安装、单变量对 349 锚） ⑤ 社区出处：Veda-on-ComfyUI issue **#3**（固定 tile 不随段长缩放：1344×768 下 32 tiles 5.2 s≈89%、14.4 s≈96%，远超训练分布；提案 `32/T37` 按 latent T 线性，未实现）、**#7**（4060 Ti 16 GB 实测 68.6→50.97 s/it ≈1.3×，不是 README 的 2.9×；另有用户报零增益）、ComfyUI **#15312**（H3 VAE 编码视频 OOM = 解码侧已知）、**MATLOWAI/minimax-h3-fused-turbo-int8-convrot**（HF，ref-delta+ turbo 烘焙单文件，16 GB 气球实测 65 s@1152×640×243 但卡是 148-SM；他的「LoRA 补丁会另存整份 unpatch 备份 ≈再 21 GB」是我们 RAM 压力的成因之一）、**sepiablue-ai/ComfyUI-MiniMax-H3-DMAD-X2**（GitHub+HF，4070 12 GB 实测 58–64 s/124f@544×960→1088×1920 带音频，SLA5+X2 流送+DMAD/MATLOW fused，`docs/validation.md` 逐条 SHA256 与整单秒数；归一化 = 我们每 SM·token 慢 2× 的来源候选）、**TeamAIQ/h3-lora-comparison**（PDMD/DMAD/MATLOW 三方并排画质页 https://teamaiq.github.io/h3-lora-comparison/）。现役数与目标线见 [docs/comfyui-h3-configs.md](docs/comfyui-h3-configs.md)「当前最优」：10s@1024×768 热跑 **283/287 s**（sp24，≤300 达成），150 s 未达成（4 步 = 卡的地板；2 步 160 s 等画质判定；**单人 2 步组合 fresh 实测 207 ⇒ 141 是加性高估**；多人新候选 = SLA5 / 半分辨率 X2，在跑）

## Database
SQLite 单文件（默认 `data/huobao.sqlite3`，桌面版在 userData）。启动时 `initSqliteSchema` 幂等建表 + 风格预设种子。MySQL→SQLite 一次性迁移：`cd backend && npx tsx scripts/import-mysql-to-sqlite.ts [--force]`（逐表行数校验、写前备份）。

## Key Config
- AI 服务配置存 DB（`ai_service_configs` 表），设置页维护，不在配置文件
- 环境变量全集见 README「环境变量」；`configs/config.yaml` 是死配置（勿参考）
- `PUBLIC_BASE_URL`：Seedance 引用本地参考资源需公网地址，桌面版无此能力（有中文报错）
