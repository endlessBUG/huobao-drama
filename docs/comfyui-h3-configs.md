# MiniMax H3（ComfyUI）配置与实测台账

只记**实测过的数**，每条注明是哪个形状、哪个后端、哪个实例。没跑通的不写成结论。
CLAUDE.md 里只留一条引用，细节在这。
**每次更新这份文档，同时更新下面「当前最优」——它必须是文档里第一个能读到的东西。**

## 当前最优（2026-10-05 21:11）

### 配置详情

| 项 | 值 | 本机状态 |
|---|---|---|
| 主模型 | `minimax_h3_fl2va_pruned_int8_convrot.safetensors`（20.97 GB） | ✓ |
| 文本编码器 | `qwen3vl_32b_minimax_h3_int8_convrot.safetensors`（**27.14 GB**，作者用的这个） | ✓ 已补全（sha256 与 LFS oid 一致）；但 27 GB 编码器 + 21 GB 模型 > 31.8 GB 内存，**实测仍用 `nvfp4_awq`（15.69 GB）** |
| 视频 VAE | `minimax_h3_video_vae_fp16.safetensors`（5.21 GB） | ✓ 有；**单变量实测：换 fp16 后整单 9.0 min（int8 是 10.0 min），眼区/眉线定义略好，不是跃迁** |
| 音频 VAE | `minimax_h3_audio_vae_fp32.safetensors`（0.61 GB） | ✓ |
| LoRA | `minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16.safetensors`（1.96 GB） | ✓；作者的 `..._resized_avg_rank_20_bf16` **官方仓库没有**（作者自己重定量的，只在整合包/网盘），下不了 |
| 采样 | **4 步 / SelfLift 到 1.22 MP（1472×832）/ 243 帧（10 s）**，`res_multistep` + `simple`，cfg 1.0，`transition_step=3`、`lowres_scale=0.5`、`highres_tiling=true`；**TeaCache 不用**（见七） | — |
| 超分 | **没有像素超分后处理**（`UPSCALE = 0`，不挂 FlashVSR）。但 SelfLift 本身含一步 **latent 升采样**（`minimax_h3_latent_upscaler_3d_conv_v1_bf16`，实测 10.9 s）—— 它只把低分 latent 对上目标尺寸，不添新细节；添细节的是最后那一步在目标分辨率上的**真前向**。所以准确说法是「细节是扩散算出来的，不是增强网络补的」。唯一例外：首帧路径（fl2va，有 `firstFrameFile`）仍 `upscale: 2` | — |
| 帧数 | 243（硬约束，不动） | — |
| 段间接力 | **上一段 latent 的尾部窗口直传**（桥的 `BridgeSeamGuideFromLatent`，窗口 22 帧 = 7 token）—— 零 VAE 往返，窗口帧与上一段末 22 帧逐像素相同；落盘前只裁窗口 22 ⇒ chained 段落盘 272（11.33 s），不是 294。跨场景不接，同场景 `cut` 只追光照色调不追机位 | ✓ task 153/154 实测：接缝 3.58（段内运动 3.43）；文件不在时回退 pixel 路径 |
| 实例 / 启动参数 | **6006 = cu130 venv**（`.venv-cu130`，torch 2.14.1+cu130）+ `--enable-dynamic-vram --fast-disk --disable-comfy-compiler`；**不开 `--enable-triton-backend`**（triton 是 opt-in override，会把 `int8_linear` 从 CUDA 后端抢走） | ✓ 已写进 `start_clean.ps1`；cu130 的价值就是 `quant_ops.py:26-27` 那个门开了（见九） |
| sage block swap | 作者自己也是**关闭**（1141 里 `["关闭", 50]`） | — |

**排除项（都实测过，理由在对应小节）：** TeaCache（质量掉，七）· FlashVSR（1 MP 上 8.7 min 且 SelfLift 更好，四）· GGUF Q2_K（慢 27% + 画面发黑，五）· FBC（和 SelfLift 分块互斥 ⇒ 1 MP 上 0% 命中，十）· sage block swap（本机 sage 1.0.6 缺六个属性，跑不了，五）· 加步数（16 步与 4 步清晰度差不多，四）。

**时间账（这条方案的实测分解）：** 低分 3 步 192.8 s + transition 12.3 s（其中 paired_lifts 10.9 s）+ 高分 1 步 8 块 308.9 s = **采样 514 s**；加装载约 100 s、解码约 125 s ⇒ 冷跑整单 **约 34 min/条**。

| 段 | 时间 | 占比 |
|---|---|---|
| 高分段 1 步（8 块） | **308.9 s** | 41% |
| 低分 3 步 | 192.8 s（64.3 s/步） | 26% |
| 文本编码 + VAE/音频解码 + 存盘 | ~126 s | 17% |
| 模型装载（冷跑才有） | ~104 s | 14% |
| transition（latent 升采样） | 12.3 s | 2% |

**慢的主要不是注意力，是每步要把 20.97 GB 权重从盘上流一遍** —— 模型不常驻（`6663.86 MB offloaded`，8 GB 装不下 21 GB）。64.3 s/步 ÷ 20.97 GB ≈ **326 MB/s** 的实际流送率。

**分块不省单位成本，只压峰值缓冲** —— 两段的 s/千 token 几乎一样：低分段 86,112 token/步 = **0.747**，高分段每块 59,904 token = **0.644**。而线性层按覆盖率**多付 39%**（8 块 × 16 latent 列 = 128 > 需要的 92，overlap）。所以高分段干的是 8 块的活，不是 1 张图的活。

参照：作者 4090 上 0.155 s/千 token，我们 0.64–0.75 ⇒ 差 4–5 倍，就是带宽（1008 vs 224 GB/s）加常驻与否。唯一实测有效的速度杠杆是 FBC（1.65×），但它和 SelfLift 分块互斥（`fbc_patch.py:190-195` 的判定按块触发 ⇒ 分块路径 0% 命中）⇒ **1.22 MP 这条没有已测的速度可省**。

**批内实测（2026-10-05 第一集重跑，缓存全热）：7.4 min/条**（sb1，03:45:43 提交 → 03:53:08 完成）。34 min 是**冷跑第一条**的数（含装载约 100 s + 编码）；模型和编码器常驻后，同一条的采样 514 s + 解码 125 s 就是全部。⇒ 排期按 **7–12 min/条** 计，别按 34 min。

### 实测整单

- **7.3 分钟**（864×480 / 4 步 / 不分块 / fp16 VAE / 4 步 LoRA，**cu130 venv + CUDA backend**）← 480p 档的速度最好（同图比 cu124 的 9.0 min 快 19%），清晰度不如上面的 1.22 MP 档
- **19.0 分钟**（1152×640 / 4 步 / 不分块，cu130）← 第一次在 8G 上不分块超过 864×480；cu124 上这条 104 秒就 OOM
- **14.3 分钟 / 1344×768（原生 1 MP）/ 124 帧（5 秒）** ← **用户 2026-10-04 看片判定「不错」，清晰度这条定案**。前提：帧数从 243 放开到 124（`align_frame_count` `n%17==5`、`video_latent_t(124)=37`），所以每个镜头时长要按 5 秒重新切分。墙是 **token 数不是画布本身** —— 同一画布在 243 帧是 12.6 分钟 OOM。作者那个参照本来就是 1344×768×124 帧。

用户 2026-10-04 看片后判定：加缓存这条「效果越来越差」⇒ **TeaCache 整条划掉，回 4 步 + LoRA**。缓存省的是前向次数，代价是轨迹保真 —— 在「清晰度低」是主问题的前提下，用保真换时间是反向交易。
- 10.0 分钟（同上但 int8 convrot VAE）
- **35.3 分钟**（16 步无 LoRA，`--fast-disk`）—— 清晰度与 4 步差不多 ⇒ 步数不是杠杆
- **15.9 分钟**（20 步无 LoRA + **TeaCache** thresh 0.15 / start 2 / end -2，同基线同 VAE）← 相对 35.3 min 是 **2.2 倍**，但**质量更差（用户 2026-10-04 看片判定）⇒ 不进生产**，只能当草稿/预览档
- **22.3 分钟**（同上，但 TeaCache 改成按流分开 + 补增量修正，`real=12 reuse=8`）—— 慢回来的 6.4 分钟是买判据正确的钱；质量等看片
- 叠 **FlashVSR 2×** 只多 **13 秒**，单变量对照确认是真加细节 ⇒ 要清晰度就加，代价几乎为零
- **12.4 min（暖缓存）/ SelfLift 1.22 MP（1472×832）/ 243 帧** ← **当前最优**（用户 2026-10-05 看片判「这次不错」，已提进 adapter 的 `DEFAULT_SIZE`）。等原始像素裁脸：比 1.03 MP 有结构（眼窝和上眼睑线、鼻梁、发丝成根、下颌线），虹膜仍没有 ⇒ **画布继续是杠杆**。冷跑要加约 100 s 装载，同口径的采样账是 514 s vs 1 MP 的 409 s（+25.7%）⇒ 生产按 **约 34 min/条** 计（1 MP 冷跑 32.4 min + 105 s 采样差）。
- **GGUF Q2_K（6.68 GB）不加速：102.2 s/步 / 9.0 min**，比 int8 臂的 80.2 s/步 / 7.3 min 慢 27%（2026-10-05 实测，见五）⇒ 量化搬运这条**不进生产**，原因是每步都要反量化成 bf16（`ops.py:177`），且文件照样被 offload 不常驻。**同形状同 prompt 的画面对照也输**：Q2_K 臂 YAVG 64.9 / YMAX 142.9 / SAT 3.6 vs int8 臂 102.2 / 235.3 / 10.3 —— 用户看片判「画面都黑的」，量化把高光压没了。

### 为什么比作者的「100 多秒」慢 9.5 倍

不是图的问题，是 torch 版本：`comfy/quant_ops.py:26-27` —— `if cuda_version < (13): ck.registry.disable("cuda")`。本机 cu124 → int8 算子走模拟路径。作者 1344×768×124 帧（161k token/步）4 步 100 多秒 = **0.155 s/千 token**；我们 69120 token/步、102 s/步 = **1.47 s/千 token**。差 9.5 倍。唯一拿回这条路的是单独装一个 cu130 的 venv（不动冻结环境）。

### 判「慢」的第一件事

看进程 RSS 是不是 ≈21 GB（模型常驻）。不是就是换页，每步从 ~100s 跳到 180–190s。

## 一、形状 × 后端 × 速度

| # | 形状 | 后端 | 每步 | 整单 | 结论 |
|---|---|---|---|---|---|
| 1 | 864×480 / 4 步 / **不分块**单采 | triton | **101.8s**（首步含 setup 155.6s） | **10.0 min** | 目前速度最好、可跑 |
| 2 | 864×480 / 4 步 / 不分块单采 | triton（腾 3.5 GB 内存后） | 104.2s | **10.3 min** | 腾内存**不改变**每步时间 → 瓶颈不是内存 |
| 3 | 864×480 / 4 步 / 不分块单采 | **eager** | 15 分钟没跑完第一步 | — | 不可用 |
| 4 | 1152×640 / 4 步 / **分块**（8 块） | eager | **43.7s** | **148–269s** | 「以前 150s」的来源：分块 + 模型常驻 |
| 5 | 864×480 / SelfLift t=3（3 步低分 + 1 步高分分块） | eager | 低分 40s、高分段 269.7s/4 步 | **9.3 min** | 生产现用 |
| 6 | 864×480 / SelfLift t=1（1 步低分 + 3 步高分分块） | triton | 低分 51.4s、高分 **166s** | **12.3 min** | 比 #1 慢 → 分块在这里是净亏 |
| 7 | 1344×768 / 4 步 / 不分块 | triton | — | **OOM** | 8G 装不下，见下节 |
| 8 | 864×480 / **8 步** / 不分块单采 | triton | 101.7s | **15.3 min** | 无重复，但**不如 4 步** → 单采定 4 步 |
| 9 | 864×480 / 4 步 / 不分块单采 **+ FlashVSR 2×**（→1728×960） | triton | 68.6s（缓存热） | **10.0 min**（超分段只 13s，29 块 2.39 it/s） | **清晰度这条目前唯一有效** |
| 10 | 864×480 / **16 步 / 无 LoRA** / 不分块 | triton | 180–192s（模型没常驻，换页 12 MB/s）；`--fast-disk` 下 96–126s | **55.0 min** → fast-disk **35.3 min** | 无重复；**清晰度与 4 步差不多** ⇒ 官方那句成立 |
| 11 | 864×480 / 4 步 / 不分块 / **fp16 VAE** | triton + fast-disk | 102.3s | **9.0 min** | 眼区/眉线定义略好于 int8 VAE，不是跃迁 |

**分块的账**：分块只在注意力上省（8 块 × 10823² vs 1 × 69120² ≈ 少 5 倍），但线性层工作量按覆盖率**多 1.39 倍**（overlap=1；overlap=4 时是 2.56 倍），再加每块 setup。这个模型的瓶颈是**权重带宽不是注意力**，所以分块是「装得下」的代价，不是「跑得快」的代价。

## 二、后端开关（这是速度的真开关）

- `comfy/quant_ops.py:26-27`：`if cuda_version < (13): ck.registry.disable("cuda")`。本机 torch 2.6.0+**cu124** → comfy_kitchen 的 CUDA 后端启动时被整个关掉，`int8_linear`、`rms_rope_split_half_` 全部回落到 **eager（Python）路径**。
- `comfy/cli_args.py:119`：`--enable-triton-backend` **默认关闭**。triton 能力表（28 项）里有 `int8_linear` 和 `rms_rope_split_half_`，所以开它能把这两个算子从 Python 路径挪到 triton kernel。已写进 `E:\AI\ComfyUI\start_clean.ps1`。
- **判后端有没有生效必须走 comfy 的导入链**：单独 `import comfy_kitchen; registry.is_available('cuda')` 会返回 True（disable 发生在 `comfy.quant_ops` 被 import 时），会误报。
- triton 首次遇到新形状要扫 6 个 config × 每个不同 (m,n,k)（`comfy_kitchen/backends/triton/quantization.py:861`），~50 层 → 300 次编译+基准，**每个实例每个形状一次性**，量级 10 分钟。磁盘缓存 `~/.triton/cache`（实测 512 项）命中后就不付这个钱。

## 三、内存与盘

- 权重合计 **42.04 GB**：主模型 20.97 + 编码器 15.69 + 视频 VAE 2.81 + 音频 VAE 0.61 + LoRA 1.96。物理内存 **31.82 GB**。所以「全部常驻」不可能。
- 快实例的特征：进程 RSS ≈ 21.5 GB（= 主模型常驻，编码器编码后被释放）。慢实例：RSS 11.98–17.35 GB 且往下掉 → 走 `comfy_aimdo/host_buffer.py:108 read_file_slice`，在前向过程中按模块现读。
- 盘不是瓶颈：E: 是 NVMe，顺序读实测 **1.82 GB/s**；进程实际读 **4–10 MB/s**（小块随机读 + 被换页）。
- `--disable-comfy-compiler`（`cli_args.py:185`）**不改变**加载路径，仍走 aimdo host buffer。
- 关无关应用实测腾 **3.51 GB**（free 3.57 → 5.67），对每步时间无影响。

**`--fast-disk`（`cli_args.py:182`）是 Strata 那个机制的 ComfyUI 版** —— 不跟 OS 抢 RAM，直接按 NVMe 流式读。`comfy/storage.py:104-110`：显式传 `--fast-disk` 就覆盖自动判定；不传时走 `comfy_aimdo.storage.fast_disk(path)` 自动判，本机判成 **False**（虽然实测顺序读 1.82 GB/s，是快盘）。

实测对照（同一个 B 单：16 步 / 864×480 / 无 LoRA / triton）：

| 路径 | 进程读速率 | RSS | 整单 |
|---|---|---|---|
| 默认（fast_disk=False，靠 RAM 常驻） | **12.2 MB/s**（换页） | 8–11 GB | **55.0 min**（每步 180–192s） |
| `--fast-disk` | **205.6 MB/s** | 19.9 GB | 跑中 |

⇒ 17 倍读速率差。这条不改变每步的算子成本（还是 triton/eager 的 int8 路径），但把「模型装不进 RAM 就换页」这条惩罚消掉了。已写进 `start_clean.ps1`。

**同一个形状（4 步 / 864×480 / 不分块 / triton）的三种缓存状态，实测：**

| 状态 | init | 每步 | 整单 |
|---|---|---|---|
| 模型常驻（热） | 2:37 | 101.8s | **10.0 min** |
| 刚重启、模型常驻但首步残余缺页 | 3:38 | 首步 218.9s，之后 105.0s | **11.3 min** |
| 冷缓存（模型无法常驻，RSS 12–13 GB） | 8:07 | 488 / 459 / 349 / 348s | **29.0 min** |

⇒ 稳态是 10–11 分钟；冷缓存要多付 ~18 分钟。判「慢」先问模型在不在内存里（看进程 RSS 是不是 ≈21 GB）。
offload 三条都在跑：`Using async weight offloading with 2 streams`、两个 VAE `offload device: cpu`、编码器 `offload device: cpu, current: cpu`。文本编码器已经 offload 到内存 —— RAM 是最低层，没有更下面可去。JZL 的 `decode_cleanup = "卸载显存模型"`（`nodes_asset_manager.py:358`，执行在 `:1090`/`:3245`）会调 `unload_all_models()`，但那是 JZL 自己解码节点的设置字典，不是 prompt API 的节点输入，我们图用原生 `VAEDecode` 所以不触发。

## 四、清晰度

- 当前结论：**速度可以，清晰度低**。480p 下虹膜画不出来 —— 眼睛是暗窝加暗瞳。
- #1（4 步全在目标分辨率）与 #5（1 步在目标分辨率）在**同脸尺寸**下对比（各 ~70–78 px，同倍率裁块）：没有实质差别，两条都读不出虹膜。所以「把步数全放在目标分辨率」不是清晰度的解。
- 判清晰度必须**等原始像素** —— 两臂取景不同（特写 vs 中景），大脸天然多像素，同显示倍率会骗人。
- 余弦判据（storyboards.id=19，243 帧，同 prompt/refs/seed，ArcFace）：SelfLift 臂 F2 0.395 vs 超分臂 0.174，特写右脸 0.542 > ref_a↔ref_b 基线 0.488。赢在「像」不在「清」。
- 单采臂四格抽查**没有人物重复**（每格一个人）。4 步单采和 8 步单采都没有重复，**4 步更优**（观感更好且快 5.3 分钟）→ 单采这条定 4 步。
- **单变量对照（同 prompt / 同 refs / 同 seed 777，只多一段 FlashVSR）**：直出 864×480 与超分后 1728×960 是同一个生成，构图一致。同一块脸上，超分臂多出皮肤纹理、发丝边缘、衣领刺绣花纹 —— 是**真加细节**不是单纯锐化。代价只有 13 秒。⇒ 清晰度目前唯一有效的杠杆就是单采 + FlashVSR 2×。
- **16 步无 LoRA 的清晰度与 4 步差不多**（用户 2026-10-04 看片判定）。这直接印证官方那句 "Steps do not add sharpness the native canvas cannot resolve" —— 在 0.415 MP 画布上加步数不解决清晰度。所以「加步数」这条从候选里划掉。


**画布单变量对照（2026-10-04，同一个镜头1 = storyboards.id 7，同 prompt / 同 refs / 同 seed 788，只改画布，都在 cu130 实例上）：** 同一显示倍率下裁脸 ——

- 864×480（0.415 MP）：脸是一坨，五官位置可辨但无结构（眼=暗块，无眼白/虹膜/眼睑线）。
- 1152×640（0.74 MP）：同一张脸有结构 —— 眼白和上眼睑线在、鼻梁和嘴分得开、发丝成根。

⇒ **画布是有效杠杆**，官方那句「soft frame is a resolution problem first」在这台机器上被证实。用户 2026-10-04 看整片说「还是挺模糊」，那是**取景**问题（正常观看尺寸下脸只占几十像素），不是模型问题。剩下的差距是 0.74 MP 仍低于原生 ~1 MP，而 1 MP 在 8G 上不分块装不下。


**镜头1（storyboards.id=7，同 prompt / 同 refs / 同 seed 790，cu130 实例）—— 画布 × 时长 × 整单：**

| 路线 | 画布 | 时长 | 整单 |
|---|---|---|---|
| 直出 | 0.415 MP (864×480) | 10 s | **7.3 min** |
| 直出 | 0.74 MP (1152×640) | 10 s | **19.0 min** |
| 直出 | 1.03 MP (1344×768) | 5 s (124 帧) | **14.3 min** ← 用户判「不错」 |
| 直出 + FlashVSR 2× (→2688×1536) | 1.03 MP | 5 s | **23.0 min**（超分段 +8.7 min，24 块 × ~12 s） |
| SelfLift（lift + 分块） | 1.03 MP | 10 s | **32.4 min**（低分 3 步 156.2 s + 高分 1 步 7 块 252.9 s） |
| SelfLift（lift + 分块） | **1.22 MP (1472×832)** | 10 s | **12.4 min（暖缓存）** ← 2026-10-05 试跑；采样账：低分 3 步 192.8 s + transition 12.3 s + 高分 1 步 8 块 308.9 s = **514 s**（比 1 MP 那条的 409 s 多 25.7%，正好是 token 多 22% 的量） |

**840p 这条为什么能跑：** `adapt_canvas` 的 1 MP 上限（`MAX_PIXELS = 768*1344`）**只作用在参考视频**（`nodes.py:165`），输出画布不封顶 —— `execute` 直接用 width/height 算 latent（`nodes.py:136`）。所以 1472×832（1.22 MP）照跑，分块 8 块（`estimate_fits=False` 但实际跑通了）。

**单变量画面对照（同 prompt / 同 refs / 同 seed 792，只改画布，等原始像素裁脸）：** 1.22 MP 比 1.03 MP 有结构 —— 眼窝和上眼睑线在、鼻梁和嘴分得开、发丝成根、下颌线清楚；1.03 MP 那张脸是软的，眼是一坨暗块。**虹膜两条都没有**。逐帧统计：1.22 MP `YAVG 82.8 / YMAX 226.3 / SAT 15.0`，1.03 MP `74.3 / 214.8 / 16.8`。

⇒ 画布继续是杠杆，1.22 MP 是这台 8G 上目前能跑的最高画布（再往上要测）。代价是每步时间按 token 线性涨。

⇒ 10 秒档拿原生画布只能走 SelfLift，代价 32.4 分钟；5 秒档直出 1 MP 只要 14.3 分钟。超分在 0.415 MP 上是 13 秒，到 1 MP 是 8.7 分钟 —— **块数随画布涨**，不是常数。

## 五、跑不了的

- **KJNodes `MiniMaxH3MemoryEfficientSageAttentionPatch`**：`ltxv_nodes.py:1704-1708` 要求 `per_thread_int8_triton / per_warp_int8_cuda / per_block_int8_triton / per_channel_fp8 / get_cuda_arch_versions`，本机 sageattention 1.0.6 六个里只有 `attn_false` 有，也没有 `sm89_compile` 模块 → `_cuda_archs=None` → execute 第一行 raise。作者 4060 上「单采高质量」快就靠这条，我们断。
- **QuantFunc int4**：要联网认证 `service.quantfunc.com`；缓存开 → OOM（CCA live 7013 MB，缺 768 MB），缓存关 → 高分段 2282s。参照数假设模型能常驻。
- **taeh3 预览 VAE**：`models/vae_approx` 是空目录，本机没有；且 TAE 解码更糊，与「清晰度低」冲突。
- **无审查编码器最小档** 14.61 GiB（Heretic NVFP4），没有更小 tier；ComfyUI 无 ClipProj 支持（`comfy/` 与 `custom_nodes/` grep 零命中），走不了 4B+ClipProj 那条。


### 社区 8G 方案（2026-10-04 从阿里云服务器查，本机 GitHub 被墙）

- **KJNodes `MiniMaxLowVRAMAttention`**（已装，`nodes/minimax_nodes.py:154`）—— 按 head 分组算注意力（`head_chunks` 1–56），heads 独立所以**结果与未打补丁逐位相同**；省的是 kernel 内部瞬态（int8 q/k 副本、fp32 累加器），并提前 `del` qkv 缓冲。描述原文「without changing the math … Output is identical to the unpatched model」。
- **issue #16144**（4060 8GB + 16GB RAM）：跑 H3 靠 kijai 的 4-bit w4a8 模型 + sage attention + Blocksparse，参数 `--lowvram --vram-headroom 1 --reserve-vram 1 --force-channels-last --use-sage-attention --disable-comfy-compiler`。他的观察：不开 blocksparse 时显存满格但**不 OOM、能出片**。
- **PR #16148**（2026-09-06 merged）修的是 blocksparse 与 comfy compiler 的冲突（跨步长命分配被 graph 当成新分支，每 block 一个 aimdo page → VRAM 泄漏）。我们装的版本已有（`comfy/model_prefetch.py` 里的 `_PauseMallocGraph`）。
- **他的 torch 是 2.13 + cu13.0** —— 也就是 **CUDA backend 开着**。这才是 8G 能上 ~1 MP 的真前提：融合 kernel 不需要「int8 副本 + fp32 scale + 输出」三块独立缓冲。我们 cu124 走 triton 路径，这三块都要单独分配。

**实测（1152×640 + `head_chunks=8`，关/开编译器各一次）：两次都 OOM，且 OOM 点不在注意力。** 打补丁后 traceback 确实走 `minimax_block_lowmem_forward`（补丁挂上了），但炸在 `comfy/ldm/minimax/model.py:211` 的 MLP —— `triton_quantize_rowwise` 要 `torch.empty_like(x, int8)`（424 MB）+ fp32 scale（414 MB）+ 输出（848 MB），单 MLP 一层就要 ~1.7 GB。第一次的 CUDA 内存摘要 peak 只有 **2022 MiB**（卡是 8 GB），所以墙是**激活缓冲 / aimdo 页分配，不是显存容量**。

⇒ `MiniMaxLowVRAMAttention` 是画质中性的内存杠杆，但它只缩注意力，缩不了 MLP 的量化缓冲。在 cu124 上它救不了 1 MP。要上 1 MP 只有两条：分块（= 超分，已排除），或单独装一个 cu130 venv 拿 CUDA backend（冻结环境规则不许动现有 venv）。

### GGUF 搬运（Q2_K）—— 实测不加速，反而慢 27%（2026-10-05）

`minimax_h3_ref2va_pruned-Q2_K.gguf`（6.68 GB）在 **864×480 / 4 步 / 无 LoRA / cu130 实例 / seed 797** 上：**102.2 s/步，整单 9.0 min**。对照同形状的 int8 convrot 臂 **80.2 s/步 / 7.3 min** ⇒ 量化文件小 3.1 倍，时间反而多 27%。

**而且画面发黑（用户 2026-10-05 看片判「画面都黑的」，量化对照确认）：** 同 prompt、同参考图、同形状、同 4 步，逐帧 signalstats 平均 —— int8 臂 `YAVG 102.2 / YMAX 235.3 / SAT 10.3`，Q2_K 臂 `YAVG 64.9 / YMAX 142.9 / SAT 3.6`。**243 帧里没有一个像素超过 143** ⇒ 高光全被压掉，这不是内容差异（换 seed 不会把 YMAX 天花板压到 56%），是量化本身把输出压暗去色。

真根因是**反量化那一趟**：`ComfyUI-GGUF/ops.py:177` `dequantize_tensor(tensor, dtype, self.dequant_dtype)` 在 `cast_weights` 里每次前向都调用，计算 dtype 落在 bf16（日志 `model weight dtype torch.bfloat16, manual cast: None`）。int8 那条走 comfy_kitchen 的 CUDA 算子，直接在量化数据上算，没有反量化这一趟。

而且它**没有因此常驻**：`loaded partially; 13.94 MB usable, 0.00 MB loaded, 6663.86 MB offloaded` —— 6.67 GB 照样从盘上流。每步 = 读 6.67 GB + 逐 tensor 反量化 + bf16 矩阵乘。省字节数这个杠杆被反量化工作量吃回去了。

⇒ **GGUF 不进生产。** 位宽要真省时间，前提是算子直接吃量化数据（comfy_kitchen 那条），不是先展开成 bf16。

坑（下次别再踩）：`ComfyUI-GGUF/nodes.py:32` `update_folder_names_and_paths("unet_gguf", ["diffusion_models", "unet"])` —— 文件放 `models/GGUF/` **不进下拉列表**（`get_filename_list("unet_gguf")` 只扫这两个目录），必须放 `models/diffusion_models/`。


**1 MP 画布在 8G 上不可达 —— 但只在 243 帧那个长度上不可达（2026-10-04 实测 + 社区搜索）。** 1344×768 / 243 帧在 cu130 上跑 12.6 分钟 OOM；加 `BlockSparseAttention`（sol-attn tau 1.3）后补丁确实挂上（traceback 有 `nodes_sparse_attention.py:318 block_patch`），但 OOM 点仍在 **MLP**（`comfy/ldm/minimax/model.py:298` → `self.mlp(h)`）：请求 787 MiB、已分配 7.88 GiB、卡 8.00 GiB、free 0。

⇒ sol-attn 是**速度**杠杆不是**内存**杠杆（社区参照 5090：dense 44 s/it → 0.85 稀疏 31 s → 0.90 稀疏 25 s，1.4–1.75×，「不吃额外显存」，收益随序列长度增长）。MLP 每层的 int8 副本 + fp32 scale + 输出缓冲它碰不到。

到 1 MP 的唯一路是分块，而分块只作用在高分段（`nodes.py:252`）⇒ 必须先付一次 latent lift = 超分。所以「1 MP 且不超分」在这张卡上结构上不可达。可达的最高不分块画布是 **1152×640（0.74 MP）**，实测在 cu130 上跑得动（19.0 min）。

已知风险（issue #16382）：挂 LoRA + sol-attn 出伪影，关掉 sol-attn 恢复正常。


**帧数放开后 1 MP 可达（2026-10-04 实测，用户允许 5 秒档）：** `align_frame_count` 是 `n % 17 == 5`（`ComfyUI-JZL-MiniMax-H3/nodes.py:29-32`），5 秒 = 120 → 对齐到 **124 帧**；`video_latent_t(124) = 37`（243 帧是 72）。1344×768 / 124 帧 / 4 步 / 4步LoRA / cu130 实例 → **跑通，14.3 分钟**（每步 113.7 → 206 → 238 → 226.8 s，越跑越慢是 VRAM 顶格换页）。

⇒ 墙是 **token 数**，不是画布本身。画布 × 帧数 = token；1 MP 在 243 帧是 ~76.8k token（MLP 每层 int8 副本 + fp32 scale + 输出 ≈ 1.2 GB，加权重常驻就超 8 GB），在 124 帧是 ~37 latent 帧 → 装得下。

所以「1 MP 且不超分」现在有一条真路：**1 MP 画布 + 5 秒**，代价是时长从 10 s 掉到 5 s（每镜头要重新切分）。

## 六、不加超分的清晰度（官方文档口径，2026-10-04 搜到）

出处：[docs.comfy.org/tutorials/video/minimax/minimax-h3](https://docs.comfy.org/tutorials/video/minimax/minimax-h3)。四条原句：

1. **"Steps do not add sharpness the native canvas cannot resolve, so a soft frame is a resolution problem first."** ⇒ 加步数不是清晰度的解；我们 4 步 vs 8 步实测无差别，正好落在这句上。
2. **"H3 is trained at around 1 megapixel."** ⇒ 我们跑的 864×480 = **0.415 MP**，只有训练画布的 41%。清晰度上不去是**分辨率低于原生画布**，不是模型糊。1152×640 = 0.74 MP，1344×768 = 1.03 MP（≈原生）。
3. **"Shots with high-frequency detail… keep improving up to about 50 steps."**（"Shots with simple content hold up at 12 to 16 steps"）⇒ 高频细节确实随步数涨，但要到 ~50 步才有可见增益；4/8 步在「简单内容」那一档，所以没差别。
4. **"INT8 kernels that round each row with a single shared scale lose part of that signal."** + **"With the bf16 checkpoints, switching the dense attention backend to Comfy Kitchen attention clears the artifacts."** ⇒ int8 注意力每行只有一个共享 scale，会丢信号；要清伪影得用 bf16 checkpoint，而 bf16 是 25 GB，8G 卡装不下。

**所以「不加超分」只剩两条真路**：把生成分辨率推到 ~1 MP（8G 上必须分块），和把步数推到 16–50。两条都是时间/显存代价，不是免费杠杆。

**结构性限制（2026-10-04 实测，A′ 8 秒 OOM）**：`nodes.py:252` 是 `tiled_model(...) if highres_tiling else hires_base` —— 分块**只作用在高分段**，低分段永远不分块。所以 `lowres_scale=1.0`（lift 变恒等）时第一段就是目标分辨率且不分块，1152×640 整条序列装不下 → 8 秒 OOM。
⇒ **lift 正是让低分段便宜的那个东西，分块只在 lift 之后才生效**。想上 ~1 MP 就必须先付一次 latent lift（它就是超分）。所以「无超分 + 1 MP」在这张卡上不可达；无超分的画布上限就是「不分块装得下」的分辨率（实测 864×480 = 0.415 MP）。

## 七、TeaCache（减少前向次数，但质量掉 ⇒ 划掉）

`custom_nodes/ComfyUI-MiniMaxH3-TeaCache`（Icyoung），零依赖、不碰冻结 torch。节点 `MiniMaxH3TeaCache` 插在模型加载器和 guider 之间，用 `set_model_unet_function_wrapper`（`comfy/samplers.py:333` 传 `{"input","timestep","c"}`，签名对得上）。

20 步实测进度（864×480 / 无 LoRA / triton + fast-disk）：

| 步 | 用时 | 判读 |
|---|---|---|
| init | 2:29 | 冷缓存 |
| 0–1 | 149s + 44s | `start_step=2` 之前必须真算 |
| 2→8 | 97s / 6 步 | **缓存生效**，16.1 s/it |
| 8→12 | 97s / 4 步 | 24.2 s/it |
| 12→15 | 97s / 3 步 | 32.5 s/it |
| 15→19 | 97s / 4 步 | 48.6 s/it |
| 采样合计 | **12:55** | 真算约 7 次，复用约 13 次 |

⇒ 整单 15.9 分钟 vs 同基线 16 步无缓存 35.3 分钟。

**但复用率随步数下降**（16.1 → 48.6 s/it）：`teacache.py:85` 用的是裸 `rel_l1`，没有论文里那个按模型标定的多项式，所以越到后面每步输入变化越大、越容易顶过 0.15 阈值。作者参照是 GA100 上 −66.7%（3.0×），我们 2.2×。

**质量判读（2026-10-04 用户看片）：比无缓存基线差 ⇒ 不进生产。** 真因在实现不在算法：`teacache.py:117` 的复用分支直接 `return state.prev_output`，**没有论文里那个 `poly(rel_l1)` 预测的输出增量**（文件 docstring 自己写多项式是 Phase-2）。复用步等于把上一步的速度照抄一遍，轨迹被冻住 —— 越靠后修正量本该越大，就越糊。这不是 TeaCache 的固有代价，是这个实现没做修正项。

两条可选（都还没验）：① 压 `rel_l1_thresh` 到 0.05 —— 真算次数回到 12–15，速度增益掉到约 1.3×，质量接近基线；② 补多项式标定 —— 要先跑一遍拿每步 rel_l1 曲线，不是改一个数。


### 修完的实测（2026-10-04，20 步单变量对照）

改了三处：按流分开算（`split_streams` 用 `patcher.model.latent_shapes`，见 `sampler_helpers.py:201` + `samplers.py:1221`）、复用分支加一阶增量外推、加 `log_per_step`。自检脚本 `test_teacache.py`（假张量，验切分顺序 + 增量项非零 + 顶阈值必须真算）。

- **22.3 分钟**，`real=12 reuse=8` —— 比单流版的 `real≈7` 慢，因为两条累加器相加，阈值顶得更勤。
- 每步曲线（video / audio 两个累加器）：

| 步 | 判定 | video | audio |
|---|---|---|---|
| 2 | reuse | 0.0119 | 0.01369 |
| 3 | reuse | 0.04515 | 0.05129 |
| 4 | **real** | 0.10244 | 0.1158 |
| 5→6 | reuse | 0.01132→0.03739 | 0.01678→0.05542 |
| 7 | **real** | 0.08296 | 0.12073 |
| 8 | reuse | 0.01683 | 0.03084 |
| 9 | **real** | 0.05184 | 0.09984 |
| 10 | reuse | 0.02062 | 0.02783 |
| 11 | **real** | 0.06622 | 0.10009 |
| 12 | reuse | 0.02993 | 0.04292 |
| 13 | **real** | 0.09751 | 0.15193 |
| 14 | reuse | 0.04805 | 0.05377 |
| 15 | **real** | 0.15961 | 0.18519 |
| 16 | **real** | 0.08808 | 0.10424 |
| 17 | **real** | 0.12982 | 0.148 |

**audio 每一步都比 video 大** ⇒ 单流版把两条混成一个数时，audio 的高变化率被 video 平均掉，所以它更激进（每 6 步一次真算）。按流分开后是每 3 步。这条证实「双流必须分开算」不是风格问题，是判据问题。

**每步 rel_l1 随步数单调上升**（0.012 → 0.16）—— 越到后面轨迹变化越快，所以「固定阈值 + 裸 rel_l1」天然前松后紧。多项式标定要的就是这条曲线的形状，数据现在有了。

质量判据等看片。注意 `tc20f_00001`（2.74 MB）与 `tc20f_00002`（3.14 MB）同 seed 同代码大小不同 ⇒ 存在非确定性，文件大小不能当单变量对照的凭据。

## 八、多路下载留下的半成品文件

`models/text_encoders/qwen3vl_32b_minimax_h3_int8_convrot.safetensors` 之前报 `Tensor 'model.layers.9.self_attn.v_proj.weight' extends past the end of the file`。真因不是下载断了，是脚本按**整数 GB 预分配**：文件 27,140,000,001 字节，header 声明的真实总长 27,141,342,152，差 **1,342,151 字节**（尾巴从没写进去，中间没有洞）。补 Range 请求后 sha256 与 HF LFS oid `bc2ced0f…3923` 逐位一致。

判 safetensors 完整性：读 8 字节 header 长度 → JSON → `max(data_offsets[1]) + 8 + header_len` 对比文件大小；只看文件大小会漏判（预分配的文件「看起来」是完整的）。


## 九、cu130 单独 venv（2026-10-04 装好并实测）

`E:\AI\ComfyUI\.venv-cu130`，torch **2.14.1+cu130**，comfy-kitchen 0.2.35，comfy-aimdo 0.5.5。不动原 venv（冻结规则）。跑在 **6007**，共用 `E:\AI\ComfyUI\models`。

判据：`comfy/quant_ops.py:26-27` 那个门从 `disabled: True` 变成 **`available: True, disabled: False`**，能力表里有 `sol_attn`（融合稀疏注意力 kernel）。

实测（同一个 4 步 / 864×480 / 无 lift / 4步LoRA / fp16 VAE 图，只换 torch）：

| 形状 | cu124 + triton | cu130（CUDA backend，不开 triton） |
|---|---|---|
| 864×480 | 101.8 s/步 → **9.0 min** | **80.2 s/步 → 7.3 min** |
| 1152×640 | **104 秒 OOM** | **219–269 s/步 → 19.0 min（跑通）** |

⇒ 每步只快 **19%**，不是 9.5×。但 **1152×640 从跑不动变成跑得动** —— 这是第一次在 8G 上不分块超过 864×480。所以 cu130 买到的不是速度，是**画布**。

为什么不是 9.5×：作者那 0.155 s/千 token 还靠 sage/blocksparse（融合 kernel 不需要单独分配 int8 副本 + fp32 scale）和模型常驻。我们 1152×640 是 103,680 token/步、219 s = **2.11 s/千 token**，比 864×480 的 1.16 s/千 token 更差 —— VRAM 顶格（7785 MiB）后开始换页。

顺带：QuantFunc 插件在这个 venv 下 `[qf_native] installed QuantFunc engine 0.0.17 for sm89 GPUs, CUDA 13` —— 之前死在 cu124 的版本要求，现在引擎能装（但它的联网认证问题还在）。


## 十、FBC（First Block Cache）—— 实测有效，推翻了我的预测

`KingGore/ComfyUI_H3FBC`（零依赖，走 `patches_replace`，不动 core）。节点 `MiniMaxH3FirstBlockCache`：用 block 0 的残差变化预测其余 49 层，rel_l1 低于 threshold 就整段跳过。自带 `test_fbc.py` 20 项全过（含 `threshold=0` 逐位等同未打补丁 —— 这就是干净 A/B 基线）。

**A/B（cu130 实例 6006，864×480，20 步，无 LoRA，同 seed 793，只差 threshold）：**

| 臂 | threshold | 执行 | 命中 |
|---|---|---|---|
| A | 0.0（不跳） | **27.3 min** | — |
| B | 0.08 | **16.5 min** | 约 50% |

命中步 **3.6 s** vs 全量步 **78 s**（约 20×）。模式是全量/命中交替 —— 每跳一次 rel_l1 就顶回阈值，强制一次全量刷新。

**我原先的预测错了。** README 明写「FBC saves compute, not weight-transfer bandwidth：`prefetch_queue_pop` 在 block 循环里、在这个补丁之前，是 lookahead-1，所以被跳过的 block 的权重照样被搬进显存 ⇒ 如果瓶颈是权重搬运，实测加速会明显低于跳过比例」。我们这台正是带宽瓶颈，所以预期接近零。实测 1.65× —— 原因：6006 现在带 `--disable-comfy-compiler`，prefetch 的 graph 路径不走，跳过的 block 实际没被搬运。

⇒ **FBC 是这台机器上目前唯一实测有效的提速杠杆**（TeaCache 那条已因画质划掉）。作者参照是 5090 上 1.33×，我们 1.65×。

没验的：省下来的时间有没有丢细节 —— 两条片子已发，等看片判。判之前不进生产。


**但 FBC 的缓存是实打实的显存代价，画布越大越吃亏。** `cached_rest` 必须全长（补残差用）：`seq_len × hidden(5376) × 2 B`；`metric_stride` 只压比较用的 `prev_first`，压不了 `cached_rest` 和 `anchor`。

| 画布 | token/步 | FBC 缓存 | 全量步 | 命中步 | 命中率 |
|---|---|---|---|---|---|
| 864×480 | 69,120 | ~1.5 GB | 78 s | 3.6 s | ~50% |
| 1152×640 | 103,680 | **~2.2 GB** | ~230 s | 10–15 s | **~35%**（16 步 41.7 min 反推 10–11 全量 + 5–6 命中） |

1152×640 上这 2.2 GB 把 VRAM 顶到 7772 MiB，日志反复 `cudaMallocAsync ... recovered from an allocation failure by trimming the pool and retrying` —— 分配器反复释放再申请，是纯开销。

⇒ **FBC 不省权重搬运**（README 明写，`prefetch_queue_pop` 在补丁之前、lookahead-1），所以全量步成本不变；它只省命中步。50 步 @1152×640 按 35% 命中算约 **126 min**；同样 50 步 @864×480 约 46 min。要更长 streak 只能抬阈值（作者建议区间上限 0.12）。

**FBC 与 SelfLift 分块互斥（实测 0% 命中）：** `fbc_patch.py:190-195` 的 new_run 判定是 `sigma >= st.last_sigma - 1e-9`，而分块路径每个瓦片都用同一个 sigma 跑一次 forward ⇒ 每瓦片被当成新 run、锚点重置 ⇒ `run 结束 branch=(0,): 0/1 步命中 (0%)`。所以「1 MP + 243 帧 + FBC」不会省时间。


### 8 GB 社区实数对照（2026-10-05，从阿里云服务器搜，本机 GitHub 被墙）

| 来源 | 卡 | 形状 | 每步 / 整单 |
|---|---|---|---|
| Wan2GP issue #2109 | 3070 8GB | 720p / 5 s | 25–30 min 整单（作者自己说「不太值」） |
| Wan2GP 用户报告 | 2080 Super Max-Q 8GB (Turing) | 832×480 / 124 帧 / 20 步 | **191–201 s/步**，整单 1h05 |
| 同上换 SageAttention | 同上 | 同上 | 169 s/步，**但结果静默损坏**（无视 prompt、脸变形；文本编码器也走 Sage，条件被破坏） |
| `stevenke1981/h3cspeed`（`antirez/h3.c` 的 CUDA 移植，三层权重管理） | 3070 Ti 8GB | **256×256 / 22 帧 / 20 步** | 它的「质量基线」就是 256×256；且要求 **64 GiB 系统内存起步**（我们 31.8 GB）⇒ 用不了 |

⇒ 我们这台（4060 + cu130）的 **80 s/步 @864×480** 已在 8 GB 报告带的上沿，比那个 2080 Super 快 2.4 倍。**慢不是配置错，是 8 GB 的物理账。**

能改变带宽账的只有三条，都已排除或不可达：① 让权重常驻 —— 唯一装得下的量化是 `unsloth/MiniMax-H3-GGUF` 的 **Q2_K 6.22 GB**，但加激活（1.5 GB）和 FBC 缓存就超 8 GB，且 Q2_K 质量明显掉；② 减少每步权重触碰次数 —— FBC 跳的是计算不是搬运；③ 更快的搬运 —— 那是硬件（4090 1008 GB/s vs 我们 224 GB/s）。

## 十一、硬约束（不随配置变）

- 帧数：原口径是「不能动（243 帧 / 10s）」，**2026-10-04 用户放开到 5 秒档（124 帧）** —— 这是 1 MP 画布能跑通的前提。10 秒档仍受 8G 限制，最高 0.74 MP。
- 音频必须保留。
- 环境已冻结：绝不升 torch。
- 720p 及以上只能走 SelfLift（分块），8G 上 SelfLift 与 FlashVSR 互斥（1152×640 ×2 = 2304×1280 必炸）。
- 量耗时必须换 seed，否则量到缓存。

## 十二、keyframe（帧锚）与分块 —— 我们弄错了，社区有补丁

**判据来源：** [facok/comfyui-SelfLift PR #14](https://github.com/facok/comfyui-SelfLift/pull/14)（open，未合并）。

`_tile_payload()` 原来只在**没有 refs** 时刷新 `cond_video_latents`（`if not payload.get("refs")`）。refs 与 keyframe 共存时，payload 保留未切块的 keyframe 行，而 tile layout 只预留裁过的行 → `comfy/ldm/minimax/model.py:707` `all_video_rows[~img_update] = cond_video_rows` 报 shape mismatch。我们那条正是 3 refs + 1 keyframe，实测炸在这行（`[3640,96] vs [2600,96]`）。

补丁 4 行（已打到本地 `custom_nodes/comfyui-SelfLift/h3_tiling.py`）：`cond_video_latents` 恒按 payload 顺序重建 = 本 tile 的 keyframes + 未切块的 refs。

**修复后实测（1344×768 / 4 步 / 分块开 / keyframe 在 frame 0）：跑通，8.3 min。**

**单帧锚实测（task 145，sb2，1.22 MP，LoRA 在，seed 800）：8.4 min，第 0 帧 = 上一段末帧，t=0.2/2/5 从同一坐姿继续，无跳变。** 采样账：低分 3 步 130.9 s（43.4 s/步）+ transition 12.8 s + 高分 1 步 229.9 s = **373.6 s**，比不带 keyframe 的 514 s **快 27%** —— 因为 keyframe 的 cond 行永不降噪（`img_update=False`），每步只重注入。

**未验：** 这是单帧锚，是社区口径的退化情形。完整口径是 **22 帧窗口 + 裁掉段首 窗口+过渡 跑道**（`SEAM_DEFAULT_WINDOW=22`、`SEAM_DEFAULT_SETTLE=12`），且引导取上一段的**一采 latent**而非像素重编码（`nodes_asset_manager.py:1122`：同画布同 latent 空间 → 零往返损失、零累积漂移）。窗口版需要桥能收多帧输入 —— 桥的 `LoadImage` 只给单帧，VideoHelperSuite 在 cu130 venv 缺 `cv2` 没装上。

**判据提醒：** 之前那条「画质超级差」的探针是**无 LoRA** 的（脚本从 `.q2k.mjs` 改来，LoRA 被摘掉了）—— 不能用来评 keyframe。带 LoRA 的这条才是可比的。

**端到端实测（task 149，sb2，1.22 MP / LoRA / 分块 / 22 帧窗口 + 裁 34）：9.2 min，交付 294 帧 = 12.25 s。** 裁剪生效；交付第 0 帧是从上一段末态平滑继续的（不是照搬跑道，也没有跳变）。

三个踩过的坑（都已修）：
- `ImageFromBatch` 的入参是 `image` / `batch_index` / `length`，不是 `image_batch` / `start_index`
- `VHS_LoadVideoPath` 要**完整路径**，适配器之前只传文件名 → `Invalid file path`
- 窗口 clip **必须保留音轨**：VHS 返回懒加载音频 dict，ComfyUI 缓存扫描迭代它时若无音轨直接抛（`VHS failed to extract audio`）。而且插件口径本来就是视频+音频一起带过接缝 —— `AddGuide` 的 `audio` 输入现在只在 clip 路径上连（`LoadImage` 没有音频输出）

窗口版比单帧锚慢（9.2 vs 8.4 min），因为生成侧多了 34 帧跑道。

**走 huobao 流程本身（不是手搓图）的第一条：task 151，sb2，1005 18:33→18:43，9.6 min，交付 294 帧。** 链路 = `relayContext`（sb1 同场景 → 接）→ `extractLastFrames` 落盘 22 帧窗口 → adapter 传 `guide` + `trim=34` → 桥 `MiniMaxH3AddGuide`（frame_idx 0，连 `audio`/`audio_vae`）→ `ImageFromBatch batch_index 34` + `TrimAudioDuration start_index 1.4167`。队列里核对：生成 328、落盘 294、窗口 clip 带音轨。

**这条之前有个真 bug：continuity 提示词从没送到模型。** `generation.ts:262` 把 continuity 行拼进局部 `prompt`，`:287` 传给 adapter 的却是 `record.prompt` —— 拼的那段白写。task 150 在队列里核对过，prompt 里没有 `continuity`。已修（`43d1498`），测试加断言锁住。修后 task 151 的 prompt 含：`continuity: [video continuation + keyframe completion] the opening 22 frames are carried from the end of the previous shot; match its lighting, colour and camera position.`

接缝判据（放大后）：场景/服装/光线延续成立 —— 同一张床、同一扇窗、同一件白裙黑蕾丝、同一束暖光；sb1 末帧与 sb2 第 0 帧像素差 42.5（照搬跑道会是 <5，说明裁段首生效），段内逐 60 帧差 40–46（在演化，不是静止）。身份这一条**没法判**：这条分镜全程背身/侧后脑，没有正脸帧。

**改回单帧锚（1005，用户要的是首尾帧效果）：task 152，sb2，8.0 min，落盘 294 帧。** 判据 = 落盘第 0 帧 vs 锚（`_last.png`）像素差 **5.92**（窗口版是 42.5）—— 5.92 就是 VAE 往返损失，不是构图差。放大核对：同一张床、同一束窗光、发丝位置逐条对得上。

两条口径的取舍：窗口（22 帧）给模型的是**光照/色调的记忆**（社区 luma drift 1.055→1.022/hop），代价是段首 34 帧是照搬跑道、必须裁 ⇒ 成片第 0 帧不等于锚。单帧锚没有跑道 ⇒ 首尾帧直接对上，而且更快（8.0 vs 9.2 min）。

**最终走 latent 直传（1005 晚，用户要「效果好的、能做首尾帧的」）：task 153/154，sb1 7.5 min + sb2 8.0 min，sb2 落盘 272 帧。** 桥加两个节点（`custom_nodes/ComfyUI-OpenAI-Bridge/__init__.py`，仓库外，改完必须重启 6006）：`BridgeSaveAVLatent`（core 的 `SaveLatent` 对 nested tensor 会炸，`nodes.py:553`，所以自己 `torch.save` 两个 tensor）和 `BridgeSeamGuideFromLatent`（读上一段 latent 的尾部 **7 token + 37 音频步** 注入 keyframe）。文件在 → 零往返；不在 → 回退 pixel 路径。

三条口径的接缝判据（同一分镜 sb1→sb2）：

| 口径 | 接缝逐帧差 | 段内运动 | 落盘 |
|---|---|---|---|
| 单帧锚 | **39.5**（跳一下然后冻 10 帧） | 0.3–2.6 | 294 |
| 窗口 + pixel 引导 | 18.9 | 均匀 | 294（要加 34 跑道） |
| **窗口 + latent 直传** | **3.58** | 3.43 | **272** |

3.58 ≈ 段内的正常运动步（3.43）⇒ 接缝看不出来。音画对齐核对：视频 11.333333 s / 音频 11.333344 s。

代价说清楚：chained 段每条少 22 帧（窗口让给下一段），所以单条 11.33 s 而不是 12.25 s；整集总时长 = Σ段长 − 22×(段数−1)。这是插件口径本身（`nodes_asset_manager.py:3820` 的 tooltip 写的就是这个）。生产走这条；`continuity` 提示词里那句「the first 22 frames are carried」与它一致。

**第一集 7 条全跑（1005 14:04→14:58，提示词先按新说话人规则重跑）：** 每条 chained 段落盘 = 生成 − 22，逐条接缝 2.3–4.9（= 段内正常运动步量级），跨场景的 sb7 不接、落盘满 294。

| 镜头 | 时长 | 落盘 | 接缝 |
|---|---|---|---|
| sb1 | 12 s | 294 | — |
| sb2 | 12 s | 272 | 4.23 |
| sb3 | 12 s | 272 | 4.19 |
| sb4 | 12 s | 272 | 4.88 |
| sb5 | 8 s | 170 | 2.26 |
| sb6 | 10 s | 221 | 3.05 |
| sb7 | 12 s（跨场景，不接） | 294 | — |

字幕判据（逐帧底部三分之一近纯白占比，字幕会持续 0.02–0.05）：7 条全 0.000–0.013，峰值都是窗光不是字。
