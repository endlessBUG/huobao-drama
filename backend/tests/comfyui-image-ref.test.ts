import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ComfyUIImageAdapter } from '../src/services/adapters/comfyui-image'

const adapter = new ComfyUIImageAdapter()

const tmpInputDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'huobao-comfyui-'))

// comfyuiInputDir 不是 AIConfig 的公开字段，但 toInputDir 优先读它（settings 可覆盖）
const config = (inputDir: string, baseUrl = 'http://127.0.0.1:6006') =>
  ({ provider: 'comfyui', baseUrl, apiKey: '', model: 'krea2-turbo', comfyuiInputDir: inputDir }) as any

test('无参考图 → 纯文生图 body，不带 image / ref_method', () => {
  const req = adapter.buildGenerateRequest(config(tmpInputDir()), {
    id: 1,
    prompt: 'a cat',
    size: '1920x1080',
  })

  assert.equal(req.url, 'http://127.0.0.1:6006/v1/images/generations')
  assert.equal(req.method, 'POST')
  assert.equal((req.headers as any)['Content-Type'], 'application/json')
  // async:true 不能少：不带就是桥的同步档，队列一挤就撞 undici headersTimeout(300s) → "fetch failed"
  assert.equal(req.body.async, true)
  assert.deepEqual(req.body, { model: 'krea2-turbo', prompt: 'a cat', size: '1920x1080', n: 1, async: true })
})

test('有参考图也**不**传给桥：native-ref 会把参考图画进画面，三视图就废了', () => {
  const dir = tmpInputDir()
  const req = adapter.buildGenerateRequest(config(dir), {
    id: 2,
    prompt: '角色三视图',
    size: '1920x1080',
    referenceImages: JSON.stringify(['data:image/png;base64,iVBORw0KGgo=']),
  })

  // 走 image / ref_method 任一个，桥就切到 Krea2RefImage（in-context），参考图会作为
  // 画面内容被渲染出来 —— 实测 index_timestep_zero 出整片马赛克，index 出画中画。
  assert.equal(req.body.image, undefined)
  assert.equal(req.body.ref_method, undefined)
  assert.equal(req.body.denoise, undefined)
  assert.deepEqual(req.body, { model: 'krea2-turbo', prompt: '角色三视图', size: '1920x1080', n: 1, async: true })
  // 连落盘也不该发生（别往 ComfyUI input/ 里堆没人用的参考图）
  assert.deepEqual(fs.readdirSync(dir), [])
})

test('baseUrl 带 /v1 不产生双前缀', () => {
  const req = adapter.buildGenerateRequest(config(tmpInputDir(), 'http://127.0.0.1:6006/v1/'), {
    id: 4,
    prompt: 'a cat',
  })

  assert.equal(req.url, 'http://127.0.0.1:6006/v1/images/generations')
})

test('响应解析：桥同步返回 data[0].url（不是 OpenAI 的 /v1/images/edits）', () => {
  const fileUrl = 'http://127.0.0.1:6006/v1/files/openai/krea2_ab12cd34_00001_.png'

  assert.deepEqual(adapter.parseGenerateResponse({ created: 1, model: 'krea2-turbo', data: [{ b64_json: 'x', url: fileUrl }] }), {
    isAsync: false,
    imageUrl: fileUrl,
  })
  assert.deepEqual(adapter.parseGenerateResponse({ id: 'job-1', status: 'queued' }), {
    isAsync: true,
    taskId: 'job-1',
  })
  assert.deepEqual(adapter.parsePollResponse({ status: 'succeeded', url: fileUrl }), {
    status: 'completed',
    imageUrl: fileUrl,
  })
  assert.deepEqual(adapter.parsePollResponse({ status: 'running' }), { status: 'processing' })
  assert.equal(adapter.extractImageUrl({ data: [{ url: fileUrl }] }), fileUrl)
})
