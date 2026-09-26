/**
 * 响应侧补丁：把「文本式工具调用」还原成结构化 tool_calls
 *
 * 背景（实测，自建模型/中转站常见）：模型不返回结构化 `tool_calls`，而是把工具调用
 * 写进 `message.content` 文本里（`<tool_call><function=xxx></function></tool_call>`），
 * 且 `finish_reason=stop`。Mastra 的 agent loop 只认结构化 tool_calls，
 * 于是循环直接结束、工具从未执行 —— 表现为「Agent 正常结束但什么都没保存」
 * （video_prompt_full_ref 落库恒 NULL 即此症）。
 *
 * 触发条件与 prompt 长度相关：同样的模型，短 prompt 走结构化、长中文 prompt 走 XML，
 * 且可 3/3 复现。故必须在客户端兜底，不能指望模型侧稳定。
 *
 * 只在 content 里出现 `<tool_call>` 且 message 无结构化 tool_calls 时才改写，其余原样透传。
 * ponytail: 只认实测样本的两种变体（XML 参数式 / JSON 内嵌式），
 * 需要再支持 Anthropic 原生 <invoke> 时在此处加分支。
 */
import { logTaskProgress } from '../utils/task-logger.js'

interface NormalizedToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

const BLOCK_RE = /<tool_calls?>\s*([\s\S]*?)\s*<\/tool_calls?>/g
const FUNCTION_RE = /<function[=\s]+(?:name[=:]\s*)?["']?([A-Za-z0-9_.\-]+)["']?\s*>([\s\S]*?)(?:<\/function>|$)/g
const PARAM_RE = /<parameter[=\s]+(?:name[=:]\s*)?["']?([A-Za-z0-9_.\-]+)["']?\s*>([\s\S]*?)(?:<\/parameter>|$)/g

/** 参数值按 JSON 语义还原：8 → number、[1,2] → array、"a" → string；解析不了就当字符串 */
function coerce(raw: string): unknown {
  const v = raw.trim()
  try {
    return JSON.parse(v)
  } catch {
    return v
  }
}

function makeCall(name: string, args: Record<string, unknown>): NormalizedToolCall {
  return {
    id: `call_${Math.random().toString(16).slice(2, 10)}${Date.now().toString(16).slice(-6)}`,
    type: 'function',
    function: { name, arguments: JSON.stringify(args) },
  }
}

/** 解析单个 <tool_call> 块（XML 参数式优先，其次 JSON 内嵌式） */
function parseBlock(inner: string): NormalizedToolCall[] {
  const t = inner.trim()
  if (t.startsWith('{')) {
    try {
      const j = JSON.parse(t)
      const name = j.name ?? j.tool_name ?? j.tool
      const args = j.arguments ?? j.parameters ?? j.args ?? {}
      if (typeof name === 'string' && name) {
        return [makeCall(name, typeof args === 'string' ? JSON.parse(args || '{}') : args)]
      }
    } catch { /* 落到 XML 分支 */ }
  }
  const calls: NormalizedToolCall[] = []
  for (const fn of t.matchAll(FUNCTION_RE)) {
    const args: Record<string, unknown> = {}
    for (const p of (fn[2] || '').matchAll(PARAM_RE)) args[p[1]] = coerce(p[2])
    calls.push(makeCall(fn[1], args))
  }
  return calls
}

/** 纯函数：OpenAI 兼容响应体进，还原后的响应体出。changed=false 表示未动过 */
export function repairXmlToolCalls(payload: any): { changed: boolean; payload: any } {
  const choices = payload?.choices
  if (!Array.isArray(choices)) return { changed: false, payload }
  let changed = false
  for (const choice of choices) {
    const message = choice?.message
    if (!message || message.tool_calls?.length) continue
    const content = typeof message.content === 'string' ? message.content : ''
    if (!content.includes('<tool_call')) continue
    const calls: NormalizedToolCall[] = []
    for (const block of content.matchAll(BLOCK_RE)) calls.push(...parseBlock(block[1]))
    if (!calls.length) continue
    message.tool_calls = calls
    // 去掉工具调用文本，保留模型可能写的其余说明文字
    message.content = content.replace(BLOCK_RE, '').trim()
    choice.finish_reason = 'tool_calls'
    changed = true
  }
  return { changed, payload }
}

/** 响应侧补丁：读响应体 → 必要时还原 XML 工具调用 → 重新包装 Response */
export function createToolCallRepairFetch(inner?: typeof fetch): typeof fetch {
  const base = inner || fetch
  return async (input: any, init?: any) => {
    const resp = await base(input, init)
    if (!resp.ok) return resp
    if (!(resp.headers.get('content-type') || '').includes('application/json')) return resp
    const text = await resp.text() // 体已消费，之后必须重新包装
    const rewrap = (body: string) => {
      const headers = new Headers(resp.headers)
      headers.delete('content-length')
      headers.delete('content-encoding')
      headers.set('content-type', 'application/json')
      return new Response(body, { status: resp.status, statusText: resp.statusText, headers })
    }
    try {
      let json: any
      try {
        json = JSON.parse(text)
      } catch {
        return rewrap(text) // 非 JSON（如 SSE 流），原样透传
      }
      const { changed, payload } = repairXmlToolCalls(json)
      if (!changed) return rewrap(text)
      const calls = payload.choices.flatMap((c: any) => c.message?.tool_calls ?? [])
      logTaskProgress('AIConfig', 'toolcall-xml-repair', {
        count: calls.length,
        names: calls.map((t: any) => t.function.name),
      })
      return rewrap(JSON.stringify(payload))
    } catch {
      return rewrap(text) // 兜底：解析异常也不丢响应体
    }
  }
}
