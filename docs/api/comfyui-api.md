# 本机 ComfyUI OpenAI 兼容接口参考

本仓库配套的本机 ComfyUI 通过自研 `ComfyUI-OpenAI-Bridge` 扩展，把 ComfyUI 的
生图（Krea 2 Turbo）与生视频（MiniMax-H3 ref2v）能力暴露成**OpenAI 兼容的 HTTP 接口**。
本文件按**引用式**组织：标准字段/参数请参照官方 OpenAI API 参考，本桥与 OpenAI 的
**差异项**直接标注，不重复赘述。

> **桥代码位置**：`E:\AI\ComfyUI\custom_nodes\ComfyUI-OpenAI-Bridge\__init__.py`。
> **不在本 git 仓库**——改动桥代码后必须**重启 ComfyUI** 才生效（进程重启还会丢掉
> 内存里的作业状态，但产物 mp4 仍在 `output/openai/`）。

---

## 1. 基础信息

| 项 | 值 |
|---|---|
| 服务 | 本机 ComfyUI（ComfyUI-OpenAI-Bridge） |
| 基础地址（Base URL） | `http://127.0.0.1:6006`（已含 `/v1` 前缀） |
| `Content-Type` | `application/json` |
| 鉴权 | 本桥不校验 key；`Authorization: Bearer <任意>` 可选，可省略 |

## 2. 官方参考文档（引用）

| 本桥端点 | 参照的 OpenAI 端点 | 官方参考链接 |
|---|---|---|
| `POST /v1/videos/generations` | video generative | https://platform.openai.com/docs/api-reference/videos/generations |
| `POST /v1/images/generations` | image generative | https://platform.openai.com/docs/api-reference/images |
| `GET /v1/images/generations/{id}` | image job | https://platform.openai.com/docs/api-reference/images |
| `GET /v1/videos/generations/{id}` | video job | https://platform.openai.com/docs/api-reference/videos |
| `GET /v1/models` | models | https://platform.openai.com/docs/guides/models |
| `GET /v1/files/{path}` | file direct link | https://platform.openai.com/docs/api-reference/files |

> 通用规则（认证方式、`n`、seed、错误返回结构等）同 OpenAI，此处不重复，直接对照上表。

---

## 3. 模型（Models）

| `model` | 类型 | 用途 / 限制 |
|---|---|---|
| `minimax-h3-ref2v` | 视频（ref2v） | 参考图→视频。`576x320`，默认 124 帧 ≈ 5.2s@24fps。参考位 `ref_image_0~8`（**9 张**，Autogrow max=9） |
| `krea2-turbo` | 图像（文生图） | 8 步 / CFG 1.0 / er_sde；默认 `1024x1024`，`n` 只能是 1 |

`GET /v1/models` 返回这两个（含 `description`）。

---

## 4. 视频生成

### 4.1 创建任务 `POST /v1/videos/generations`

请求体字段（**参考 OpenAI video generative**，差异项加粗）：

| 字段 | 类型 | 必填 | 默认 | 说明 / 与 OpenAI 差异 |
|---|---|---|---|---|
| `prompt` | string | ✓ | — | 视频描述文本 |
| `model` | string | ✓ | `minimax-h3-ref2v` | 本桥视频模型（OpenAI 用 `sora` 等，本桥用本地模型名） |
| `size` | string | ✗ | `576x320` | 形如 `"WxH"`。**差异**：OpenAI 视频用 `dimensions`（如 `"1080p"` / 宽×高串），本桥固定用 `"WxH"` |
| `length` | integer | ✗ | `124` | **差异**：本桥是**整数帧数**（124 帧≈5.2s@24fps）；OpenAI 视频用秒数串（如 `"5s"`） |
| `images` | string[] | ✗ | `["qingyi.jpg","xueqi.jpeg"]` | 参考图列表（最多 9 张）。**差异（关键）**：本桥传**本地文件名**，须已落在 ComfyUI `input/` 目录；OpenAI 用 URL/base64 |
| `seed` | integer | ✗ | 随机 | 随机种子 |
| `wait` | boolean | ✗ | `false` | **本桥专有**（OpenAI 无此字段）：`true` 则同步等待至完成/失败再返回 |

**本桥专有字段（OpenAI 没有，都是工作流旋钮；实测数与理由在 [台账](../comfyui-h3-configs.md)）**

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `ref_scale` | number | `2.0` | 参考行强度（进 `JZL_MiniMaxH3ReferenceToVideo2`） |
| `upscale` | integer | `0` | 0 = 不挂 FlashVSR；2/3/4 = 放大倍数（与 `selflift` 互斥，1 MP 上叠起来 8G 必炸） |
| `selflift` | boolean | `false` | true = SelfLift 二采直出：`size` 就是目标分辨率，细节靠最后一步在高分辨率上真前向，不再叠超分 |
| `sparse` | boolean | `false` | 块稀疏注意力（本机实测净亏 ⇒ 默认关，只当 A/B 仪表） |
| `first_frame` | string | — | 给了就改走 fl2va 分支（`_wf_fl2va`），`images` 的 9 个参考槽全部作废 |
| `guide` | string | — | 上一段末帧文件名（pixel 路径衔接，走 `MiniMaxH3AddGuide`） |
| `prev_latent` | string | — | 上一段 AV latent 名（`output/latents/<name>.pt`）—— 零 VAE 往返的真无缝，优先于 `guide` |
| `save_name` | string | — | 本段 latent 落盘名，供下一段接 |
| `trim` | integer | `0` | 段首裁掉的跑道帧数（音频同步裁，否则音画错位 `trim/24` 秒） |
| `lora` | string | — | **1006 加**：第二层 `LoraLoaderModelOnly` 的文件名，挂在 turbo 之后、注意力后端之前（`97` 的 model 改吃 `2b`）。不传 = 图与老行为逐字节一致 |
| `lora_strength` | number | `1.0` | 上面那层的强度；只在 `lora` 存在时才进图 |

> 触发词是 LoRA 自己的事，桥不管 —— 由后端 adapter 的 `LORA_TRIGGERS` 表在 prompt 句首塞（`r34l1sm` 这类），没登记的 LoRA 不塞词、照样挂权重。

**响应**

- `wait=false`（默认）：HTTP `202 Accepted`
  ```json
  { "id": "x6f8a2c1d4e5", "status": "queued", "model": "minimax-h3-ref2v" }
  ```
- `wait=true`：HTTP `200`（成功）/ `500`（失败），体为完整作业对象（见 4.2）。

### 4.2 查询作业 `GET /v1/videos/generations/{id}`

```json
{
  "id": "x6f8a2c1d4e5", "object": "video", "status": "succeeded",
  "created": 1760000000, "model": "minimax-h3-ref2v",
  "file": "openai/h3_4733ae65_00001_.mp4",
  "url": "http://127.0.0.1:6006/v1/files/openai/h3_4733ae65_00001_.mp4"
}
```

**作业状态**（对照 OpenAI 的 `status`）：

| 本桥 status | 含义 | 对应 OpenAI |
|---|---|---|
| `queued` | 排队 | `queued` |
| `running` | 生成中 | **`processing`**（本桥用 `running`，等价） |
| `succeeded` | 完成（带 `file`/`url`） | `succeeded` |
| `failed` | 失败（带 `error`） | `failed` |

> **注意（与 OpenAI 差异）**：本桥 `created` 是 Unix 秒时间戳（int），不是 OpenAI 的
> ISO-8601 字符串。轮询时把 `queued`/`running` 都视作“进行中”即可。

**状态判定机制**：本桥只在自己的 `/history/{prompt_id}` 返回 `success` 后才翻
`succeeded`。因此**mp4 已写入 `output/` 但本桥仍报 `running` 属正常延迟**，不要当失败重跑。
产物最终由调用方（本仓库 `generation.ts`）下载回 `static/videos/`。

### 4.3 获取 mp4

- `GET /v1/videos/generations/{id}/content` → mp4 字节流（同 OpenAI sora 的 content 用法）
- 或 `GET /v1/files/{rel-path}` → 直链，例：
  `GET http://127.0.0.1:6006/v1/files/openai/h3_4733ae65_00001_.mp4`

---

## 5. 图像生成

### 5.1 `POST /v1/images/generations`

请求体（**参考 OpenAI image generative**，差异项加粗）：

| 字段 | 类型 | 必填 | 默认 | 说明 / 与 OpenAI 差异 |
|---|---|---|---|---|
| `prompt` | string | ✓ | — | 生成描述 |
| `model` | string | ✓ | `krea2-turbo` | 本桥图像模型 |
| `size` | string | ✗ | `1024x1024` | `"WxH"`，同 OpenAI |
| `seed` | integer | ✗ | 随机 | 随机种子 |
| `n` | integer | ✗ | `1` | **本桥限制 n=1**（n≠1 返回 400） |
| `async` | boolean | ✗ | `false` | **本桥专有**（OpenAI 无此字段）：`true` 则返回 202 作业、异步处理 |

**响应**

- `async=false`：HTTP `200`（失败 500）
  ```json
  {
    "created": 1760000000,
    "model": "krea2-turbo",
    "data": [
      {
        "b64_json": "iVBORw...",
        "url": "/v1/files/openai/krea2_ab12cd34_00001_.png"
      }
    ]
  }
  ```
  `url` 是相对直链（前缀 `http://127.0.0.1:6006` 即得完整地址）。
- `async=true`：HTTP `202`，作业对象（同视频作业，`object` 为 `image`）。
  查询：`GET /v1/images/generations/{id}` → `{ "id","object":"image","status","file"?, "url"? ,...}`

---

## 6. 列出模型 `GET /v1/models`

```json
{
  "object": "list",
  "data": [
    { "id": "krea2-turbo", "object": "model", "owned_by": "local",
      "description": "Krea 2 Turbo 文生图（8 步 CFG1 fp8，1024x1024）" },
    { "id": "minimax-h3-ref2v", "object": "model", "owned_by": "local",
      "description": "MiniMax-H3 参考图生视频（576x320 124帧≈5.2s，9 张参考位）" }
  ]
}
```

---

## 7. 调用示例（curl）

### 7.1 视频（异步，两张参考图）

```bash
curl -s http://127.0.0.1:6006/v1/videos/generations \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "两名女生在古典庭院里自然交谈，女生A戴白色小花发饰，女生B戴金色凤羽发饰，各自保持面容一致，浅景深，电影感",
    "model": "minimax-h3-ref2v",
    "size": "576x320",
    "length": 124,
    "images": ["huobao_ref_a.png", "huobao_ref_b.png"],
    "seed": 42
  }'
# -> 202 {"id":"x6f8a2c1d4e5","status":"queued"}
```

轮询直到 `succeeded`：

```bash
curl -s "http://127.0.0.1:6006/v1/videos/generations/x6f8a2c1d4e5"
```

取图：

```bash
curl -s -L "http://127.0.0.1:6006/v1/files/openai/h3_4733ae65_00001_.mp4" -o clip.mp4
```

### 7.2 同步模式（`wait=true`）

```bash
curl -s http://127.0.0.1:6006/v1/videos/generations \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "...", "model": "minimax-h3-ref2v",
    "size": "576x320", "length": 124,
    "images": ["a.png","b.png"], "wait": true
  }'   # 阻塞约 3 分钟，返回 200/500 的完整作业对象
```

### 7.3 图像（同步）

```bash
curl -s http://127.0.0.1:6006/v1/images/generations \
  -H "Content-Type: application/json" \
  -d '{ "prompt": "a fireball icon on black", "model": "krea2-turbo", "size": "1024x1024", "seed": 7 }'
```

---

## 8. 本桥与 OpenAI 的主要差异（速查）

| 项 | 本桥 | OpenAI |
|---|---|---|
| 视频 `length` | 整数**帧数**（默认 124） | 秒数串（如 `"5s"`） |
| 视频 `size` | `"WxH"` 字符串 | 多为 `dimensions`（`"1080p"` / 宽×高） |
| 视频/图片 `images` | **本地文件名**（须已在 ComfyUI `input/`） | URL / base64 |
| `wait` / `async` | 本桥专有（同步/异步开关） | 无（默认异步返回 202） |
| 作业 `status` | `queued`/`running`/`succeeded`/`failed` | `queued`/`processing`/`succeeded`/`failed` |
| 作业 `created` | Unix 秒（int） | ISO-8601 字符串 |
| 作业状态存储 | 桥进程**内存 dict**，重启即丢（mp4 留在 `output/openai/`） | 服务端持久 |
| 模型名 | 本地名（`minimax-h3-ref2v`、`krea2-turbo`） | 官方模型名（`sora`、`dall·e`） |

---

## 9. 使用注意（平台侧）

- **参考图落盘**：本桥要**文件名**，本仓库 adapter（`backend/src/services/adapters/comfyui-video.ts`）
  生成前会把每张参考图下载/读出并写入 ComfyUI `input/`，再传新文件名；`MAX_IMAGES=9`。
- **单实例**：ComfyUI 启动脚本已加**单实例锁**（`start_clean.ps1` 等）。多实例并发会 OOM、互相抢输出。
- **在跑的任务 vs 改码**：本仓库后端跑 `tsx watch`（5679）；改 `backend/` 源码会**杀掉正在跑的视频任务**
  （报“服务重启，生成任务中断，请重试”）。改代码前先等任务跑完，或改完重启 6006。
- **桌面版**：桌面版无 `PUBLIC_BASE_URL` 能力（见 README「环境变量」），本机 ComfyUI 走本地
  `http://127.0.0.1:6006`，参考资源用本地文件名即可。
