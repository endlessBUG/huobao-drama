import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { repairXmlToolCalls } from '../src/agents/tool-call-repair'

const root = new URL('..', import.meta.url)
const read = (path: string) => readFileSync(new URL(path, root), 'utf8')

const xmlResp = (content: string, finish: string = 'stop') => ({
  choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: finish }],
})

test('XML 文本工具调用被还原为结构化 tool_calls（真实故障样本）', () => {
  const { changed, payload } = repairXmlToolCalls(xmlResp('<tool_call> <function=read_storyboard_context> </function> </tool_call>'))
  assert.equal(changed, true)
  const tc = payload.choices[0].message.tool_calls
  assert.equal(tc.length, 1)
  assert.equal(tc[0].type, 'function')
  assert.equal(tc[0].function.name, 'read_storyboard_context')
  assert.equal(tc[0].function.arguments, '{}')
  assert.equal(payload.choices[0].finish_reason, 'tool_calls')
  assert.match(tc[0].id, /^call_/)
})

test('带 parameter 的 XML 还原：数字/数组/字符串按 JSON 语义还原（storyboard_id 必须是 number）', () => {
  const content = `<tool_call>
<function=update_storyboard>
<parameter=storyboard_id>8</parameter>
<parameter=character_ids>[1,2]</parameter>
<parameter=video_prompt>0-3秒：@卧室，中景。</parameter>
<parameter=video_prompt_full_ref>subject_definitions:
<Subject 1> is the woman from <Picture 1>.</parameter>
</function>
</tool_call>`
  const { changed, payload } = repairXmlToolCalls(xmlResp(content))
  assert.equal(changed, true)
  const args = JSON.parse(payload.choices[0].message.tool_calls[0].function.arguments)
  assert.equal(args.storyboard_id, 8)
  assert.deepEqual(args.character_ids, [1, 2])
  assert.equal(args.video_prompt, '0-3秒：@卧室，中景。')
  assert.match(args.video_prompt_full_ref, /^subject_definitions:/)
})

test('JSON 内嵌变体被还原；多个 tool_call 块各自还原', () => {
  const content = `<tool_call>{"name":"read_storyboard_context","arguments":{}}</tool_call>
<tool_call>{"name":"update_storyboard","arguments":{"storyboard_id":9}}</tool_call>`
  const { changed, payload } = repairXmlToolCalls(xmlResp(content))
  assert.equal(changed, true)
  const tcs = payload.choices[0].message.tool_calls
  assert.equal(tcs.length, 2)
  assert.equal(tcs[1].function.name, 'update_storyboard')
  assert.equal(JSON.parse(tcs[1].function.arguments).storyboard_id, 9)
  assert.equal(payload.choices[0].message.content, '')
})

test('结构化 tool_calls 原样保留；普通文本回复不动', () => {
  const structured = {
    choices: [{ index: 0, message: { role: 'assistant', content: '', tool_calls: [{ id: 'toolu_1', type: 'function', function: { name: 'x', arguments: '{}' } }] }, finish_reason: 'tool_calls' }],
  }
  assert.equal(repairXmlToolCalls(structured).changed, false)

  const plain = xmlResp('拍摄完成，已保存。')
  const r = repairXmlToolCalls(plain)
  assert.equal(r.changed, false)
  assert.equal(r.payload.choices[0].message.content, '拍摄完成，已保存。')
})

test('XML 还原补丁接入 getModel 的 fetch 补丁链（唯一咽喉点）', () => {
  const src = read('src/agents/index.ts')
  assert.match(src, /createToolCallRepairFetch/)
  assert.match(src, /createToolCallRepairFetch\((?:maxTokensFetch|fetchImpl)\)/)
})
