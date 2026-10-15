# H3 速度工程（10s @ 1024×768 → ≤150 s）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 10 秒 1024×768 视频的生成时间从现役 283 s（4 步、热跑、Veda sp24）压到 ≤150 s；压不到就给出带数的地板判定 + 两条备选路（2 步画质 / 换卡）的决策记录。

**Architecture:** 一切围绕 `exec = F + steps × T` 三因子做单变量归因：T 维换注意力内核（Spark adaptive-BSA vs Veda sp24）、F 维剥固定项（TE awq / 单参考 / FFN 分块 / 存盘预设）、steps 维测 2 步档。每条臂 = 独立重启 6006 后的进程第一条（本机 32 GB RAM 第二条必被 paging 污染，1015 已两次被假高骗过）。胜者从探针图移植进桥 `_wf_video_native`，走平台 `/api/v1/tasks` 端到端复验，再收文档。

**Tech Stack:** ComfyUI v0.39.2 + `.venv-cu130`（torch 2.14.1+cu130，5060 Ti 16 GB 钉卡）；`ComfyUI-OpenAI-Bridge`（仓库外，改后必须重启）；Spark-H3 节点包（已装：`custom_nodes/ComfyUI-Spark-H3` + `comfy-kitchen 0.2.37+spark.h3.sm120.cu130.1`）；KJNodes（已装，`MiniMaxChunkFeedForward`）；探针脚本 `data/generated/.speed_one.mjs`（未提交 git，路径无关）；后端回归 `backend/tests/comfyui-*.test.*`。

**Spec:** 优化点地图 = 本会话 1015 brainstorm（Spike 报告，用户已认可并锁 nvfp4）；一手数与纪律 = [docs/comfyui-h3-configs.md](../../comfyui-h3-configs.md)「当前最快」+ CLAUDE.md「速度实验纪律」。本计划从这些数出发，不重述历史台账。

## Global Constraints

- 权重链 = `minimax_h3_ref2va_pruned_nvfp4.safetensors` + `minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16`（用户 1015 原话「模型还是用NVFP4吧」「nvfp4 效果好」；fused int8-convrot 只作探针，**不进生产**）
- 画质基准 = 4 步（用户原话「四步画质好」）；1 步已判死；2 步 = 待用户判定的速度档
- 判数口径 = history 的 `execution_start→execution_success`（v0.39 在 `status.messages` 里，条目顶层没有）
- `free@submit ≥ 8 GB` 才采信；每条臂换 seed（同 seed 同输入 = 全图缓存，1015 被 5.47 s 骗过）
- 每臂 = 新进程第一条（`_restart_6006_nofd.ps1` → sleep 12 → 提交）；同进程连跑只用于已判干净的**热跑补数**，且前后都报 free
- 现役启动 env 保持：`--disable-dynamic-vram --disable-comfy-compiler --disable-mmap --disable-pinned-memory` + `HUOBAO_H3_SPARSITY=24` + UUID 钉卡
- 第三方依赖绝不动 `.venv-cu130` 的 torch（`pip install --no-deps`；本机 ComfyUI 环境冻结规则）
- 桥（`custom_nodes/ComfyUI-OpenAI-Bridge/__init__.py`）改动必须重启 6006 生效；改代码前先等任务跑完（`tsx watch` 5679 会杀在跑的生成任务）
- 后端测试跑法：`cd backend && npx tsx --test --test-reporter=tap tests/*.test.mjs tests/*.test.ts`（否则首个断言失败截断进程）
- 目标线：≤150 s 执行口径；墙钟另报（15 s 轮询粒度）
- **有问题查社区（用户 1015 点名，覆盖全部任务）**：任何臂出现 报错/OOM/节点加载失败/结果反物理（例：4 步比 2 步还慢、Δ 与单变量预期不符）⇒ 按 CLAUDE.md 搜索序查：**上游源码（本机 custom_nodes / node_modules）→ 官方仓库 issue 与文档 → 社区（HF 讨论区/Reddit/第三方指南）→ 本项目记忆与 `data/generated/` 历史脚本**；搜完列候选方案 + 各自证据（指到源码行/实测）再动手，决定与依据写进 ledger 的 `Ruling:` 行。联网收口纪律 = 2 搜 + 2 读原文为一条问题的上限，到限无解就如实记「联网未定位（附已搜关键词）」

## Review Focus

- **内核首编混进首发数**（Spark 三臂 508 s 已现形）：fresh 数不能直接判 T —— 每条胜者臂必须补同进程热跑（换 seed）再下结论
- **fidelity/预热语义错配**：Spark `fidelity` = 20% dense 是按 20 步设计的，4 步下白烧 1 步 —— 任何「按官方默认档」的采纳都要重算到我们的 steps 上
- **臂内混变量**（fused 臂曾捆绑 TE 换件）：跨臂比较只认单变量；要复现某臂的组合收益，另开组合臂
- **paging 污染伪装成变慢/变快**：free <2 GB 时整批作废（1015 血证 415/486/427 三条假高）
- **探针赢了但平台没赢**：胜者若只活在手搓 `/prompt` 图里 = 未交付 —— 必须进桥 + 走 `/api/v1/tasks` 复验（CLAUDE.md「一切走平台接口触发」）

---

### Task 1: Spark speed 档归因（收三臂 + 热跑补数）

**Files:**
- Modify: `data/generated/.speed_one.mjs`（已含 sparkf/sparks/sparks10 臂；如需加 `sparkshot` 热跑臂再改）
- Test artifact: `test/fresh_sparks.mp4`、`test/fresh_sparks10.mp4`（脚本自动拷）
- Doc: `docs/comfyui-h3-configs.md`「当前最快」表加 Spark 行

**Interfaces:**
- Consumes: 在跑批 `b3d6d457d`（sparkf 508 已回；sparks/sparks10 顺序跑，各自新进程）；锚 = Veda sp24 的 349 首发 / 283 热
- Produces: `T_spark`（s/步，speed 档）与 `T_veda = 62` 的比值；判 `sparks2`（Task 2）开不开

- [ ] **Step 1: 等三臂落地并验干净度** —— `cat` 批输出，逐条核 `free@submit ≥8` 且 `status=success`；漂了（>4 步锚 + 编译余量）整条作废重跑
- [ ] **Step 2: 热跑补数** —— 对最好的一条 speed 臂，在同进程再发一条（脚本加 `sparkshot`：同 `sparks` 突变、seed 101、不重启）；`exec_hot` 与 `exec_fresh` 差 = 首编账
- [ ] **Step 3: 差分求 T_spark** —— 用 `exec_hot = F + 4×T`（F 沿用 35 锚）解出 T；若 T ≤ 45 ⇒ 开 Task 2；若 T ≥ 55 ⇒ Spark 记平手、直接走 Task 5 的地板合成
- [ ] **Step 4: 写表 + commit 文档** —— `docs/comfyui-h3-configs.md` 加行「Spark speed：fresh X / hot Y（首编 Z）⇒ T = W vs Veda 62」；`git add docs/ CLAUDE.md && git commit -m "docs(comfyui): 1015 Spark-H3 speed 档归因"`

### Task 2: `sparks2` = Spark speed + 2 步（条件臂）

**Files:**
- Modify: `data/generated/.speed_one.mjs`（`sparks2` 已写：`spark(g,'speed',0.2)` + `g['10'].inputs.steps=2` + `g['3'].inputs.steps=2`，seed 98）
- Test artifact: `test/fresh_sparks2.mp4`（给用户判画质）

**Interfaces:**
- Consumes: Task 1 的 `T_spark`；判据 `F + 2×T_spark ≤ 150`
- Produces: 一条 ≤150 的候选（或证伪）+ 待判画质片

- [ ] **Step 1: 条件开跑** —— `powershell -File _restart_6006_nofd.ps1 && sleep 12 && node .speed_one.mjs sparks2`
- [ ] **Step 2: 判数** —— `exec ≤ 150` 且 free 干净 ⇒ 成立；否则记数进表
- [ ] **Step 3: 交付画质判定** —— 把 `test/fresh_sparks2.mp4` 与 `test/ab3_steps2b.mp4`（Veda 2 步 160 s）并给用户，明确「这两条是 150 内唯二的路，画质你定」

### Task 3: F 侧三臂（teawq / ref1 / ffnchunk）

**Files:**
- Modify: `data/generated/.speed_one.mjs`（`teawq` seed 95、`ref1` seed 96、`ffnchunk` seed 99 已写）
- Doc: `docs/comfyui-h3-configs.md` F 分解段

**Interfaces:**
- Consumes: 锚 349（F≈35 + 4×62 + 首发装载账）；`ref1` 对照 `norefs` 的 −43（两参考全删）⇒ 单参考预期 −20±
- Produces: `ΔF_teawq`、`ΔF_ref1`、`ΔF_ffnchunk`（含 VRAM 峰值观察：跑时 `nvidia-smi --query-gpu=memory.used -l 30` 顺手采）

- [ ] **Step 1: 顺序跑三臂**（各自重启，一条一进程；GPU 被 Task 1/2 占用则排队）
- [ ] **Step 2: 逐条判数**（free 干净 + success + 与 349 差分）；任何 |Δ| < 15 s 记「噪声内、不是杠杆」
- [ ] **Step 3: 写表 + commit** —— 三个 Δ 进 docs；`git commit -m "docs(comfyui): 1015 F 侧三臂结案（awq TE / 单参考 / FFN 分块）"`

### Task 4: 1152×640 同 MP 无 padding 臂（`canvas1152`）

**Files:**
- Modify: `data/generated/.speed_one.mjs`（新增：`g['7'].inputs.width=1152; g['7'].inputs.height=640`，seed 100，前缀 `openai/fresh_canvas1152`）
- Test artifact: `test/fresh_canvas1152.mp4`

**Interfaces:**
- Consumes: Veda README 的 padding 警告（1472×832 下 24% tile 空转；1152×640 latent 整除）+ MATLOWAI 用 1152×640 做 10 s 档
- Produces: 同 0.736 MP 下 T 是否真降（若降 ≥15% ⇒ 进 Task 5 合成，画质等尺寸需用户复判）

- [ ] **Step 1: 加臂 + 开跑**（新进程第一条）
- [ ] **Step 2: 判数** —— 与 283 热锚同口径比（这条也补热跑）；`ΔT/T` vs `ΔMP/MP` 对表，padding 回收成立才写进合成
- [ ] **Step 3: 写表 + commit**

### Task 5: 最优栈合成 + 地板判定

**Files:**
- Doc: `docs/comfyui-h3-configs.md`「当前最快」表重排（新最优行置顶）
- Test artifact: `test/best_stack_10s.mp4`（合成栈一条完整片）

**Interfaces:**
- Consumes: Task 1-4 全部 Δ；规则 = 只叠「实测成立且单变量干净」的项
- Produces: 最终数 `exec_best`；若 ≤150 ⇒ Task 6 进桥；若 >150 ⇒ 写「这台卡（36-SM，100% util 全时钟实证）的 4 步地板 = X s」+ 两条备选（2 步画质待判 / 148-SM 级换卡 = 社区 65 s 那台）进「未结」

- [ ] **Step 1: 组装** —— nvfp4+LoRA × 胜者注意力 × 胜者 F 件 ×（若成立）1152×640；写 `best` 臂进 `.speed_one.mjs`（seed 102）
- [ ] **Step 2: 首发 + 热跑各一条**，都验 free
- [ ] **Step 3: 判目标** —— `exec_hot ≤ 150` ? 进 Task 6 : 落地板报告（含 `sparks2` 若已成立则并列呈「2 步 150 内 + 4 步地板 X」双档）
- [ ] **Step 4: commit docs**

### Task 6: 胜者进桥 + 平台端到端复验

**Files:**
- Modify: `E:/AI/ComfyUI/custom_nodes/ComfyUI-OpenAI-Bridge/__init__.py`（`_wf_video_native` 的注意力节点段：加 env 门控 `HUOBAO_H3_ATTN=veda|spark`，默认保持 `veda`，胜者档参数写死；参考 1015 已写的 `HUOBAO_H3_SPARSITY` 同款写法）
- Modify: `backend/src/services/adapters/comfyui-video.ts`（若胜者含 F 件/画布变化：`DEFAULT_SIZE`、`ref_image_size`、steps 透传）
- Test: `backend/tests/comfyui-bridge.test.mjs`（或桥 selftest 所在断言文件 —— 先 `ls backend/tests | grep -i comfyui` 定位现役那条，加 Spark 臂断言：`HUOBAO_H3_ATTN=spark` 时图里出现 `MiniMaxH3SparkAttentionSM120` 且 Veda 节点缺席）
- Doc: `docs/comfyui-h3-configs.md` 配置表「注意力」行 + CLAUDE.md ④⑤ 收口

**Interfaces:**
- Consumes: Task 5 的 `exec_best` + 胜者参数集
- Produces: provider=`comfyui` 的 `/api/v1/tasks` 一条真实任务（平台口径 created→completed），`params.progress.real:true` 步数照发

- [ ] **Step 1: 改桥**（Python 注释用 `#`，别吞行 —— 1015 踩过 `//` 毒）+ `python -m py_compile` 验
- [ ] **Step 2: 重启 6006，跑后端测试全套**（`npx tsx --test --test-reporter=tap ...`，Expected: 全绿；桥断言失败先修再走）
- [ ] **Step 3: 平台发一条 10s@1024×768**（走 `/api/v1/tasks`，非手搓 —— CLAUDE.md 铁律），记录 created→completed 与 `video_url`
- [ ] **Step 4: 判收** —— 平台口径 ≤150（或最优地板复现）⇒ commit：`git add backend/ docs/ CLAUDE.md && git commit -m "perf(comfyui): 1015 速度栈进桥（<胜者组合>）"`；桥文件在仓库外，改动记一行进 docs 配置表（升级后要重贴 [huobao-1013/1015] 补丁那条照提）

### Task 7: 未结与决策呈报

**Files:**
- Doc: `docs/comfyui-h3-configs.md`「未结」段 + 本会话结论

- [ ] **Step 1: 呈报三件待用户定的**：① 2 步画质（`test/fresh_sparks2.mp4` vs `test/ab3_steps2b.mp4`）② 换卡采购（148-SM 级 = 4 步 150 内自动成立；社区两台同卡级参照互相背书我们的地板）③ 1152×640 若成立 = 目标尺寸要不要改（同 MP、无 padding）
- [ ] **Step 2: 把未授权前不动的项列死**：RTX VSR 进 adapter（`sr_mode`，旧账）、参考绑定 bug（两女同脸）、[huobao-1015] 补丁换权重路径复验、DMAD 4 步（要转 LoRA + re-noise 采样器，Spark 包已带 `comfyui_dmad.py`，下轮再开）

---

## 依赖与并行

Task 1 → Task 2（条件）；Task 3/4 与 1/2 只抢 GPU（串行发车、互不挡判数）；Task 5 等 1-4 全回；Task 6 只在 Task 5 判「进桥」时开；Task 7 随时。在跑批 `b3d6d457d` = Task 1 Step 1 的前半，**不要重启 6006 打断它**。
