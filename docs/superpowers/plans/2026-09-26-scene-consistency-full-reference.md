# 场景一致性 Full-Reference 提示词改造（P0/P1/P3/九宫格）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复火宝短剧 ComfyUI ref2v 管线"角色脸对但场景漂移"的问题，落地四项配套改动：P0 六段式英文 `video_prompt_full_ref`（新 DB 列 + agent 双产出 + 语言例外 + 工具接收 + 前端只读面板 + comfyui 优先 full_ref），P1 bridge `ref_scale` 1.0→2.0，P3 fl2va 首帧锚定可选开关（`JZL_MiniMaxH3ImageToVideoDual` + 后端首帧 staging + 前端 checkbox），A 场景九宫格场景图（`scenes.grid_prompt`/`grid_image_url` + 新工具 + 新生成路由 + 九宫格优先参考槽）。

**Architecture:** 双轨提示词——保留现有中文 `video_prompt`（人工可读/可编辑，非 ComfyUI 厂商照用 `resolveVideoPromptRefs`），新增六段式英文 `video_prompt_full_ref` 作为送 ComfyUI 桥的模型侧提示词，`genVid` 中 `isComfyUI` 时取 `videoPromptFullRef || videoPrompt`。九宫格图（3x3 固定 9 视角、无人物、1536x1536）作场景 `<Picture N>` 构图锚点；fl2va 用场景宽镜头图作 `first_frame`，单 KSampler 链、`upscale_scale=1.0`。

**Tech Stack:** TypeScript（backend Hono + Drizzle + better-sqlite3 + Mastra；frontend Nuxt 3 + Vue 3）；Python（bridge `E:\AI\ComfyUI\custom_nodes\ComfyUI-OpenAI-Bridge\__init__.py`，**仓库外**）；Node `node:test`（backend/tests/，`readFileSync`+`assert.match` 结构测试 + 纯函数单测）。

**Spec:** [docs/superpowers/specs/2026-09-26-scene-consistency-full-reference-design.md](docs/superpowers/specs/2026-09-26-scene-consistency-full-reference-design.md)

## Global Constraints

- P0 六段式 header 齐全：`subject_definitions:`、`summary:`、`retention_analysis:`、detailed_description:`、`overall_soundscape:`、`non_diegetic_music:`；全文英文，`<d>` 内台词保留原文带语言 tag（如 `<d>[Chinese] …</d>`）；`<Subject N>`/`<Picture N>` 同一套 N（顺序角色 1..k → 场景 k+1 → 道具 k+2..，≤9 张）。
- 语言指令例外：`video_prompt_full_ref` **始终英文**（`buildLanguageDirective` 例外项 + skill 自身规定双重保障）；`video_prompt` 仍随会话语言。
- bridge 改动必须 `python main.py --port 6006` 重启 ComfyUI 才生效；进程内 `JOBS` 作业状态丢失、mp4 保留。
- 参考位顺序 = 谁占脸（角色→场景→道具）——P0 的 `<Picture N>` 正确性基石，不得重排。
- P3 实验性档位，默认关闭、checkbox 用户手开；fl2va 官方偏好单镜头，多镜头效果未验证。
- YAGNI：不自动选 P3、不做大 UI 改造、不碰非 ComfyUI 厂商、不做 fl2va 二采上采样（`upscale_scale=1.0` 单链）。

## Review Focus

| # | 输入/失败模式 | 期望行为 | 测试归属 |
|---|---|---|---|
| 1 | provider=Minimax/火山/Aliyun 时 | 仍用 `resolveVideoPromptRefs` 中文字面，不受 full_ref 影响（回归） | Task 3 Step 7（前端结构测试断言非 comfyui 路径不变） |
| 2 | `videoPromptFullRef` 为空但 provider=comfyui | 回退 `videoPrompt`，不空 prompt 报错 | Task 3 Step 7 |
| 3 | zh 会话模式 + 已有"只输出中文"旧约束 | full_ref 仍英文（例外压制） | Task 3 测试（language.ts 正则）+ Step 8 人工跑 |
| 4 | 场景 `gridImageUrl` 为空、`imageUrl` 有值 | 参考槽用 `imageUrl`；双空时槽位空缺不崩 | Task 6 Step 8（参考槽回退 + 空值丢弃） |
| 5 | `_wf_fl2va` 悬空连线/`first_frame` 未接线 | `_selftest` 断言失败，改后通过 | Task 5 Step 5（python selftest） |

---

### Task 1: P0 存储层 — `storyboards` 新增 `video_prompt_full_ref` 列

**Files:**
- Modify: `backend/src/db/schema.ts` — `storyboards` 表（`videoPrompt` 行旁）
- Modify: `backend/src/db/sqlite-schema.ts` — storyboards DDL（第 100 行 `video_prompt TEXT,` 附近）+ 幂等 `ALTER` 块（按现有风格）
- Test: `backend/tests/storyboard-full-ref-column.test.mjs`（新建，仿 `final-prompt-structure.test.mjs`）

**Interfaces:**
- Consumes: `text()`（Drizzle），现有 ALTER 幂等风格。
- Produces: 字段 `videoPromptFullRef`（`storyboards`），列 `video_prompt_full_ref`。

- [ ] **Step 1: Write the failing test**

Create `backend/tests/storyboard-full-ref-column.test.mjs`:
```js
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const root = new URL('../..', import.meta.url)
const read = (path) => readFileSync(new URL(path, root), 'utf8')

test('storyboards 表新增 video_prompt_full_ref（Drizzle 字段 + DDL 列 + 幂等 ADD COLUMN）', () => {
  assert.match(read('src/db/schema.ts'), /videoPromptFullRef:\s*text\('video_prompt_full_ref'\)/)
  const ddl = read('src/db/sqlite-schema.ts')
  assert.match(ddl, /video_prompt_full_ref\s+TEXT/)
  assert.match(ddl, /video_prompt_full_ref TEXT/i)
})
```
（注：幂等 `ADD COLUMN` 的实际写法以 `sqlite-schema.ts` 现有 storyboards 邻列风格为准；测试断言只要求列名 `video_prompt_full_ref TEXT` 在 DDL 中恰好出现两次以上——CREATE 与 ADD COLUMN 各一次。先读现有 ALTER 块定风格再定断言。）

- [ ] **Step 2: Run test** — Expected: FAIL (regex not matched)
  Run: `cd E:/pycharm/huobao-drama && node backend/tests/storyboard-full-ref-column.test.mjs`

- [ ] **Step 3: Implement**

`schema.ts`：在 `videoPrompt: text('video_prompt')` 行后加
```ts
videoPromptFullRef: text('video_prompt_full_ref'),
```
`sqlite-schema.ts` 两处改动（**幂等**：`initSqliteSchema` 每次启动都跑，且 `CREATE TABLE IF NOT EXISTS` 不能补旧库缺的列，SQLite 无 `ADD COLUMN IF NOT EXISTS`，故用 try/catch 幂等加列，`Database` 类型已由 `initSqliteSchema(sqlite: Database.Database)` 签名引入，无需新增 import）：

1. storyboards DDL `CREATE TABLE IF NOT EXISTS storyboards (...)`（第 86–116 行）里 `video_prompt TEXT,`（第 100 行）后加一行 `video_prompt_full_ref TEXT,`。
2. `REMOVED_SEED_PROMPTS`（第 365–367 行）块后、`export function initSqliteSchema`（第 377 行）前新增幂等加列助手，并在 `initSqliteSchema` 内 `for` 循环（第 378–380 行）的 `}` 闭合后、`const insertSeed`（第 381 行）前插调用：
```ts
// 幂等加列：新库走 CREATE TABLE 已带列，旧库走 ALTER 补列；已存在则忽略（无 IF NOT EXISTS）
function addColumnIfMissing(sqlite: Database.Database, table: string, column: string) {
  try {
    sqlite.exec(`ALTER TABLE ${table} ADD COLUMN ${column} TEXT;`)
  } catch {
    // 列已存在 → 忽略
  }
}

export function initSqliteSchema(sqlite: Database.Database) {
  for (const statement of sqliteSchemaStatements) {
    sqlite.exec(statement)
  }
  // 幂等补列（新库 CREATE TABLE 已含列，此处 no-op；旧库补列）
  addColumnIfMissing(sqlite, 'storyboards', 'video_prompt_full_ref')
  const insertSeed = sqlite.prepare(SEED_SQL)
  ...
}
```
（Task 6 会在同一块再补两行 `scenes` 加列调用，复用此助手；**不要重复定义该函数**。）

- [ ] **Step 4: Run test** — Expected: PASS
- [ ] **Step 5: Commit**
```bash
cd E:/pycharm/huobao-drama
git add backend/src/db/schema.ts backend/src/db/sqlite-schema.ts backend/tests/storyboard-full-ref-column.test.mjs
git commit -m "feat(db): storyboards 新增 video_prompt_full_ref 列（六段式英文全参考提示词）
Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 2: P0 Agent 侧 — 六段式技能 + 结构校验函数

**Files:**
- Create: `backend/src/services/video-prompt-validation.ts`（纯函数）
- Test: `backend/tests/video-prompt-validation.test.mjs`
- Modify: `backend/workspace/skills/prompt-generator/video-prompt/SKILL.md`（新增六段式节）+ `SKILL.en.md`/`SKILL.ja.md`/`SKILL.ko.md`
- Modify: `backend/workspace/prompts/prompt_generator.md` 视频工作流 + `.en.md`/`.ja.md`/`.ko.md`
- Modify: `backend/src/agents/index.ts`（`prompt_generator.instructions` fallback，同步视频步骤；场景步骤加 `save_scene_grid_prompt` 归 Task A）

**Interfaces:**
- Produces: `isVideoPromptFullRefFull(ref: string): boolean`（Task 3/人工验证复用）；agent 经 `update_storyboard` 产出 `video_prompt_full_ref`（Task 3 接好工具后生效）。

- [ ] **Step 1: Write the failing test**

Create `backend/tests/video-prompt-validation.test.mjs`:
```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isVideoPromptFullRefFull } from '../src/services/video-prompt-validation.js'

const GOOD = [
  'subject_definitions:',
  '<Subject 1> is a young woman with short black hair and a white blouse, from <Picture 1>.',
  '<Subject 2> is a man in a dark suit, from <Picture 2>.',
  '<Subject 3> is a 1980s hospital corridor with a long window row on the left, an establishing storyboard reference for [Shot 1], defining its viewpoint, subject placement, and shot order.',
  'summary:',
  '[Shot 1] is a 5.2-second reference-generation video. <Subject 1> and <Subject 2> argue in the corridor; <Subject 3> is the scene anchor.',
  'retention_analysis:',
  '<Subject 1> fully_preserved',
  '<Subject 2> fully_preserved',
  '<Subject 3> fully_preserved',
  'detailed_description:',
  '[Shot 1] 00:00.000 Static medium shot: <Subject 1> paces near the window, says: <d>[English] You were supposed to be here an hour ago.</d> ' +
  '00:02.000 Cut to a close-up: <Subject 2> presses the door, face tense.',
  'overall_soundscape:',
  'Echoing footsteps, distant beeper.',
  'non_diegetic_music:',
  'Sparse low piano.',
].join('\n')

test('complete six-section English full-ref passes', () => assert.equal(isVideoPromptFullRefFull(GOOD), true))
test('missing subject_definitions header fails', () =>
  assert.equal(isVideoPromptFullRefFull(GOOD.replace(/^subject_definitions:\n/, '')), false))
test('missing <Subject> tag fails', () =>
  assert.equal(isVideoPromptFullRefFull(GOOD.replace(/<Subject 1>/g, 'The woman')), false))
test('missing <Picture> tag fails', () =>
  assert.equal(isVideoPromptFullRefFull(GOOD.replace(/<Picture 3>/g, 'the image')), false))
test('missing fully_preserved fails', () =>
  assert.equal(isVideoPromptFullRefFull(GOOD.replace('<Subject 3> fully_preserved', '<Subject 3> weak_reference')), false))
test('missing <d> dialogue fails', () =>
  assert.equal(isVideoPromptFullRefFull(GOOD.replace(/<d>\[English\][^.<]*?<\/d>/, '')), false))
test('empty string fails', () => assert.equal(isVideoPromptFullRefFull(''), false))
```

- [ ] **Step 2: Run test** — Expected: FAIL (`isVideoPromptFullRefFull is not a function`)
- [ ] **Step 3: Implement validator**

Create `backend/src/services/video-prompt-validation.ts`:
```ts
/**
 * 六段式英文全参考提示词结构校验。
 * ponytail: 只验结构（六段 header 齐全 + Subject/Picture 标签 + fully_preserved + <d> 对白），
 * 不验内容语义——内容正确性留给人工/实际生成验证。
 */
const SECTION_HEADERS = [
  /^subject_definitions:/m,
  /^summary:/m,
  /^retention_analysis:/m,
  /^detailed_description:/m,
  /^overall_soundscape:/m,
  /^non_diegetic_music:/m,
] as const

/** 是否满足六段式结构。用于 agent 产物质量门与人工/前端展示判断。 */
export function isVideoPromptFullRefFull(ref: string): boolean {
  if (!ref?.trim()) return false
  return SECTION_HEADERS.every(header => header.test(ref))
    && /<Subject \d+>/.test(ref)
    && /<Picture \d+>/.test(ref)
    && /\bfully_preserved\b/.test(ref)
    && /<d>.*?<\/d>/s.test(ref)
}
```

- [ ] **Step 4: Run test** — Expected: PASS

- [ ] **Step 5: Add six-section section to `video-prompt` SKILL.md**

在 `backend/workspace/skills/prompt-generator/video-prompt/SKILL.md` 末尾（现有内容不动）新增整节，含：
  - 标题：`## 六段式英文全参考（video_prompt_full_ref）`
  - 用途说明：`video_prompt` 是给人看的中文提示词；`video_prompt_full_ref` 是真正送 ComfyUI/MiniMax 桥的模型侧提示词，**必须六段式英文**。
  - 六段模板（Spec §4.2 模板，含 `<Subject N>`/`<Picture N>` 示例、retention 状态词、`<d>[语言tag] 台词</d>` 示例）
  - 标签规则：`<Subject N>`/`Picture N>` 序号 = 参考图顺序（角色 1..k、场景 k+1、道具 k+2..）；`read_storyboard_context` 的 scenes 里 `grid_image_url` 非空表示场景参考是九宫格，场景行须加 `"is a storyboard reference for [Shot N], defining its viewpoint, subject placement, and shot order"`
  - retention：角色用 `fully_preserved`/`attribute_transfer` 按判断，场景一律 `fully_preserved`
  - 语言强制：**本模板恒英文**，无论会话语言；`<d>` 台词保留原语言
- `.en/.ja/.ko` 同步加同一节（`.ja/.ko` 说明用对应语言，模板与标签英文不变）

- [ ] **Step 6: Update `prompt_generator` video workflow**

`workspace/prompts/prompt_generator.md`：
- 步骤 2 后加：`同时按技能「六段式英文全参考」生成 video_prompt_full_ref（英文，含 <Subject>/<Picture> 标签）`
- 步骤 4 改为：`调用 update_storyboard 保存时参数只传三个键：storyboard_id、video_prompt、video_prompt_full_ref。不要回传其他字段。`
`.en/.ja/.ko` 同改（对应语言；"three keys" 表述一致）。

`backend/src/agents/index.ts` 的 `prompt_generator.instructions`（~行 135-148）同步改步骤 2 与步骤 4（fallback，保持与文件版一致）。

- [ ] **Step 7: Commit**
```bash
cd E:/pycharm/huobao-drama
git add backend/src/services/video-prompt-validation.ts backend/tests/video-prompt-validation.test.mjs \
  backend/workspace/skills/prompt-generator/video-prompt/ \
  backend/workspace/prompts/prompt_generator.md \
  backend/src/agents/index.ts
git commit -m "feat(agent): 新增 video_prompt_full_ref 六段式英文产出与结构校验
Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 3: P0 运行时接线 — 语言例外 + 工具接收 full_ref + genVid 优先 + 前端只读面板

**Files:**
- Modify: `backend/src/agents/language.ts` — `buildLanguageDirective`（Exceptions 块，第 27–29 行）
- Modify: `backend/src/agents/tools/storyboard-tools.ts` — `update_storyboard` `inputSchema`（第 358 行）+ `execute` 映射（第 419 行）
- Modify: `frontend/app/views/drama/episode.vue` — `genVid`（第 3262 行）+ 视频提示词区（第 684–697 行 `<section class="video-inspector-section">`）后加只读 full_ref 面板
- Test: `backend/tests/storyboard-full-ref-runtime.test.mjs`（新建）

**Interfaces:**
- Consumes: Task 1 的 `videoPromptFullRef` 列；Task 2 的 skill（产出六段式英文）；`selectedVideoConfig.value?.provider`。
- Produces: `update_storyboard` 接受 `video_prompt_full_ref` → `updates.videoPromptFullRef`；`genVid` 在 `provider==='comfyui'` 时取 `sb.videoPromptFullRef || sb.videoPrompt || ''`，非 comfyui 走 `resolveVideoPromptRefs(sb)`（回归不变，Review Focus #1）；full_ref 空则回退 video_prompt，全空才报错（Review Focus #2）。

- [ ] **Step 1: Write the failing test**

Create `backend/tests/storyboard-full-ref-runtime.test.mjs`:
```js
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const root = new URL('../..', import.meta.url)
const read = (p) => readFileSync(new URL(p, root), 'utf8')

test('language.ts exceptions 加 video_prompt_full_ref 恒英文例外', () => {
  const s = read('src/agents/language.ts')
  assert.match(s, /video_prompt_full_ref/)
  assert.match(s, /MUST ALWAYS be written in English/i)
})

test('update_storyboard 接受 video_prompt_full_ref 并映射 videoPromptFullRef', () => {
  const s = read('src/agents/tools/storyboard-tools.ts')
  assert.match(s, /video_prompt_full_ref: z\.string\(\)\.optional/)
  assert.match(s, /if \(\'video_prompt_full_ref\' in fields\) updates\.videoPromptFullRef = fields\.video_prompt_full_ref/)
})

test('genVid：comfyui 时优先 videoPromptFullRef；非 comfyui 路径仍走 resolveVideoPromptRefs（回归 Review Focus #1）', () => {
  const s = read('../frontend/app/views/drama/episode.vue')
  assert.match(s, /selectedVideoConfig\.value\?\.\s*provider\s*===\s*['"]comfyui['"]/)
  assert.match(s, /videoPromptFullRef \|\| sb\.videoPrompt/)
  assert.match(s, /: resolveVideoPromptRefs\(sb\)/)
})

test('前端只读 full_ref 面板存在', () => {
  const s = read('../frontend/app/views/drama/episode.vue')
  assert.match(s, /video-fullref-panel/)
  assert.match(s, /spellcheck="false"/)
})
```
- [ ] **Step 2: Run test** — Expected: FAIL
  Run: `cd E:/pycharm/huobao-drama && node backend/tests/storyboard-full-ref-runtime.test.mjs`

- [ ] **Step 3: Implement `language.ts` exception**

In `backend/src/agents/language.ts` `buildLanguageDirective`，在 Exceptions 数组最后一条（第 29 行 `'...'` 后、`]` 前）新增一项：
```ts
    '- video_prompt_full_ref (the model-facing ComfyUI/MiniMax bridge prompt) MUST ALWAYS be written in English, regardless of session language and regardless of any skill saying "只输出中文" / "output must be Chinese".',
```

- [ ] **Step 4: Implement `update_storyboard`**

`backend/src/agents/tools/storyboard-tools.ts`：
- `inputSchema`：第 358 行 `video_prompt: z.string().optional(),` 后加
```ts
    video_prompt_full_ref: z.string().optional(),
```
- `execute`：第 419 行 `if ('video_prompt' in fields) updates.videoPrompt = fields.video_prompt` 后加
```ts
    if ('video_prompt_full_ref' in fields) updates.videoPromptFullRef = fields.video_prompt_full_ref
```

- [ ] **Step 5: Implement `genVid`（comfyui 优先 full_ref）**

`frontend/app/views/drama/episode.vue` `genVid`（第 3262 行）把 `prompt: resolveVideoPromptRefs(sb),` 改为
```ts
    prompt: selectedVideoConfig.value?.provider === 'comfyui'
      ? (sb.videoPromptFullRef || sb.videoPrompt || '')
      : resolveVideoPromptRefs(sb),
```
（非 comfyui 路径保持 `resolveVideoPromptRefs` 中文字面不变；全空时后续 `if (!params.prompt && !referenceImages.length)` 仍会报 `needRefOrPrompt`。）

- [ ] **Step 6: 前端只读 full_ref 面板**

`frontend/app/views/drama/episode.vue` 视频提示词区：第 696 行 `<section class="video-inspector-section">` 内的 `<MentionTextarea .../>` 闭合 `</section>`（第 698 行）后，新建一个 `</section>` 同层插入：
```vue
                  <section class="video-inspector-section video-fullref-panel" v-if="selectedSb.videoPromptFullRef || selectedSb.video_prompt_full_ref">
                    <div class="video-fullref-head">
                      <span class="video-inspector-label video-inspector-label-hero">ComfyUI Full-Reference（只读）</span>
                    </div>
                    <pre class="video-fullref-text" spellcheck="false">{{ selectedSb.videoPromptFullRef || selectedSb.video_prompt_full_ref }}</pre>
                    <button type="button" class="btn btn-sm video-fullref-copy" @click="copyText(selectedSb.videoPromptFullRef || selectedSb.video_prompt_full_ref)">{{ t('common.copy') }}</button>
                  </section>
```
JS：新增通用复制辅助（同文件 `copyAssetFinalPrompt` 风格）：
```ts
async function copyText(value) {
  if (!value) return
  try {
    await navigator.clipboard.writeText(value)
    toast.success(t('episode.asset.promptCopied'))
  } catch {
    toast.error(t('episode.asset.copyFailed'))
  }
}
```
CSS（`<style scoped>` 末尾）：
```css
.video-fullref-panel { margin-top: 12px; }
.video-fullref-head { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; font-size: 12px; color: var(--text-dim); }
.video-fullref-text { font-family: var(--font-mono); font-size: 12px; line-height: 1.5; white-space: pre-wrap; word-break: break-word; color: var(--text-dim); background: var(--bg2); border: 1px solid var(--border); border-radius: 8px; padding: 10px; margin: 0 0 6px; max-height: 280px; overflow: auto; }
.video-fullref-copy { margin-left: auto; }
```

- [ ] **Step 7: Run test** — Expected: PASS
- [ ] **Step 8: 人工跑** — 起 dev，跑一集 prompt_generator，确认 `video_prompt_full_ref` 落库为六段式英文（即使会话语言 zh）；UI 只读面板展示正确；切换非 ComfyUI 厂商（Minimax/火山/Aliyun）再生成，确认仍用中文 `video_prompt`（Review Focus #1 回归）。

- [ ] **Step 9: Commit**
```bash
cd E:/pycharm/huobao-drama
git add backend/src/agents/language.ts backend/src/agents/tools/storyboard-tools.ts \
  frontend/app/views/drama/episode.vue backend/tests/storyboard-full-ref-runtime.test.mjs
git commit -m "feat(agent/ui): video_prompt_full_ref 语言例外、工具接收、comfyui 优先与只读面板
Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 4: P1 — bridge `ref_scale` 1.0→2.0（外部）+ 后端 adapter 传 ref_scale

**Files:**
- Modify: `E:\AI\ComfyUI\custom_nodes\ComfyUI-OpenAI-Bridge\__init__.py`（**仓库外**）— `_wf_video`（第 60、81 行）+ `videos()` 路由（第 205–222 行）+ `_selftest`（第 254–273 行）
- Modify: `backend/src/services/adapters/comfyui-video.ts` — `buildGenerateRequest` body（第 117–124 行）
- Test: `backend/tests/comfyui-ref-scale.test.mjs`（结构测试；bridge selftest 本地直跑验证）

**Interfaces:**
- Consumes: 无（bridge 自测自带 `_selftest`）。
- Produces: bridge 视频 workflow `node["302"]["inputs"]["ref_scale"] == 2.0`（默认，body 传 `ref_scale` 可覆盖）；adapter body 恒含 `ref_scale: 2.0`。

- [ ] **Step 1: Write the failing test**

Create `backend/tests/comfyui-ref-scale.test.mjs`:
```js
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const bridge = readFileSync('E:/AI/ComfyUI/custom_nodes/ComfyUI-OpenAI-Bridge/__init__.py', 'utf8')
const adapter = readFileSync('../src/services/adapters/comfyui-video.ts', 'utf8')

test('bridge _wf_video 默认 ref_scale=2.0 且路由可覆盖', () => {
  assert.match(bridge, /def _wf_video\(prompt, w, h, length, refs, seed, prefix, ref_scale=2\.0\):/)
  assert.match(bridge, /"ref_scale": ref_scale/)
  assert.match(bridge, /ref_scale = b\.get\("ref_scale"\) or 2\.0/)
})

test('bridge _selftest 断言 ref_scale==2.0', () => {
  assert.match(bridge, /v\["302"\]\["inputs"\]\["ref_scale"\]\s*==\s*2\.0/)
})

test('adapter body 含 ref_scale: 2.0', () => {
  assert.match(adapter, /ref_scale:\s*2\.0/)
})
```
- [ ] **Step 2: Run test** — Expected: FAIL
  Run: `cd E:/pycharm/huobao-drama && node backend/tests/comfyui-ref-scale.test.mjs`

- [ ] **Step 3: Modify bridge `__init__.py`**

1. 第 60 行函数签名改为：
```python
def _wf_video(prompt, w, h, length, refs, seed, prefix, ref_scale=2.0):
```
2. 第 81 行 `"ref_scale": 1.0}}` 改为 `"ref_scale": ref_scale}}`
3. `videos()` 路由：第 213 行 `seed = ...` 后加一行
```python
        ref_scale = b.get("ref_scale") or 2.0
```
   第 214–215 行 `_start` 调用改（`seed,` 后插 `ref_scale,`）：
```python
        job = await _start("video", _wf_video(prompt, w, h, int(b.get("length", 124)), refs, seed,
                                              ref_scale, "openai/h3_" + uuid.uuid4().hex[:8]),
                           "openai/h3_", ".mp4", 5400)
```
4. `_selftest`：第 260 行断言区（`assert v["302"]["inputs"]["ref_image_0"] == ["300", 0]` 后）加
```python
    assert v["302"]["inputs"]["ref_scale"] == 2.0
```
- 改完**必须重启 ComfyUI**（`python main.py --port 6006`，注意单实例锁）才生效；进程内 `JOBS` 丢、mp4 保留。

- [ ] **Step 4: Run bridge selftest（本地直跑，无需 ComfyUI）**

Run: `python E:/AI/ComfyUI/custom_nodes/ComfyUI-OpenAI-Bridge/__init__.py`
Expected: `selftest OK: image=11 nodes video=14 nodes` 类输出（node 数随实现略变），无 AssertionError。

- [ ] **Step 5: Implement adapter**

`backend/src/services/adapters/comfyui-video.ts` `buildGenerateRequest` body（第 117–124 行）在 `seed` 前加一行：
```ts
        size: DEFAULT_SIZE,
        length: DEFAULT_LENGTH,
        images,
        ref_scale: 2.0,
        seed: record.seed ?? undefined,
```
（body 顺序无要求；adapter 恒传 2.0，bridge 端 `b.get("ref_scale") or 2.0` 同源兜底。）

- [ ] **Step 6: Run test** — Expected: PASS
- [ ] **Step 7: Commit**
```bash
cd E:/pycharm/huobao-drama
git add backend/tests/comfyui-ref-scale.test.mjs backend/src/services/adapters/comfyui-video.ts
git commit -m "feat(video): ref_scale 1.0→2.0（bridge 默认可覆盖，adapter 恒传 2.0）
Co-Authored-By: Claude Code <noreply@anthropic.com>"
```
> 注意：bridge 文件在 git 仓库外（自测通过即完成本任务）；仍要手动重启 ComfyUI 再跑一次真实生成验证（见 Task 5 Step 9 的验证点）。

---

### Task 5: P3 — fl2va 首帧锚定可选开关（bridge 新链 + adapter 首帧 staging + 前端 checkbox）

**Files:**
- Modify: `E:\AI\ComfyUI\custom_nodes\ComfyUI-OpenAI-Bridge\__init__.py`（**仓库外**）— 新增 `_wf_fl2va` + `videos()` 路由 `first_frame` 分支 + `_selftest` 补断言
- Modify: `backend/src/services/adapters/comfyui-video.ts` — `buildGenerateRequest`：`record.firstFrameUrl` 存在时 staging 首帧 + body 条件加 `first_frame: <fname>`
- Modify: `frontend/app/views/drama/episode.vue` — 视频参数区加 checkbox（`useFl2va` ref，非 comfyui 禁用）+ `genVid` 开启且场景有 `image_url` 时传 `first_frame_url`
- Test: `backend/tests/comfyui-fl2va.test.mjs`

**Interfaces:**
- Consumes: Task 4 的 bridge 结构（`_start` 5 参签名 `(kind, wf, prefix, ext, timeout)`）；`record.firstFrameUrl`（`GenerateVideoParams` 已有，`generation.ts` 第 46 行）；`scenes.value` / `sb.scene_id`。
- Produces: bridge `_wf_fl2va(prompt, w, h, length, first_frame, seed, prefix)`（**7 参，末参是 `prefix` 字符串、非 `ref_scale`** — `JZL_MiniMaxH3ImageToVideoDual` 输入无 `ref_scale`，只有 `upscale_scale`；单 KSampler 链、`upscale_scale=1.0` 单采、`first_frame` 接线、无悬空连线）；adapter 在 `firstFrameUrl` 时 body 含 `first_frame: <fname>`；`videos()` 路由 body 有 `first_frame` 时走 fl2va 链、`h3_fl2va_` 前缀。

- [ ] **Step 1: Write the failing test**

Create `backend/tests/comfyui-fl2va.test.mjs`:
```js
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const bridge = readFileSync('E:/AI/ComfyUI/custom_nodes/ComfyUI-OpenAI-Bridge/__init__.py', 'utf8')
const adapter = readFileSync('../src/services/adapters/comfyui-video.ts', 'utf8')

test('bridge 新增 _wf_fl2va（fl2va 节点 + first_frame 接线 + upscale_scale=1.0）', () => {
  assert.match(bridge, /def _wf_fl2va\(/)
  assert.match(bridge, /"class_type":\s*"JZL_MiniMaxH3ImageToVideoDual"/)
  assert.match(bridge, /"first_frame":\s*\["300", 0\]/)
  assert.match(bridge, /"upscale_scale":\s*1\.0/)
})

test('videos 路由：body 有 first_frame 时用 _wf_fl2va', () => {
  assert.match(bridge, /first_frame = b\.get\("first_frame"\) or None/)
  assert.match(bridge, /_wf_fl2va\(prompt, w, h, int\(b\.get\("length",\s*124\)\), first_frame/)
  assert.match(bridge, /h3_fl2va_/)
})

test('_selftest 覆盖 fl2va 悬空连线检查', () => {
  assert.match(bridge, /f = _wf_fl2va\("a cat", 576, 320, 124/)
  assert.match(bridge, /f\["302"\]\["inputs"\]\["upscale_scale"\]\s*==\s*1\.0/)
  assert.match(bridge, /for g in \(a, v, f\):/)
})

test('adapter：firstFrameUrl 时 staging 首帧并传 first_frame', () => {
  assert.match(adapter, /record\.firstFrameUrl/)
  assert.match(adapter, /first_frame:\s*firstFrameFile/)
})
```
- [ ] **Step 2: Run test** — Expected: FAIL
  Run: `cd E:/pycharm/huobao-drama && node backend/tests/comfyui-fl2va.test.mjs`

- [ ] **Step 3: bridge 新增 `_wf_fl2va`**

在 `__init__.py` `_self_post`（第 102 行）之前、`_wf_video` 第 99 行 `return g` 后插入：
```python
def _wf_fl2va(prompt, w, h, length, first_frame, seed, prefix):
    """MiniMax-H3 fl2va（首帧锚定），单 KSampler 链，upscale_scale=1.0（单采）。
    JZL_MiniMaxH3ImageToVideoDual：输入 (clip, vae, prompt, width, height, length, first_frame?, last_frame?, upscale_scale)
    ——无 ref_scale、无 ref_image 槽位；输出 (positive, latent, positive_2)。
    首帧 = 场景宽镜头图（LoadImage node 300）；last_frame 留空=纯首帧；upscale_scale=1.0 单采。
    """
    g = {
        "1": {"class_type": "UNETLoader", "inputs": {
            "unet_name": "minimax_h3_fl2va_pruned_int8_convrot.safetensors", "weight_dtype": "default"}},
        "2": {"class_type": "LoraLoaderModelOnly", "inputs": {
            "model": ["1", 0],
            "lora_name": "minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16.safetensors",
            "strength_model": 1.0}},
        "97": {"class_type": "ModelAttentionBackend", "inputs": {
            "model": ["2", 0], "attention": "comfy kitchen attention"}},
        "3": {"class_type": "CLIPLoader", "inputs": {
            "clip_name": "qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors", "type": "minimax"}},
        "4": {"class_type": "VAELoader", "inputs": {"vae_name": "minimax_h3_video_vae_int8_convrot.safetensors"}},
        "5": {"class_type": "VAELoader", "inputs": {"vae_name": "minimax_h3_audio_vae_fp32.safetensors"}},
        "300": {"class_type": "LoadImage", "inputs": {"image": first_frame}},
        "302": {"class_type": "JZL_MiniMaxH3ImageToVideoDual", "inputs": {
            "clip": ["3", 0], "vae": ["4", 0],
            "prompt": prompt, "width": w, "height": h, "length": length,
            "first_frame": ["300", 0],
            "upscale_scale": 1.0}},
        "303": {"class_type": "BasicGuider", "inputs": {"model": ["97", 0], "conditioning": ["302", 0]}},
        "304": {"class_type": "RandomNoise", "inputs": {"noise_seed": seed}},
        "305": {"class_type": "KSamplerSelect", "inputs": {"sampler_name": "res_multistep"}},
        "306": {"class_type": "BasicScheduler", "inputs": {
            "model": ["97", 0], "scheduler": "simple", "steps": 4, "denoise": 1.0}},
        "307": {"class_type": "SamplerCustomAdvanced", "inputs": {
            "noise": ["304", 0], "guider": ["303", 0], "sampler": ["305", 0],
            "sigmas": ["306", 0], "latent_image": ["302", 1]}},
        "308": {"class_type": "VAEDecode", "inputs": {"samples": ["307", 0], "vae": ["4", 0]}},
        "309": {"class_type": "VAEDecodeAudio", "inputs": {"samples": ["307", 0], "vae": ["5", 0]}},
        "310": {"class_type": "CreateVideo", "inputs": {"images": ["308", 0], "audio": ["309", 0], "fps": 24.0}},
        "311": {"class_type": "SaveVideo", "inputs": {
            "video": ["310", 0], "filename_prefix": prefix, "format": "auto"}}
    }
    return g
```
（ponytail: 模型/采样链照抄 `_wf_video` 的 1/2/97/3/4/5/303-311 节点，只换 302 为 fl2va 节点、加 300 首帧 LoadImage；audio 链保留，与 ref2v 同链路。不引入 `kind` 字段区分——`prefix` 前缀即类型标记。）

- [ ] **Step 4: bridge `videos()` 路由分支 + `_selftest`**

1. 路由（第 213 行 `seed = ...` 后，在 Task 4 的 `ref_scale = ...` 行后）加
```python
        first_frame = b.get("first_frame") or None
```
   第 214–216 行 `_start` 调用改为条件分支：
```python
        if first_frame:
            job = await _start("video", _wf_fl2va(prompt, w, h, int(b.get("length", 124)),
                                              first_frame, seed,
                                              "openai/h3_fl2va_" + uuid.uuid4().hex[:8]),
                               "openai/h3_fl2va_", ".mp4", 5400)
        else:
            job = await _start("video", _wf_video(prompt, w, h, int(b.get("length", 124)), refs, seed,
                                              ref_scale, "openai/h3_" + uuid.uuid4().hex[:8]),
                               "openai/h3_", ".mp4", 5400)
```
2. `_selftest`（Task 4 改后）：第 257 行 `v = _wf_video(...)` 后加
```python
    f = _wf_fl2va("a cat", 576, 320, 124, "qingyi.jpg", 7, "openai/h3fl2va_test")
```
   断言区（`assert v[...]` 后）加
```python
    assert f["302"]["class_type"] == "JZL_MiniMaxH3ImageToVideoDual"
    assert f["302"]["inputs"]["first_frame"] == ["300", 0]
    assert f["302"]["inputs"]["upscale_scale"] == 1.0
```
   悬空连线检查的元组（第 262 行）从 `for g in (a, v):` 改为 `for g in (a, v, f):`
   结尾 print（第 269 行）改为
```python
    print("selftest OK: image=%d nodes ref2v=%d nodes fl2va=%d nodes" % (len(a), len(v), len(f)))
```
   （注：`_wf_fl2va` 末参是 `prefix`（字符串文件名前缀，**非 ref_scale**——fl2va 节点无 `ref_scale` 输入）。selftest 与路由都须按 7 参（`prompt, w, h, length, first_frame, seed, prefix`）一致调用；只有 ref2v 分支带 `ref_scale`。）

- [ ] **Step 5: Run bridge selftest（本地直跑）**

Run: `python E:/AI/ComfyUI/custom_nodes/ComfyUI-OpenAI-Bridge/__init__.py`
Expected: `selftest OK: image=11 nodes ref2v=14 nodes fl2va=14 nodes`（node 数随实现略变），无 AssertionError（Review Focus #5：改前 `_selftest` 因断言缺失会失败 → 本任务 Step 1 测试失败；改后通过）。改后**必须重启 ComfyUI**。

- [ ] **Step 6: adapter 支持 `first_frame`**

`backend/src/services/adapters/comfyui-video.ts` `buildGenerateRequest`：
- 第 107 行 staging 参考图后加
```ts
    // ponytail: 首帧只 staging 一张；firstFrameUrl 缺失则不 staging、body 无 first_frame → bridge 回 ref2v
    const firstFrame = record.firstFrameUrl
    const firstFrameFile = firstFrame
      ? (await stageReferenceImages([firstFrame], inputDir))[0] || undefined
      : undefined
```
- body（第 117–124 行）加条件键
```ts
      body: {
        prompt,
        model: (record.model || config.model || 'minimax-h3-ref2v') || 'minimax-h3-ref2v',
        size: DEFAULT_SIZE,
        length: DEFAULT_LENGTH,
        images,
        ref_scale: 2.0,
        first_frame: firstFrameFile,
        seed: record.seed ?? undefined,
      },
```
（`first_frame` 为 `undefined` 时 JSON 序列化被丢弃 → bridge `b.get("first_frame") or None` 为 None → 回 ref2v。）

- [ ] **Step 7: 前端 checkbox + `genVid`**

`episode.vue`：
1. 第 2111 行 `selectedVideoConfig` 附近加 ref
```ts
// ponytail: fl2va 实验性档位，仅当 provider==='comfyui' 可用；默认关闭、用户手开
const useFl2va = ref(false)
```
2. 视频参数区（`video-params-card` 第 804–816 行，`video-param-hint` 第 816 行后）插入一行
```vue
                    <div class="video-param-row video-fl2va-row" v-if="selectedVideoConfig">
                      <label class="video-fl2va-check">
                        <input
                          type="checkbox"
                          :checked="useFl2va"
                          :disabled="selectedVideoConfig.provider !== 'comfyui'"
                          @change="useFl2va = $event.target.checked"
                        />
                        <span>
                          首帧锚定(fl2va)
                          <small v-if="useFl2va">用场景宽镜头图作首帧锁定构图（单镜头强锁定，多镜头未验证）</small>
                        </span>
                      </label>
                    </div>
```
   CSS 追加
```css
.video-fl2va-row { align-items: center; gap: 8px; }
.video-fl2va-check { display: flex; align-items: flex-start; gap: 6px; font-size: 12px; color: var(--text-dim); cursor: pointer; }
.video-fl2va-check input:disabled + span { opacity: 0.5; }
```
3. `genVid`（第 3268 行 `reference_image_urls: referenceImages,` 后）加
```ts
    first_frame_url: useFl2va.value && selectedVideoConfig.value?.provider === 'comfyui'
      ? (scenes.value.find(s => s.id === selectedSb.scene_id)?.image_url || '')
      : undefined,
```
   （ponytail：场景无 `image_url` 时传 `''` → `tasks.ts` `first_frame_url: body.first_frame_url ?? ...` 为 `''` → adapter 空值不 staging → bridge 回 ref2v，安全。）

- [ ] **Step 8: Run test** — Expected: PASS
- [ ] **Step 9: 验证点** — 重启 ComfyUI（6006，注意单实例锁）后：关 checkbox 跑一次 ref2v；开 checkbox（场景已有宽镜头图）跑一次 fl2va，确认首帧为场景图、无悬空连线、输出 mp4。

- [ ] **Step 10: Commit**
```bash
cd E:/pycharm/huobao-drama
git add backend/tests/comfyui-fl2va.test.mjs backend/src/services/adapters/comfyui-video.ts \
  frontend/app/views/drama/episode.vue
git commit -m "feat(video): fl2va 首帧锚定可选开关（bridge 新链 + adapter 首帧 staging + 前端 checkbox）
Co-Authored-By: Claude Code <noreply@anthropic.com>"
```
---

### Task 6: A — 场景九宫格（`scenes.grid_prompt`/`grid_image_url` + 工具 + 生成路由 + 参考槽优先）

**Files:**
- Modify: `backend/src/db/schema.ts` — `scenes` 表（第 90–106 行，`imageUrl: text('image_url'),` 第 100 行后）
- Modify: `backend/src/db/sqlite-schema.ts` — scenes DDL（第 68–84 行，`image_url TEXT,` 第 78 行后）+ `initSqliteSchema`（第 377 行）幂等加列
- Modify: `backend/src/agents/tools/image-prompt-tools.ts` — 新增 `saveSceneGridPrompt` 工具（`saveSceneFinalPrompt` 第 98–125 行后）+ export（第 181–188 行对象）
- Modify: `backend/workspace/skills/prompt-generator/scene-prompt/SKILL.md` + `.en.md`/`.ja.md`/`.ko.md` — 新增九宫格节
- Modify: `backend/workspace/prompts/prompt_generator.md`（+ `.en/.ja/.ko`）— 场景步骤 3 改双工具调用
- Modify: `backend/src/routes/scenes.ts` — 新增 `POST /:id/generate-grid-image`（`generate-image` 路由第 67–98 行后、`generate-prompt` 第 101 行前）
- Modify: `backend/src/services/generation.ts` — `GenerateImageParams` 加 `sceneGrid?`（第 24–37 行）；`generateImage` `createTask` params 透传（第 69–81 行）；`writeBackImageAssets`（第 443–461 行）按 `sceneGrid` 回写 `gridImageUrl`
- Modify: `frontend/app/composables/useApi.ts` — `sceneAPI.generateGridImage`（第 75–81 行 `sceneAPI` 对象）
- Modify: `frontend/app/views/drama/episode.vue` — `getShotReferenceImages`（第 3036–3053 行）场景槽优先九宫格；资产详情弹窗加"生成九宫格"按钮 + 预览
- Test: `backend/tests/scene-grid.test.mjs`（新建）

**Interfaces:**
- Consumes: Task 1 的 `addColumnIfMissing(sqlite, table, column)` 幂等加列助手（**已定义**，不要重复定义）；`generateImage({ sceneId, dramaId, prompt, size, sceneGrid, model, configId })`（`GenerateImageParams` 扩展）；`getDramaStylePrompt(dramaId)`；`stageReferenceImages` 同静态路径机制（`downloadFile` 返回 `static/xxx`）。
- Produces: `scenes.grid_prompt`/`grid_image_url` 列；`saveSceneGridPrompt` 工具（存 `gridPrompt`，自动拼风格前缀）；`POST /scenes/:id/generate-grid-image`（固定 1536x1536、无人物）；`sceneAPI.generateGridImage(id, epId, ...)`；`getShotReferenceImages` 场景槽 = `gridImageUrl || grid_image_url || image_url || imageUrl`。

- [ ] **Step 1: Write the failing test**

Create `backend/tests/scene-grid.test.mjs`:
```js
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const root = new URL('../..', import.meta.url)
const read = (p) => readFileSync(new URL(p, root), 'utf8')

test('scenes 新增 grid_prompt/grid_image_url（Drizzle + DDL）', () => {
  const s = read('src/db/schema.ts')
  assert.match(s, /gridPrompt:\s*text\('grid_prompt'\)/)
  assert.match(s, /gridImageUrl:\s*text\('grid_image_url'\)/)
  const ddl = read('src/db/sqlite-schema.ts')
  assert.match(ddl, /grid_prompt\s+TEXT/)
  assert.match(ddl, /grid_image_url\s+TEXT/)
})

test('sqlite-schema 幂等加列 calls scenes.grid_prompt/grid_image_url（复用 Task 1 助手）', () => {
  const s = read('src/db/sqlite-schema.ts')
  assert.match(s, /function addColumnIfMissing/)
  assert.match(s, /addColumnIfMissing\(sqlite, 'scenes', 'grid_prompt'\)/)
  assert.match(s, /addColumnIfMissing\(sqlite, 'scenes', 'grid_image_url'\)/)
})

test('image-prompt-tools 新增 save_scene_grid_prompt（存 gridPrompt，拼风格）', () => {
  const s = read('src/agents/tools/image-prompt-tools.ts')
  assert.match(s, /id:\s*\'save_scene_grid_prompt\'\)/)
  assert.match(s, /gridPrompt:\s*finalPrompt/)
})

test('scenes 路由新增 POST /:id/generate-grid-image（1536x1536、sceneGrid）', () => {
  const s = read('src/routes/scenes.ts')
  assert.match(s, /"\/:id\/generate-grid-image"/)
  assert.match(s, /sceneGrid:\s*true/)
  assert.match(s, /"1536x1536"/)
})

test('generation: sceneGrid 字段 + writeBack 回写 gridImageUrl', () => {
  const s = read('src/services/generation.ts')
  assert.match(s, /sceneGrid\?:\s*boolean/)
  assert.match(s, /sceneGrid \?\s*\{ gridImageUrl:\s*localPath \} : \{ imageUrl:\s*localPath \})/)
})
```
- [ ] **Step 2: Run test** — Expected: FAIL
  Run: `cd E:/pycharm/huobao-drama && node backend/tests/scene-grid.test.mjs`

- [ ] **Step 3: DB 列（schema + DDL + 幂等加列）**

1. `schema.ts`：scenes 表第 100 行 `imageUrl: text('image_url'),` 后加
```ts
  gridPrompt: text('grid_prompt'),
  gridImageUrl: text('grid_image_url'),
```
2. `sqlite-schema.ts`：scenes DDL（第 68–84 行）第 78 行 `image_url TEXT,` 后加
```sql
    grid_prompt TEXT,
    grid_image_url TEXT,
```
3. `initSqliteSchema`（第 377 行）内：Task 1 已在 `for` 循环（第 378–380 行）后加 `addColumnIfMissing(sqlite, 'storyboards', 'video_prompt_full_ref')`；在其下**复用同一助手**补两行（不要重新定义函数）：
```ts
  addColumnIfMissing(sqlite, 'storyboards', 'video_prompt_full_ref')
  addColumnIfMissing(sqlite, 'scenes', 'grid_prompt')
  addColumnIfMissing(sqlite, 'scenes', 'grid_image_url')
```
（`Database` 类型已随 Task 1 引入，`Database` from better-sqlite3；ponytail：只加 `TEXT` 无默认值，存量行 NULL，前端 `||` 兜底。新库 CREATE TABLE 已带列→此处 no-op；旧库补列。）

- [ ] **Step 4: `generation.ts` 三处改动**

1. `GenerateImageParams`（第 24–37 行）在 `configId?: number` 后加
```ts
  sceneGrid?: boolean
```
2. `generateImage` `createTask('image', ...)` 第参 `params` 对象（第 69–81 行，`size`/`frameType`/`referenceImages` 旁）加
```ts
    sceneGrid: params.sceneGrid,
```
3. `writeBackImageAssets`（第 455–457 行）`if (record.sceneId)` 块（现有 `params = parseTaskParams(record.params)` 在 444 行）改为：
```ts
  if (record.sceneId) {
    await db.update(schema.scenes).set({
      ...(params.sceneGrid ? { gridImageUrl: localPath } : { imageUrl: localPath }),
      status: 'completed', updatedAt: now(),
    }).where(eq(schema.scenes.id, record.sceneId))
  }
```
（ponytail：同一场景 `status` 共享；宽镜头完成置 `completed`，九宫格再写 `gridImageUrl` 不冲突。）

- [ ] **Step 5: `save_scene_grid_prompt` 工具**

`image-prompt-tools.ts`（`saveSceneFinalPrompt` 第 125 行 `})` 后）新增：
```ts
const saveSceneGridPrompt = createTool({
  id: 'save_scene_grid_prompt',
  description: '保存为场景创作的九宫格（3x3 多角度）最终提示词。项目视觉风格会由工具自动拼接，prompt 参数中不要包含风格词。',
  inputSchema: z.object({
    scene_id: z.number(),
    prompt: z.string().describe('场景九宫格最终提示词（3x3 固定 9 视角，无人物；模板结构/标签恒英文，语言跟随会话指令，不含风格词）'),
  }),
  execute: async ({ scene_id, prompt }, context) => {
    const dramaId = getDramaId(context?.requestContext)
    if (!dramaId) return { error: 'Missing dramaId in request context' }
    const [s] = await db.select().from(schema.scenes)
      .where(eq(schema.scenes.id, scene_id))
    if (!s) return { error: 'Scene not found' }

    const stylePrompt = await getDramaStylePrompt(dramaId)
    const finalPrompt = stylePrompt ? `${stylePrompt}, ${prompt}` : prompt
    await db.update(schema.scenes).set({
      gridPrompt: finalPrompt,
      updatedAt: now(),
    }).where(eq(schema.scenes.id, scene_id))

    return {
      scene_id: s.id,
      location: s.location,
      saved: true,
      grid_prompt: finalPrompt,
    }
  },
})
```
export 对象（第 181–188 行）加 `saveSceneGridPrompt,`（在 `readProps` 前或任意位置）。
语言例外：九宫格模板恒英文，**靠在 skill 节内规定**（同 Task 3 思路，`language.ts` 不动，避免波及全场景）；ponytail：只补 skill 声明。

- [ ] **Step 6: 新增路由 `POST /scenes/:id/generate-grid-image`**

`scenes.ts`（`generate-image` 路由第 98 行 `})` 后、`generate-prompt` 第 100 行注释前）新增：
```ts
// POST /scenes/:id/generate-grid-image — 生成场景九宫格（3x3 多角度，1536x1536，无人物）
app.post('/:id/generate-grid-image', async (c) => {
  const id = Number(c.req.param('id'))
  const body = await c.req.json()
  const [scene] = await db.select().from(schema.scenes).where(eq(schema.scenes.id, id))
  if (!scene) return badRequest(c, '场景不存在')
  if (!body.episode_id) return badRequest(c, 'episode_id 必填')
  const [ep] = await db.select().from(schema.episodes).where(eq(schema.episodes.id, Number(body.episode_id)))
  if (!ep) return badRequest(c, '剧集不存在')

  const stylePrompt = await getDramaStylePrompt(scene.dramaId)
  // ponytail: 九宫格 prompt 用 gridPrompt（若 agent 已产）否则固定 9 视角模板（恒英文、无人物）；风格前缀由 getDramaStylePrompt 拼
  const gridBase = scene.gridPrompt || ''
  const fallback = '3x3 grid, 9 views of the SAME ' + (scene.location || '') + ', NO PEOPLE: ' +
    "top-left front view; top-middle left 45-degree view; top-right right 45-degree view; " +
    "middle-left back view; center bird's-eye overhead; middle-right low floor-level view; " +
    "bottom-left left wall perspective; bottom-right right wall perspective; " +
    "bottom-center close-up of main prop or entrance; consistent lighting, style and no people in any panel"
  const prompt = [
    stylePrompt || '',
    gridBase || fallback,
    scene.prompt || '',
    scene.lighting || '',
  ].filter(Boolean).join(', ')
  try {
    logTaskStart('SceneImage', 'grid-generate', { sceneId: id, episodeId: ep.id, dramaId: scene.dramaId, location: scene.location })
    await db.update(schema.scenes).set({ status: 'processing', updatedAt: now() }).where(eq(schema.scenes.id, id))
    const genId = await generateImage({
      sceneId: id,
      dramaId: scene.dramaId,
      prompt,
      size: '1536x1536',
      sceneGrid: true,
      model: body.model,
      configId: body.config_id ?? ep.imageConfigId ?? undefined,
    })
    logTaskSuccess('SceneImage', 'grid-generate', { sceneId: id, generationId: genId })
    return success(c, { image_generation_id: genId })
  } catch (err: any) {
    logTaskError('SceneImage', 'grid-generate', { sceneId: id, error: err.message })
    await db.update(schema.scenes).set({ status: 'failed', updatedAt: now() }).where(eq(schema.scenes.id, id))
    return badRequest(c, err.message)
  }
})
```
（ponytail：九宫格固定 1536x1536、无人物，`sceneGrid:true` 使回写 `gridImageUrl`。`gridPrompt` 已存时用它（agent 已调 `save_scene_grid_prompt`）；否则用固定 9 视角 fallback。复用 `generateImage`，`sceneGrid` 决定是否回写 `gridImageUrl` vs `imageUrl`。）

- [ ] **Step 7: `useApi.ts` 加 `sceneAPI.generateGridImage`**

`frontend/app/composables/useApi.ts`（第 80 行 `sceneAPI.generateImage` 后、第 81 行 `}` 前）加：
```ts
  generateGridImage: (id: number, episodeId: number, model?: string, configId?: number, textModel?: string, textConfigId?: number) => api.post(`/scenes/${id}/generate-grid-image`, { episode_id: episodeId, model: model || undefined, config_id: configId || undefined, text_model: textModel || undefined, text_config_id: textConfigId || undefined }),
```

- [ ] **Step 8: 前端 — 参考槽优先 + 生成按钮 + 预览**

`episode.vue`：
1. `getShotReferenceImages`（第 3036–3053 行）第 3048 行场景槽（原 `pushRef(scene?.image_url || scene?.imageUrl)`）改为
```ts
  const scene = getStoryboardScene(sb)
  pushRef(scene?.gridImageUrl || scene?.grid_image_url || scene?.image_url || scene?.imageUrl)
```
（ponytail：九宫格优先，无则回退宽镜头；双空时 `pushRef` 内 `!value` 丢弃，槽位空缺不崩 → Review Focus #4。九宫格是 3x3 合成图，作场景 `<Picture N>` 构图锚点，参考位顺序不变仍=角色→场景→道具。）

2. 资产详情弹窗（footer，约第 1264–1281 行，现有"重新生成场景图"按钮旁）加九宫格生成按钮 + pending 态。新增 ref/函数（仿 `pendingSceneImageIds`/`genSceneImg`）：
```ts
const pendingSceneGridImageIds = ref<number[]>([])
function isPendingSceneGridImage(id) { return pendingSceneGridImageIds.value.includes(id) }
async function genSceneGridImg(id) {
  try {
    if (!isPendingSceneGridImage(id)) pendingSceneGridImageIds.value.push(id)
    await sceneAPI.generateGridImage(id, epId.value, bareModelName(imageModel.value) || undefined,
      ownerConfigId(imageModelOptions.value, imageModel.value), chatModelOverride(), chatConfigId())
    toast.success('九宫格场景图生成中')
    await refresh()
    watchAsyncResult(() => {
      const sc = scenes.value.find(s => s.id === id)
      const done = !!((sc?.gridImageUrl || sc?.grid_image_url) && sc?.status !== 'processing')
      if (done) pendingSceneGridImageIds.value = pendingSceneGridImageIds.value.filter(x => x !== id)
      return done
    }, 36)
  } catch (e) {
    pendingSceneGridImageIds.value = pendingSceneGridImageIds.value.filter(x => x !== id)
    toastError(e)
  }
}
```
   （ponytail：九宫格 prompt 由路由 fallback 保底，无需前置 agent；需 agent 产出时再加 `save_scene_grid_prompt` 触发逻辑，YAGNI。`watchAsyncResult`/`refresh`/`toastError` 为同文件现有。）
   按钮：
```vue
<button v-else-if="assetDetail.type === 'scene'" class="btn btn-sm"
  :disabled="isPendingSceneGridImage(assetDetail.item.id)"
  @click.stop="genSceneGridImg(assetDetail.item.id)">
  <Loader2 v-if="isPendingSceneGridImage(assetDetail.item.id)" :size="11" class="animate-spin" />
  {{ (assetDetail.item.gridImageUrl || assetDetail.item.grid_image_url)
     ? t('episode.asset.regenScene') + ' · 九宫格'
     : t('episode.asset.genScene') + ' · 九宫格' }}
</button>
```
   （`Loader2`/`epId`/`bareModelName`/`ownerConfigId`/`chatModelOverride`/`chatConfigId`/`sceneAPI` 为同文件/模块已有；`t('episode.asset.*')` 沿用现有场景按钮文案键。）

3. 场景预览：资产详情弹窗/场景卡若 `gridImageUrl` 非空，主预览用九宫格（不动原 `assetImageSrc` 逻辑，加一个优先读取）：
```ts
function sceneImageSrc(item) {
  const grid = item?.gridImageUrl || item?.grid_image_url
  const main = item?.imageUrl || item?.image_url
  const raw = grid || main || ''
  if (!raw) return ''
  if (/^https?:\/\//i.test(raw) || raw.startsWith('/')) return raw
  return `/${raw}`
}
```
   场景卡/预览处把 `assetImageSrc(s)` 换为 `sceneImageSrc(s)`（仅场景项；`assetImageSrc` 对角色/道具不动，YAGNI：不加双图切换器，九宫格有则用九宫格）。
   （`thumbOf`/`thumbFallback`/`openImageViewer` 为同文件现有函数，预览缩略沿用原调用，仅 src 来源改 `sceneImageSrc`。）

- [ ] **Step 9: 同步 skills**

`backend/workspace/skills/prompt-generator/scene-prompt/SKILL.md`（及 `.en/.ja/.ko`）新增整节：
- 标题：`## 九宫格场景（grid_prompt / save_scene_grid_prompt）`
- 用途：九宫格是场景 `<Picture N>` 构图锚点，3x3 固定 9 视角、**无人物**、1536x1536
- 模板（与路由 fallback 一致、恒英文）：`3x3 grid, 9 views of the SAME <location>, NO PEOPLE:` + 9 视角固定清单（top-left front / top-middle left45 / top-right right45 / middle-left back / center bird's-eye / middle-right low floor-level / bottom-left left wall / bottom-right right wall / bottom-center close-up of main prop or entrance）+ `consistent lighting, style and no people in any panel`
- 标签：场景行加 `"is a storyboard reference for [Shot N], defining its viewpoint, subject placement, and shot order"`
- 工具：`save_scene_grid_prompt`（`scene_id` + `prompt`，不含风格词）；`.ja/.ko` 说明用对应语言，模板与标签英文不变（ponytail：同 Task 3 语言例外思路，不动 `language.ts`）

`backend/workspace/prompts/prompt_generator.md`（+ `.en/.ja/.ko`）场景步骤 3 改双工具调用：
- 原：`调用 save_scene_final_prompt 保存场景最终提示词`
- 改：`先调用 save_scene_final_prompt（宽镜头固定视角，作 fl2va 首帧来源）保存场景提示词，再调用 save_scene_grid_prompt（3x3 九宫格，无人物，存 grid_prompt）保存九宫格提示词；两工具都只传 scene_id + prompt，不传其他字段`
（ponytail：宽镜头保留作 fl2va 首帧；九宫格为额外构图锚点。后续若弃用宽镜头再删。）

- [ ] **Step 10: Run test** — Expected: PASS
- [ ] **Step 11: Commit**
```bash
cd E:/pycharm/huobao-drama
git add backend/src/db/schema.ts backend/src/db/sqlite-schema.ts \
  backend/src/agents/tools/image-prompt-tools.ts backend/src/routes/scenes.ts \
  backend/src/services/generation.ts backend/tests/scene-grid.test.mjs \
  backend/workspace/skills/prompt-generator/scene-prompt/ \
  backend/workspace/prompts/prompt_generator.md \
  frontend/app/composables/useApi.ts frontend/app/views/drama/episode.vue
git commit -m "feat(scene): 九宫格场景图（grid_prompt/grid_image_url + 生成路由 + 参考槽优先）
Co-Authored-By: Claude Code <noreply@anthropic.com>"
```