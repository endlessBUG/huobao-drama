import { test } from 'node:test'
import assert from 'node:assert/strict'
import { agentsUsingSkill } from '../src/agents/skills.ts'

// 「技能 → Agent」反向映射的防漂移测试。设置页左侧的「全部技能」视图直接吃这个函数的输出
// （GET /api/v1/skills 的 agents 字段），前端不再自己按目录名猜。
//
// 曾经的猜法：`skillId === agentType.replace(/_/g,'-') || startsWith(dir + '/')`，
// 对 character_prompt_optimizer 必然算错 —— 它的技能目录是 prompt-generator/character-prompt，
// 不是 character-prompt-optimizer；更糟的是那个技能会被 prompt-generator 前缀误吞，
// 在设置页显示成「prompt_generator 的技能」。这条测试锁住正确归属。
test('反向映射：目录名与 agent type 不一致时也要算对（character-prompt 那两个）', () => {
  assert.deepEqual(agentsUsingSkill('prompt-generator/character-prompt'), ['character_prompt_optimizer'])
  assert.deepEqual(agentsUsingSkill('prompt-generator/video-prompt'), ['prompt_generator'])
  // 场景优化**不**吃这个技能（1016：SKILL 教的是「带 save_* 工具生成最终提示词」那套，
  // 挂给无工具的优化器实测会把工具调用当正文吐回来）—— 场景优化的规矩内联在它自己的 instructions 里
  assert.deepEqual(agentsUsingSkill('prompt-generator/scene-prompt'), ['prompt_generator'])
  assert.deepEqual(agentsUsingSkill('prompt-generator/prop-prompt'), ['prompt_generator'])
})

test('反向映射：一级技能目录及其子目录都归同一个 Agent（动态发现口径）', () => {
  assert.deepEqual(agentsUsingSkill('storyboard-breaker'), ['storyboard_breaker'])
  assert.deepEqual(agentsUsingSkill('storyboard-breaker/whatever'), ['storyboard_breaker'])
  assert.deepEqual(agentsUsingSkill('extractor'), ['extractor'])
  assert.deepEqual(agentsUsingSkill('script-rewriter'), ['script_rewriter'])
})

test('反向映射：无人引用的技能返回空数组（设置页据此标「未被任何 Agent 使用」）', () => {
  // prompt-generator 的前缀是三个具体技能，不是整个 prompt-generator/ 目录
  assert.deepEqual(agentsUsingSkill('prompt-generator/brand-new'), [])
  assert.deepEqual(agentsUsingSkill('unknown/dir'), [])
})
