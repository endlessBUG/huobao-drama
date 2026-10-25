import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isVideoPromptFullRefFull } from '../src/services/video-prompt-validation.ts'

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
  assert.equal(isVideoPromptFullRefFull(GOOD.replace(/<Subject \d+>/g, 'the subject')), false))
test('missing <Picture> tag fails', () =>
  assert.equal(isVideoPromptFullRefFull(GOOD.replace(/<Picture \d+>/g, 'the image')), false))
test('missing fully_preserved fails', () =>
  assert.equal(isVideoPromptFullRefFull(GOOD.replace(/fully_preserved/g, 'weak_reference')), false))
test('missing <d> dialogue fails', () =>
  assert.equal(isVideoPromptFullRefFull(GOOD.replace(/<d>.*?<\/d>/, '')), false))
test('empty string fails', () => assert.equal(isVideoPromptFullRefFull(''), false))

// 1019 用户「舔脚的镜头放不下人物和脚 可以用镜头平移的方式」：#17 的 [Shot 1] 写的是 `a close-up` +
// `The camera holds a static shot`，却要 A 的嘴从 B 的颈窝走到她脚趾（≈1.6 m 长轴）⇒ 画框装不下来源 + 落点，
// 成片就是「放不下人物和脚 / 舌头脱离脸」（#20 的 `framing only below the waist` + `tongue tip` 同一个病）。
// 判据与「有没有机位移动句」由代码把关（社区口径 = BSAI `mv_lipsync_advanced.py:655`：校验成品、缺词就抛错）。
test('近景里「来源 + 落点」分在身体两头 ⇒ 该 [Shot N] 必须有机位移动句；身体动作里的 tilts 不算', async () => {
  const { needsCameraAlongBodyAxis, hasCameraMove } = await import('../src/services/video-prompts.ts')
  assert.ok(needsCameraAlongBodyAxis('【镜头1】近景：A 的头从 B 左颈窝里抬起、顺着 B 伸出的右腿移到 B 的脚前，俯身含住 B 的脚趾舔'),
    '舔脚这条该被点出来（来源=头、落点=脚、景别=近景）')
  assert.ok(needsCameraAlongBodyAxis('【镜头2】特写：B 露出外阴，A 的舌尖从大阴唇外侧往上舔到阴蒂'), '露点镜同理')
  assert.ok(!needsCameraAlongBodyAxis('【镜头1】全景：两人并排站在窗边说话'), '全景装得下两端，不该要求运镜')
  assert.ok(!needsCameraAlongBodyAxis('【镜头1】近景：A 的右手覆上 B 的左乳，B 仰头闷哼'), '来源与落点都在胸口 = 装得下')
  const fr = 'detailed_description:\n[Shot 1] a close-up. The camera trucks along her body from her neck hollow down to her foot at slow speed.\n' +
    '[Shot 2] The camera holds a static shot as her head tilts back.\noverall_soundscape:\nbed creaks'
  assert.ok(hasCameraMove(fr, 1), '[Shot 1] 有 camera trucks ⇒ 过')
  assert.ok(!hasCameraMove(fr, 2), '[Shot 2] 只有 static + 身体里的 tilts ⇒ 不算机位移动（这条误判会把「固定机位」放过去）')
})
