import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const root = new URL('..', import.meta.url)
const read = (p) => readFileSync(new URL(p, root), 'utf8')
const episode = () => read('../frontend/app/views/drama/episode.vue')

/**
 * object-fit:cover 下，宽高比 frameAspect 的框，能看到宽高比 imgAspect 的图的横向比例。
 * 框比图窄时按高对齐 → 只露 fa/ia；框比图宽/等高时整幅可见。
 * 左格 object-position:left → 露 [0, visible]；右格 :right → 露 [1-visible, 1]。
 */
const visible = (frameAspect, imgAspect) => Math.min(1, frameAspect / imgAspect)

const SHEET = 1920 / 1080 // 角色形象图 = 一张 16:9 的 sheet（SKILL.md 的固定构图）
const FACE = 3 / 4 // 左格「角色」：正脸特写
const TURN = 1 / 1 // 右格「三视图」：正面 / 90°侧面 / 背面

// 这条是本次改动唯一非平凡的算术：CSS 里那两个 aspect-ratio 是从构图反推的，改错就切歪。
test('角色 sheet 两格的裁切区间自洽（左特写 + 右三视图）', () => {
  const faceEnd = visible(FACE, SHEET)
  const turnStart = 1 - visible(TURN, SHEET)

  // 两格不重叠
  assert.ok(faceEnd <= turnStart, `两格重叠：左到 ${faceEnd}，右从 ${turnStart}`)
  // 中间只该有构图上特写与正面视图之间的留白，超过 3% 说明比例配错、吃掉了一块构图
  assert.ok(turnStart - faceEnd < 0.03, `中间缝隙过大：${turnStart - faceEnd}`)
  // 特写约占左侧四成、三视图自 42% 起 —— 与 SKILL.md「左侧正脸特写 + 右侧并列三视图」一致
  assert.ok(Math.abs(faceEnd - 0.42) < 0.03, `特写占比偏离：${faceEnd}`)
  assert.ok(Math.abs(turnStart - 0.42) < 0.03, `三视图起点偏离：${turnStart}`)
})

test('episode.vue：角色宽图拆两格（宽高判断 + 模板 + CSS 同图分取）', () => {
  const s = episode()
  // 只有横图才拆：手动上传的竖构图拆开会得到两张一样的
  assert.match(s, /const charSheetWide = ref\(false\)/)
  assert.match(s, /el\.naturalWidth > el\.naturalHeight/)
  assert.match(s, /const isCharSheet = computed/)
  // 1017 复跑：这条现在是分支链的**第一**支（`v-if`），不是 `v-else-if` —— 功能没变（横图才拆、两格同图靠 object-position）
  assert.match(s, /v-if="isCharSheet"/)
  // 打开别的资产时复位，避免上一张的宽高结论串到下一张
  assert.match(s, /charSheetWide\.value = false/)
  // 两格取自同一张图，只靠 object-position 区分
  assert.match(s, /asset-detail-media-frame-char/)
  assert.match(s, /asset-detail-media-frame-turn/)
  assert.match(s, /\.asset-detail-media-frame-char img \{\s*\n\s*object-position: left center;/)
  assert.match(s, /\.asset-detail-media-frame-turn img \{\s*\n\s*object-position: right center;/)
  assert.match(s, /\.asset-detail-media-frame-char \{\s*\n\s*aspect-ratio: 3 \/ 4;/)
  assert.match(s, /\.asset-detail-media-frame-turn \{\s*\n\s*aspect-ratio: 1 \/ 1;/)
})

test('i18n：中英日韩都有 charFace / charTurnaround', () => {
  for (const l of ['zh', 'en', 'ja', 'ko']) {
    const j = JSON.parse(read(`../frontend/app/locales/${l}.json`))
    assert.ok(j.episode.asset.charFace, `${l} 缺 charFace`)
    assert.ok(j.episode.asset.charTurnaround, `${l} 缺 charTurnaround`)
  }
})
