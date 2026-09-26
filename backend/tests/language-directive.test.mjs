import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildLanguageDirective } from '../src/agents/language.ts'

// Focus 3：full_ref（视频桥侧提示词）恒英文，与会话语言无关。
// 行为断言——直接调用真实函数，而非静态正则源文件文本。
const hasFullRefException = (s) =>
  /video_prompt_full_ref/.test(s) && /MUST ALWAYS be written in English/i.test(s)

test('zh 会话：full_ref 恒英文例外仍可达（Focus 3）', () => {
  const zh = buildLanguageDirective('zh')
  assert(hasFullRefException(zh), `zh 指令缺 full_ref 恒英文例外: ${JSON.stringify(zh)}`)
})

test('en 会话：full_ref 恒英文例外可达（且保留 general 英文指令）', () => {
  const en = buildLanguageDirective('en')
  assert(hasFullRefException(en))
  assert(/Output Language \(HIGHEST PRIORITY\)/.test(en))
})

test('未设置语言（null/undefined，默认中文会话）：full_ref 恒英文例外可达', () => {
  assert(hasFullRefException(buildLanguageDirective(null)))
  assert(hasFullRefException(buildLanguageDirective(undefined)))
})

test('ja/ko 会话：full_ref 恒英文例外可达', () => {
  assert(hasFullRefException(buildLanguageDirective('ja')))
  assert(hasFullRefException(buildLanguageDirective('ko')))
})
