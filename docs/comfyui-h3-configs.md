# MiniMax H3（ComfyUI）配置与实测台账

只记**实测过的数**，每条注明形状、后端、口径。没跑通的不写成结论。
CLAUDE.md 里只留一条引用，细节在这。
**每次更新这份文档，同时更新下面「当前最优」——它必须是文档里第一个能读到的东西。**

> **历史已删（1012，用户「删掉历史台账 只留最新的」）**：§一–二十七（1006–1011 的 VOSR2/SeedVR2/fast-disk/`--reserve-vram`/aimdo×Blackwell 四死/#15424 mmap AV 结案等，约 1100 行）不在文件里了；要翻旧账：`git log -- docs/comfyui-h3-configs.md` 取删除前的版本，或看记忆文件（`comfyui-launch-args-video-vs-qwen` / `comfyui-mmap-av-15424-fixed` / `comfyui-blackwell-aimdo-trap` / `vosr2-upscale-8gb-verdict` / `h3-sharpness-route-1mp-5s`）。

## 当前最优（2026-10-13 00:5x）

**生成：1472×832×5s（124 帧）= 原生 MiniMax-H3 节点 + Veda 学习稀疏注意力（1012 用户「除了NVFP4 全部换他的」，已进桥为默认 `graph:"native"`）** —— 内核热、权重在盘缓存时整单 **302 s**（task 323，history 口径 49.4 s/步 ×4 + 解码存盘）；进程首发含 triton 编译/首次冷读 13+32 GB 权重时 **430–510 s**（322=507、321=432、331=449、334=450）。老 JZL+kitchen sol-attn 暖跑 270 s 的账已被这条路取代（JZL 不发 GUI 步数、且用户点名换）。**超分：RTX VSR ×2 → 2944×1664 = 0.68 s/帧（「质量优先」档，比速度档还快 26%）**，243 帧整条 224.4 s ✓ 10 min 内；已知副作用暗 ~1.3%、黑电平压 2 格，两档同幅 ⇒ 不是档位旋钮，要拉回只有交付端 `eq`（未加，等看片定）。**平台进度：真步数已通**（task 328 起 `params.progress = {pct, real:true}`，来源 = 桥旁听 ComfyUI ws 的 `progress_state`）。全链外推：5s 条 ≈ 302+114 ≈ 7 min；10s 条（243 帧，未实测）≈ 600+224 ≈ 13.7 min；**12 s 档（294 帧）已实测整单 682 s**（task 339，无超分）。T8 BlockCache 已判不启用（4 步 turbo 下 0 命中，强制命中损细节，详见排除项）。RTX VSR **还没接进 adapter**（只在探针跑通，没走平台流程）；自启仍停用。

### 配置详情（现役）

| 项 | 值 | 状态 |
|---|---|---|
| 主模型 | `minimax_h3_ref2va_pruned_nvfp4.safetensors`（12.53 GB） | ✓ 桥 `_wf_video_native`（现役默认）/ `_wf_fl2va` 的 `unet_name`；`..._pruned_int8_convrot`（20.97 GB）留作回退 |
| 注意力 | **Veda 学习稀疏**（`custom_nodes/Veda-on-ComfyUI` + `models/veda/minimax_h3_r2va_veda_preview_fp8.safetensors` 275 MB）；`generated_sparsity=32 / reference_sparsity=32`，full_attention 两栏空 | ✓ 42.9–49.4 s/步（剔编译）vs dense 94.1 vs JZL+kitchen 60.16；每内核自测「never silently off」；**别再叠 ComfyUI 自己的 Model Sparse Attention** |
| 文本编码器 | `qwen3vl_32b_heretic_minimax_h3_nvfp4.safetensors`（15.68 GB，无审查） | ✓ |
| 视频 / 音频 VAE | `minimax_h3_video_vae_fp16`（5.21 GB）/ `minimax_h3_audio_vae_fp32`（0.61 GB） | ✓ |
| LoRA | `minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16`（1.96 GB） | ✓ |
| 采样 | 4 步 / `res_multistep`+`simple` / cfg 1.0（`BasicGuider`+`SamplerCustomAdvanced`）/ 画布 1472×832（`episodes.4.resolution='720p'` = adapter `DEFAULT_SIZE`）；帧数默认 243（10 s）、5 s = 124；`ref_image_size:"match"` | ✓ 内核热整单 302 s（task 323）；`BlockSparseAttention`(sol-attn) 那条随 JZL 路径退出现役（回退 = body `graph:"jzl"`） |
| 超分 | **RTX VSR**（`custom_nodes/BSAI-H3-upscale-4K` 的 `NVIDIA RTX Video Super Res` 引擎 + `nvidia-vfx`，硬件 NVENC）×2；`auto_prefer` 速度优先、`softness=0`（本地补丁才关得掉） | ✓ 243 帧 224.4 s；产物 `E:/AI/ComfyUI/output/sr10s_rtx_00001_.mp4`（2944×1664/243/18.3 MB）。**adapter 未接**（`sr_mode` 待落）。判死对照：VOSR2 5.7、TE-Speed 24.83、SeedVR2 ≥46、latent ×2 只加像素（703 s/124f 冷、脸软） |
| 段间接力 | 上一段 latent 尾窗 22 帧直传（`BridgeSeamGuideFromLatent`，零 VAE 往返）；**硬前提 = 同画布**（跨画布必须 `chain:false`）；chained 段落盘裁窗口 | ✓ 接缝 3.58（段内运动 3.43）—— **只在 JZL 路径成立；native 路径还没接法（`guide/prev_latent/save_name` 在原生图里无对应节点），换桥期间接力降级为「不接」**，移植单独验 |
| 实例 / 启动参数 | ComfyUI **v0.39.2**（最新正式版；master 只多 frontend 1.55 / aimdo 0.5.6 / cryptography，#15438 未合、本地补丁照打）+ `.venv-cu130`（torch 2.14.1+cu130）on **5060 Ti**（UUID 钉卡）+ `--disable-dynamic-vram --disable-comfy-compiler --disable-mmap`；`comfy-kitchen==0.2.37`、`nvidia-vfx` 0.2.0.0；`--fast autotune`/TF32 已回退（无收益，autotune 冷跑罚 ~10 min） | ✓ 进程命令行实证；重启工具 `_restart_6006_nofd.ps1` |
| 图片生成 | 平台默认 = **qwen-image-2.1**（`ai_service_configs` id 4）；krea2 那条配置（id 2）**1013 已删**（用户「kera2 模型删掉」，走 UI DELETE `/api/v1/ai-configs/2`；盘上的 krea2 权重文件没动，要恢复重建配置即可） | ✓ |
| 自启 | `Start-ComfyUIHidden.ps1` 参数已同步，但 `Startup/Krea2-ComfyUI.vbs` → `.off1011` **停用中**（等用户说调试完） | — |

**排除项（都实测过）：** T8 BlockCache（4 步 turbo 相邻步 diff 0.36/0.75/0.50，是作者默认阈值 0.12 的 3–6 倍 ⇒ 默认 0 命中、682 vs 682 s、画面与不开节点**逐像素相同**；强提阈值 0.55 命中 1/4、省 130 s（541 vs 682 s），但脸/手/纱面**肉眼可见发糊**——一步精修真的被跳过。作者自测 20 步也才 1.09×，且他自述质量矩阵未做完）· TeaCache（质量掉）· GGUF Q2_K（慢 27% + 发黑）· FBC（与分块互斥）· sage block swap（本机 sage 缺属性）· 加步数（16 步 ≈ 4 步）· `--reserve-vram` 压低（反向 8.8×）· `--fast-disk`（影响不稳定、已摘）· `--enable-dynamic-vram`（Blackwell 上 aimdo 四死，等上游修）· TE-Speed-VOSR2（本机比原包还慢，WDDM spill）· SeedVR2 / VOSR2 1.4B（慢 27×/6× 于 RTX VSR，让位）· MiniMax-H3-Max（只有云 API、无 2K，用户「不要云的」出局）· DLSS-NR 游戏注入（`nr_native_fallback`，与 BSAI 的 DLSS5 硬件路是两回事）。

**时间账（现役 5s 条暖跑 270 s 的分解）：** 4 步 × 60.16 s = 240.6 s + 解码/存盘 ≈ 29 s。超分段另计：243 帧 224.4 s（≈0.92 s/帧，124 帧外推 ≈114 s）。

## 上一轮实测（2026-10-12 白天）

- **ComfyUI 0.39.2 + NVFP4 进生产**：路由证据 = state_dict 每层 `comfy_quant` JSON → `comfy/ops.py:1195` pop → kitchen module；`supports_nvfp4_compute` 要 `props.major>=10`（sm_120 = major 12 ✓）；0.37 没有 nvfp4 algo 表 → `manual cast: torch.bfloat16`（逐层 eager 反量化 = 老「≥13 min/步判死」那个病，同 GGUF 病 `ops.py:177`）。**「不要看之前的结论」这条被用户点名，重测成立。** fl2va 首帧条同形状 91 s。
- **kitchen 0.2.35→0.2.37 的真根因**：报错 `group_norm_silu_pad3d() got an unexpected keyword argument 'zero_pad'` 的调用方不是 BSAI，是**核心 `comfy/ldm/seedvr/vae.py:761`**（`zero_pad=True, out=dst`）；官方 `requirements.txt:24` 本来就钉 0.2.37。win 轮子 `cp312-abi3-win_amd64`（abi3 覆盖 py3.13）、基础依赖不钉 torch ⇒ 升级没动 torch（冻结规则守住）。
- **loader 校验放宽**（`comfy/utils.py` 本地 PR#15438 补丁内）：「精确覆盖/严格 contiguity」误拒 nvfp4 pruned（fp4-block padding 留 gap + 尾部余量，`safe_open` 本来就容忍）⇒ 改成「**重叠或越界才抛**」。症状指纹：报 `Invalid safetensors header` 而文件完好。
- **BSAI-H3-upscale-4K 接入三坑**：① 36 个必填键是**中英双语串**（`images / 图像`），从 `/object_info` 逐字取（`v.input[0]` = required 表）；② RTX VSR 引擎要 `pip install nvidia-vfx`（没装 = 日志「RTX 超分不可用…降级到 SeedVR2」）；③ 收尾 `_soften_gpu`（`bsai_h3_upscale_4k.py:3088`）在 2K 全幅撞 torch 2.14 `CUDAMallocAsyncAllocator.cpp:595` 断言（driver 侧 NVENC 占的显存不进 torch 记账），作者兜底只接 `OutOfMemoryError` ⇒ 本地两行补丁：`:3089` except 补 `RuntimeError`、`:2586` `max(softness,0.15)` 改成 **0=显式关**（默认 0.1 仍吃下限；UHD 保守档会把 0 抬回 0.15，CPU soften 243 帧 @2K 会破 10 min 预算所以选跳掉）。`bsai_orch_client` 缺失 = BSAI 云端编排注册失败，不影响本地引擎。
- **暗色副作用量化**：五帧（t=1/3/5/7/9）YAVG 一致 −1.2~1.3%（69.4→68.5 等），YMIN 10→8、YLOW 18→17、YMAX 不变 ⇒ 黑电平压 + 对比度推，不是编码 bug。**「质量优先」档对照结果（`a3ff5ec8`，24 帧）：16.25 s = 0.68 s/帧（比速度档还快 26%）但 YAVG 81.57→80.51 = −1.3%、YMIN 不变** ⇒ **暗不是档位旋钮能修的（两档同幅），是 RTX VSR 处理本身**；选档按「质量优先」（更快）。要拉回来只有交付端 `eq`（`ffmpeg-merge` 一行，未加，等用户看片定）。
- **latent ×2 实验**：`BSAI_SolH3_LatentUpscaleAlign`（解 NestedTensor `[0]=video[B,24,T,H,W]/[1]=audio`，audio 锁 `add_noise:False, audio_denoise:0`）2944×1664/124f 冷 703 s；LBH 版在 0.39 炸 `'NestedTensor' object has no attribute 'dim'`。脸软 = latent 只加像素。
- **社区快超分地图**：BSAI 引擎表（Real-ESRGAN / FlashVSR / SeedVR2 fp8+INT8 / RTX VSR / DLSS5 / VOSR2+DLSS 串联 / latent3D；作者称 DLSS5 = 最快 4K 路，本机未验）· NanoVSR（ECCV 2026，644k–2.2M 纯卷积，Orin NX 27.2 FPS @4×，无 ComfyUI 包装）· PS-SR（CVPR 2026 单步 speculative，Linux only）· ComfyUI-NVIDIA-RTX-VSR-Pro / DLSS5 套件（硬件路）。Spark-H3（SM120 内核 1.42–1.87×）前提已满足（0.38/0.39 ✓）但生成侧已进 5 min ⇒ 降优先级。

## 最新实测（2026-10-12 深夜 → 1013）

- **生成路径换桥完成（用户「除了NVFP4 全部换他的」）**：桥 `_wf_video_native` = 他的 `tools/e2e_minimax_h3.py` 同款接线（UNETLoader nvfp4 → Turbo LoRA → `VedaSparseAttention` → `BasicGuider`/`BasicScheduler(simple)`/`KSamplerSelect(res_multistep)`/`SamplerCustomAdvanced` → `VAEDecode`+`VAEDecodeAudio` → `CreateVideo(24fps)`/`SaveVideo`），权重仍我们的 nvfp4；`graph:"jzl"` = 回退老路径；桥 selftest 过（`ref=18 nodes`、native 断言含点号 ref 键、dense 臂无 Veda 节点）。**JZL 退出默认**（它不发 GUI 步数，用户「comfyui 看不到进度」的根因之一）。
- **整单账（124 帧 @1472×832，平台 created→completed，含提交/轮询/下载回 static）**：323 = **302 s**（内核热、盘缓存热）· 321 = 432 s · 331 = 449 s · 334 = 450 s · 322 = 507 s（重启后首次，13+32 GB 权重走 `--disable-mmap` 的 plain read）。步速 42.9–49.4 s/it（剔编译）vs dense 94.1（他 e2e 报 290.7 s 是剔装载口径，我们同口径 ≈302 ✓ 复现）。
- **Veda 自己的分辨率警告（`.err` 原文）**：1472×832×124 = **24% 的 tile 是算了的空 padding**；它建议 **1536×1024×124**（latent 64×96×40、token 32×48×40，整除、浪费 12%→0）—— 下一档探针该画布跑一次对照。
- **平台真进度结案（三个连环根因，全部源码指认）**：① 0.39 的事件类型改名 `progress_state`（`comfy_execution/progress.py:185`，载荷 `{prompt_id, nodes:{id:{value,max,state}}}`，每整步一发）；② 事件**只发给提交那个 sid**、不广播（`execution.py:683-684` + `:735-736` 从 `extra_data["client_id"]` 取，`server.py:1124-1127` 把顶层 `client_id` 映射进 extra_data）；③ **`/ws` 的查询参数是驼峰 `clientId`**（`server.py:275`）—— 写 `?client_id=` 会被当空、sid 变随机 uuid（`status` 消息里的 `sid` 字段就是证据），定向事件永远收不到，且**不报错**。旁听还须过滤 `NodeState == "running"`（`progress.py:17-20` 是 pending/running/finished/error，不是 "active"）。验证：task 328/331/334 的 `params.progress` 带 `real:true` 且 pct 随步走（25→50→75）。
- **`<Picture N>` 绑定（这条最坑）**：`MiniMaxH3ReferenceToVideo` 自述「`<Picture i>` / `<Video k>` / `<Audio j>` reference conditioning… **Use the same tags when prompting**」—— 提示词里没有 `<Picture 1>`/`<Picture 2>` 标签时，**两张参考只有一张被认**，另一个角色变成随机人（实测 331/332：右位女生出来的是波波头，和参考的过肩波浪完全不符；补标签后 334 两个都对）。平台 SKILL.md 86-88 行本来就是这个骨架 ⇒ 真实剧集不受影响；锅在我手搓探针没走 SKILL。
- **衣服/姿态**：参考表是正面着装角色表 → ref2v 的 VAE 条件连姿态一起带（两人反复「各自朝镜头」，胸贴胸写不进画面）；衣服是**种子方差**不是参考锁死（321 保白吊带、331/334 裸上身）。要姿态锁死得给**目标姿态的参考图**，原生节点没有条件强度旋钮（`object_info` 的 required/optional 里只有 `ref_image_size`，JZL 的 `ref_scale=2.0` 换过来就没了）。
- **krea2 配置已删**（用户口令，走 UI `DELETE /api/v1/ai-configs/2`）；图片侧只剩 qwen-image-2.1（id 4）。
- **294 帧（duration 12，1472×832）整单 682 s**（task 339，平台 created→completed；4 步 ≈133.4 s/步 + 解码/存盘；产物 12.25 s / 8.8 MB）。243 帧（10 s 档）外推档由此背书。
- **T8 BlockCache A/B 结案（1013 上午，同 seed 1811053577 三连跑）**：task 341（阈值 0.12，作者默认）= 调色板级旁路，0 命中、**682 s 对 682 s**、与 339 **SSIM 1.000 全平面逐像素相同**（md5 差 243 B 纯容器噪声）；task 342（阈值 0.55 强制命中）= **命中 1/4（step3，3 s vs 全步 134 s）、Prompt executed 535.2 s、墙钟 541 s（−141 s ≈ 1.26×）**，但画质对照放大后明确掉：手指并拢、下巴轮廓融、纱面雾化（SSIM All 0.795 / PSNR-Y 20.3 dB），音频无恙（−11.0 vs −10.8 LUFS）。根因结构性：4 步 turbo 每步 sigma 大步长，相邻步残差 0.36–0.75 ≫ 0.12。判定**生产不启用**（节点留装、桥 env 门控默认关、脚本行已注释）。
- **6006 操作坑（1013）**：`/interrupt` 停任务后不重启就发新单必 CPU OOM（python commit 42 G、剩 0.74 G）；TE 加载失败路径 `detach→unpatch_model` 的整模型 `.to()` walk 打 AV（上游 #14142/#15397/#15635 全 open）已打本地 `[huobao-1013]` 补丁，**升级 ComfyUI 后要重贴**。

## 未结

① `sr_mode=rtx` 进 `comfyui-video.ts` adapter（生成后自动 ×2、质量优先档）+ 端到端 `/api/v1/tasks` 复验一条；② 10 秒条（243 帧）native+Veda 暖跑数（外推 ≈600 s，没实测）；③ **1536×1024×124 对照臂**（Veda 自己建议、消 24% padding）；④ native 路径的段间 latent 直传接法（`guide/prev_latent/save_name` 三键在原生图还没有对应节点，现在接力=不接）；⑤ 暗色交付端 `eq` 等用户看片定；⑥ 桥里 `[bridge-ws]` 两行临时诊断日志（`__init__.py:628/651`）下次重启前删；⑦ 自启 vbs 等用户口令恢复；⑧ 全部改动未 commit（backend/frontend/docs + 桥/Veda/BSAI/comfy utils 在仓库外）。
