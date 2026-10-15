import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const root = new URL('..', import.meta.url)
const read = (path) => readFileSync(new URL(path, root), 'utf8')

test('character image generation uses 16:9 asset size and the user-written prompt verbatim, with no fallback', () => {
  const source = read('src/routes/characters.ts')

  assert.match(source, /CHARACTER_IMAGE_SIZE = '1920x1080'/)
  assert.match(source, /size: CHARACTER_IMAGE_SIZE/)
  // 用户手写优先：详情页草稿优先（空串也是值），字段缺席才用库里存的
  assert.match(source, /characterImagePrompt\(stylePrompt, typeof body\.prompt === 'string' \? body\.prompt : char\.finalPrompt, char\)/)
  assert.match(source, /characterImagePrompt\(stylePrompt, char\.finalPrompt, char\)/)
  // 框里写了就原样发（不再追加骨架）；只有空框才回落到默认（风格 + 骨架，见 character-sheet.ts）
  assert.match(source, /return content \|\| characterSheetDefaultPrompt\(stylePrompt, !!char\.localPath\)/)
  // 参考图取用户上传的原图（localPath），不取上一轮产物（imageUrl）—— 否则服装会自我锁死
  assert.match(source, /referenceImages: referenceImageFor\(char\)/)
  assert.match(source, /return char\.localPath \? \[char\.localPath\] : undefined/)
  assert.doesNotMatch(source, /char\.imageUrl \? \[char\.imageUrl\]/)
  // 没写就是空：正文只取用户那段字，不拿 appearance/styling 拼兜底、不让 Agent 代笔
  assert.match(source, /const content = \(userPrompt \|\| ''\)\.trim\(\)\r?\n/)
  assert.doesNotMatch(source, /characterFallbackContent|characterFallbackPrompt\(/)
  assert.doesNotMatch(source, /16:9 横版角色定妆照|半身角色海报构图/)
  // 三视图骨架只在空框时兜底，落在 character-sheet.ts（前端显示的默认值也是这一串，唯一真源）
  const sheet = read('src/services/character-sheet.ts')
  assert.match(sheet, /三张等高全身视图/)
  assert.match(sheet, /以参考图中的同一人物为准/)
  assert.doesNotMatch(source, /三张等高全身视图/)
  assert.doesNotMatch(source, /以参考图中的同一人物为准/)
  // 没有 Agent 代笔，也没有「生成提示词」接口
  assert.doesNotMatch(source, /ensureCharacterFinalPrompt|generate-prompt/)
})
