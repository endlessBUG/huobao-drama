import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const root = new URL('..', import.meta.url)
const read = (path) => readFileSync(new URL(path, root), 'utf8')

test('character image generation uses 16:9 asset size, the user-written prompt, and a layout fallback', () => {
  const source = read('src/routes/characters.ts')

  assert.match(source, /CHARACTER_IMAGE_SIZE = '1920x1080'/)
  assert.match(source, /size: CHARACTER_IMAGE_SIZE/)
  // 用户手写优先：详情页草稿优先（空串也是值），字段缺席才用库里存的
  assert.match(source, /characterImagePrompt\(stylePrompt, typeof body\.prompt === 'string' \? body\.prompt : char\.finalPrompt, char\)/)
  assert.match(source, /characterImagePrompt\(stylePrompt, char\.finalPrompt, char\)/)
  assert.match(source, /\[stylePrompt \|\| '', content, char\.imageUrl \? SHEET_SKELETON_WITH_REF : SHEET_SKELETON_TEXT_ONLY\]\.filter\(Boolean\)\.join\(', '\)/)
  // 框里没写就落到老版式兜底（16:9 定妆照），别让空框只剩风格词
  assert.match(source, /16:9 横版角色定妆照/)
  assert.match(source, /半身角色海报构图/)
  assert.match(source, /正面/)
  // 三视图骨架由生成侧无条件带上（写没写都带）：骨架只在追加处出现，不再挂在空框兜底串里
  assert.match(source, /三张等高全身视图/)
  assert.match(source, /以参考图中的同一人物为准/)
  assert.match(source, /const content = \(userPrompt \|\| ''\)\.trim\(\) \|\| characterFallbackContent\(char\)/)
  assert.doesNotMatch(source, /characterFallbackPrompt\(/)
  // 空字段不拼
  assert.match(source, /\n  \]\.filter\(Boolean\)\.join\(', '\)/)
  // 没有 Agent 代笔，也没有「生成提示词」接口
  assert.doesNotMatch(source, /ensureCharacterFinalPrompt|generate-prompt/)
})
