import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const root = new URL('..', import.meta.url)
const read = (path) => readFileSync(new URL(path, root), 'utf8')

test('video prompt batch service runs per-shot async agent loop', () => {
  const svc = read('src/services/video-prompts.ts')

  // 默认只处理缺少 video_prompt 的分镜；指定 storyboardIds 时只处理所选（已有提示词也重新生成）
  assert.match(svc, /filter\(sb => !\(sb\.videoPrompt \|\| ''\)\.trim\(\)\)/)
  assert.match(svc, /storyboardIds\?\.length/)
  assert.match(svc, /storyboardIds\.includes\(sb\.id\)/)
  // 运行中不重复启动
  assert.match(svc, /status === 'running'\) return \{ started: false, total: -1 \}/)
  // 逐个分镜调用 prompt_generator，以落库结果判定成败
  assert.match(svc, /mastra\.getAgent\('prompt_generator'\)/)
  assert.match(svc, /read_storyboard_context/)
  assert.match(svc, /update_storyboard/)
  assert.match(svc, /fresh\?\.videoPrompt/)
  // full_ref 必须被要求生成并在 update_storyboard 中回传：
  // 消息只让 agent 出 video_prompt、只传两个键时，落库 video_prompt_full_ref 恒为空
  // （实测：agent 出中文 video_prompt，full_ref 始终 NULL）。
  assert.match(svc, /video_prompt_full_ref/)
  assert.match(svc, /六段式英文全参考/)
  // update_storyboard 回传三键（storyboard_id + video_prompt + video_prompt_full_ref），不是两键
  assert.match(svc, /video_prompt_full_ref[\s\S]*update_storyboard/)
  assert.doesNotMatch(svc, /update_storyboard 参数只传 storyboard_id 和 video_prompt 两个键/)
  // 进度跟踪与文本模型覆盖
  assert.match(svc, /current_storyboard_id/)
  assert.match(svc, /modelOverride: opts\.model/)
})

test('episodes route exposes video prompt batch endpoints', () => {
  const route = read('src/routes/episodes.ts')

  assert.match(route, /app\.post\('\/:id\/generate-video-prompts'/)
  assert.match(route, /app\.get\('\/:id\/video-prompts-status'/)
  assert.match(route, /startVideoPromptBatch\(ep\.id, ep\.dramaId/)
  assert.match(route, /body\.storyboard_ids/)
  assert.match(route, /already_running/)
})
