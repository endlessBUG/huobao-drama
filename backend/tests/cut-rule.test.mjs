import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

// 切镜规则的防漂移测试。同一条规则散落在 4 个来源 × 4 种语言（skills 2 个 + prompts 2 个 + 代码兜底）里，
// 实测已经漂移过一次：全都写成「允许切镜（换景别/角度/对象）」—— 把「换景别」当成了切镜的理由，
// 而 MiniMax H3 官方 §4.2 明确说「只改距离或轻微角度，优先用运镜」。模型照做，成片就是中景/特写来回切。
// 官方出处：huggingface.co/MiniMaxAI/MiniMax-H3/blob/main/docs/VIDEO_PROMPT_WRITING_GUIDE_base_en.md §4.2
//
// 语言变体（SKILL.en/ja/ko.md、prompts/*.en|ja|ko.md）走 readLocalizedSkill 直读磁盘、不进 skills 缓存，
// 改完即生效；但正因如此它们和基础版一样会静默漂移，所以同样在断言范围内。
const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8')

const VIDEO_SKILL = (lang) => `../workspace/skills/prompt-generator/video-prompt/SKILL${lang}.md`
const BREAKER_SKILL = (lang) => `../workspace/skills/storyboard-breaker/SKILL${lang}.md`
const PROMPT_GEN = (lang) => `../workspace/prompts/prompt_generator${lang}.md`
const PROMPT_BREAKER = (lang) => `../workspace/prompts/storyboard_breaker${lang}.md`
const FALLBACK = '../src/agents/index.ts'

const LANGS = ['', '.en', '.ja', '.ko']
const SOURCES = [VIDEO_SKILL, BREAKER_SKILL, PROMPT_GEN, PROMPT_BREAKER]

// 规则必须在「决定切不切」和「怎么写这个切」两侧都在场，缺一侧就是冲突指令。
// 每种语言一套词：准入条件 + 出路（改用运镜）+ 已废弃的旧措辞。
const RULE = {
  '': { info: /新信息/, motion: /运镜/, old: /换景别\/角度\/对象/ },
  '.en': { info: /new information/i, motion: /camera motion/i, old: /change of shot size\/angle\/subject/i },
  '.ja': { info: /新しい情報/, motion: /カメラワーク/, old: /ショットサイズ／アングル／被写体の変更/ },
  '.ko': { info: /새로운 정보/, motion: /카메라 무빙/, old: /화면 크기\/앵글\/대상 변경/ },
}

test('切镜准入：四种语言的每个来源都写了「必须引入新信息 / 只改距离改用运镜」', () => {
  for (const lang of LANGS) {
    const { info, motion } = RULE[lang]
    for (const f of SOURCES) {
      const p = f(lang)
      const src = read(p)
      assert.match(src, info, `${p} 没写切镜必须引入新信息`)
      assert.match(src, motion, `${p} 没写「改用运镜」这条出路`)
    }
  }
})

test('旧的「换景别就切镜」措辞已在四种语言里清除', () => {
  for (const lang of LANGS) {
    const { old } = RULE[lang]
    for (const f of SOURCES) {
      assert.doesNotMatch(read(f(lang)), old, `${f(lang)} 还留着旧措辞`)
    }
  }
})

test('video-prompt SKILL（四语言）收全官方五个切镜动词 + 提醒「切回」不要直译', () => {
  for (const lang of LANGS) {
    const p = VIDEO_SKILL(lang)
    const src = read(p)
    for (const verb of [
      'the camera cuts to',
      'the shot cuts to',
      'the shot transitions to',
      'the shot changes to',
      'the shot switches to',
    ]) {
      assert.ok(src.includes(verb), `${p} 缺官方切镜动词：${verb}`)
    }
    // 「切回」没有官方对应词，必须提醒不要直译
    assert.match(src, /cuts back to/, `${p} 没提醒「切回」不要直译成 cuts back to`)
  }
})

test('video-prompt SKILL（四语言）收全官方 13 类运镜词 + amplitude/speed 两个维度', () => {
  for (const lang of LANGS) {
    const p = VIDEO_SKILL(lang)
    const src = read(p)
    for (const term of ['Pedestal Up', 'Roll Clockwise', 'POV', 'with small amplitude', 'at slow speed']) {
      assert.ok(src.includes(term), `${p} 缺官方运镜词汇：${term}`)
    }
  }
})

test('首镜不带时间戳 / 切点严格递增 / 台词跨切镜用 <scenetrans>（四语言）', () => {
  const NO_TIMESTAMP = {
    '': /\[Shot 1\].{0,20}不带时间戳/,
    '.en': /\[Shot 1\].{0,30}carries no timestamp/,
    '.ja': /\[Shot 1\].{0,30}タイムスタンプを付けない/,
    '.ko': /\[Shot 1\].{0,30}타임스탬프를 붙이지 않습니다/,
  }
  const INCREASING = {
    '': /严格递增/,
    '.en': /strictly increasing/,
    '.ja': /厳密に増加/,
    '.ko': /엄격히 증가/,
  }
  for (const lang of LANGS) {
    const p = VIDEO_SKILL(lang)
    const src = read(p)
    assert.match(src, NO_TIMESTAMP[lang], `${p} 缺「首镜不带时间戳」`)
    assert.match(src, INCREASING[lang], `${p} 缺「切点严格递增」`)
    assert.ok(src.includes('<scenetrans>'), `${p} 缺 <scenetrans>`)
    assert.ok(src.includes('<cutoff>'), `${p} 缺 <cutoff>`)
  }
})

// 代码兜底（DEFAULT_PROMPTS）只在 workspace/prompts/*.md 缺失时生效；和在线版漂移的话，
// 一旦哪天文件丢了就会悄悄退回旧行为。整体比对整段不现实，只锁这条规则的关键短语。
// 兜底只有中文一份（变体走磁盘直读，没有兜底的余地）。
test('代码兜底与在线 prompt 文件保持一致（切镜规则部分）', () => {
  const fallback = read(FALLBACK)
  assert.match(fallback, /切镜有准入条件|切镜必须引入新信息/)
  assert.match(fallback, /只是换景别或轻微角度不要切、改用运镜/)
  assert.doesNotMatch(fallback, RULE[''].old)
})
