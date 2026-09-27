import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { QwenImageAdapter } from '../src/services/adapters/qwen-image'

const TEMPLATE = JSON.parse(
  fs.readFileSync(new URL('../src/services/adapters/qwen-workflow.json', import.meta.url), 'utf8'),
)

const refDataUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg===='

function cfg(): any {
  return {
    provider: 'qwen',
    baseUrl: 'http://127.0.0.1:6006/v1', // 容忍带 /v1 的写法
    apiKey: '',
    model: 'qwen-image-2.1',
    comfyuiInputDir: fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-input-')),
  }
}

function findNode(graph: Record<string, any>, classType: string): any {
  return Object.values(graph).find((n: any) => n?.class_type === classType)
}

// 参考图键的写法是这套 provider 的命门：写成 images.image_1（autogrow 子输入 id），
// 写成嵌套 {"images":{"image_1":..}} 会被服务端静默丢弃 → 参考图不生效、无任何报错。
test('模板：参考图键是 images.image_1，且链到 LoadImage', () => {
  const te = findNode(TEMPLATE, 'TextEncodeQwenImage21')
  assert.ok(te, '模板缺 TextEncodeQwenImage21')
  const load = findNode(TEMPLATE, 'LoadImage')
  assert.ok(load, '模板缺 LoadImage')
  const link = te.inputs['images.image_1']
  assert.ok(Array.isArray(link), '参考图必须是 images.image_1 的链，不能是嵌套字典')
  assert.equal(link[0], Object.keys(TEMPLATE).find(k => TEMPLATE[k] === load))
  assert.ok(Array.isArray(te.inputs.vae), 'TextEncodeQwenImage21 必须接 vae（走 reference latents）')
  assert.equal(te.inputs.negative_prompt, '')
  // 与 qwen21_sheet_generic.py 同一套模型与采样
  assert.equal(findNode(TEMPLATE, 'UnetLoaderGGUF').inputs.unet_name, 'qwen-image-2.1-UC-Q4_K_M.gguf')
  assert.equal(findNode(TEMPLATE, 'CLIPLoader').inputs.clip_name, 'qwen3vl_8b_int8_convrot.safetensors')
  assert.equal(findNode(TEMPLATE, 'VAELoader').inputs.vae_name, 'qwen_image_2.1_vae_bf16.safetensors')
  assert.equal(findNode(TEMPLATE, 'QwenImage21Cache').inputs.device, 'cpu')
  const ks = findNode(TEMPLATE, 'KSampler')
  assert.equal(ks.inputs.steps, 25)
  assert.equal(ks.inputs.cfg, 1.0)
  assert.equal(ks.inputs.sampler_name, 'euler')
  assert.equal(ks.inputs.scheduler, 'simple')
})

test('buildGenerateRequest：参考图落盘 + 注入 prompt/尺寸/seed；1920x1080 缩到 1344x768', async () => {
  const c = cfg()
  const adapter = new QwenImageAdapter()
  const req = (await adapter.buildGenerateRequest(c, {
    id: 1,
    prompt: '以参考图中的同一人物为准，角色设定参考图……',
    size: '1920x1080',
    referenceImages: JSON.stringify([refDataUrl]),
  })) as any

  assert.equal(req.method, 'POST')
  assert.equal(req.url, 'http://127.0.0.1:6006/prompt') // /v1 已去掉
  assert.equal(req.body.client_id, 'huobao-qwen') // client_id 在 body 顶层

  const g = req.body.prompt
  // 模板没被就地改坏：链原样保留
  assert.deepEqual(findNode(g, 'TextEncodeQwenImage21').inputs['images.image_1'],
    findNode(TEMPLATE, 'TextEncodeQwenImage21').inputs['images.image_1'])
  // 参考图文件名 = input/ 里刚落盘那张
  const staged = fs.readdirSync(c.comfyuiInputDir)
  assert.equal(staged.length, 1)
  assert.equal(findNode(g, 'LoadImage').inputs.image, staged[0])
  assert.equal(findNode(g, 'TextEncodeQwenImage21').inputs.prompt, '以参考图中的同一人物为准，角色设定参考图……')
  const latent = findNode(g, 'EmptySD3LatentImage')
  assert.equal(latent.inputs.width, 1344)
  assert.equal(latent.inputs.height, 768)
  assert.equal(typeof findNode(g, 'KSampler').inputs.seed, 'number')
  assert.equal(findNode(g, 'SaveImage').inputs.filename_prefix, 'huobao_qwen_sheet')
  // 采样参数不被 adapter 改（归模板）
  assert.equal(findNode(g, 'KSampler').inputs.steps, 25)
})

test('buildGenerateRequest：无参考图不抛错（按钮侧已堵），LoadImage 留空', async () => {
  const adapter = new QwenImageAdapter()
  const req = (await adapter.buildGenerateRequest(cfg(), { id: 2, prompt: 'p', size: '512x512' })) as any
  assert.equal(findNode(req.body.prompt, 'LoadImage').inputs.image, '')
  assert.equal(findNode(req.body.prompt, 'EmptySD3LatentImage').inputs.width, 512)
})

test('尺寸兜底：非法/过小回默认档，合法范围内原样', async () => {
  const adapter = new QwenImageAdapter()
  const sizeOf = async (size?: string) => {
    const req = (await adapter.buildGenerateRequest(cfg(), { id: 3, prompt: 'p', size })) as any
    const l = findNode(req.body.prompt, 'EmptySD3LatentImage')
    return `${l.inputs.width}x${l.inputs.height}`
  }
  assert.equal(await sizeOf('1024x768'), '1024x768')
  assert.equal(await sizeOf(undefined), '1344x768')
  assert.equal(await sizeOf('abc'), '1344x768')
  assert.equal(await sizeOf('64x64'), '1344x768')
})

test('parseGenerateResponse / parsePollResponse / extractImageUrl', async () => {
  const adapter = new QwenImageAdapter()
  assert.deepEqual(adapter.parseGenerateResponse({ prompt_id: 'uuid-1' }), { isAsync: true, taskId: 'uuid-1' })
  assert.throws(() => adapter.parseGenerateResponse({}), /prompt_id/)

  // 先 build 一次把 this.base 设上（真实链路里 poll 紧跟 build）
  await adapter.buildGenerateRequest(cfg(), { id: 9, prompt: 'p', referenceImages: JSON.stringify([refDataUrl]) })

  assert.deepEqual(adapter.parsePollResponse({}), { status: 'processing' }) // 未结束：/history 是空的
  assert.deepEqual(
    adapter.parsePollResponse({ a: { status: { status_str: 'running', completed: false } } }),
    { status: 'processing' },
  )
  assert.equal(
    adapter.parsePollResponse({ a: { status: { status_str: 'error', completed: true, messages: [['execution_error']] } } }).status,
    'failed',
  )

  const hist = {
    'uuid-1': {
      status: { status_str: 'success', completed: true, messages: [] },
      outputs: { 9: { images: [{ filename: 'huobao_qwen_sheet_00001_.png', subfolder: '', type: 'output' }] } },
    },
  }
  const done = adapter.parsePollResponse(hist)
  assert.equal(done.status, 'completed')
  assert.equal(
    done.imageUrl,
    'http://127.0.0.1:6006/view?filename=huobao_qwen_sheet_00001_.png&subfolder=&type=output',
  )
  assert.equal(adapter.extractImageUrl(hist), done.imageUrl)
  assert.equal(adapter.extractImageBase64(), null)
})
