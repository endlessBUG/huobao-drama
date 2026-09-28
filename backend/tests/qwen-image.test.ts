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
  // 6 步 turbo 蒸馏：模型文件与 sigma 表都是钉死的，换成别的就不是同一套出图
  assert.equal(findNode(TEMPLATE, 'UnetLoaderGGUF').inputs.unet_name, 'qwen_image_2.1_turbo_Q4_K_M.gguf')
  assert.equal(findNode(TEMPLATE, 'CLIPLoader').inputs.clip_name, 'qwen3vl_8b_int8_convrot.safetensors')
  assert.equal(findNode(TEMPLATE, 'VAELoader').inputs.vae_name, 'qwen_image_2.1_vae_bf16.safetensors')
  assert.equal(findNode(TEMPLATE, 'QwenImage21Cache').inputs.device, 'cpu')
})

// 蒸馏模型光改步数不够：走 KSampler steps=6 出图会发灰发软，必须配作者的 sigma 表。
// 这条测试盯的就是「别有人图省事把 SamplerCustomAdvanced 链换回 KSampler」。
test('模板：采样是 6 步 turbo 的 SamplerCustomAdvanced 链，不是 KSampler', () => {
  assert.equal(findNode(TEMPLATE, 'KSampler'), undefined, '必须没有 KSampler')
  assert.equal(
    findNode(TEMPLATE, 'ManualSigmas').inputs.sigmas,
    '1.0, 0.9375, 0.875, 0.75, 0.5, 0.25, 0.0', // 7 个值 = 6 步
  )
  assert.equal(findNode(TEMPLATE, 'KSamplerSelect').inputs.sampler_name, 'euler')
  // 缓存节点仍在链上（8G 显存靠它把前缀缓存放 RAM），且接在 BasicGuider 之前
  const sca = findNode(TEMPLATE, 'SamplerCustomAdvanced')
  assert.deepEqual(findNode(TEMPLATE, 'BasicGuider').inputs.model, ['11', 0])
  assert.deepEqual(sca.inputs.guider, ['15', 0])
  assert.deepEqual(sca.inputs.latent_image, ['6', 0])
  assert.deepEqual(sca.inputs.sigmas, ['14', 0])
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
  assert.equal(typeof findNode(g, 'RandomNoise').inputs.noise_seed, 'number')
  assert.equal(findNode(g, 'SaveImage').inputs.filename_prefix, 'huobao_qwen_sheet')
  // 采样参数不被 adapter 改（归模板）
  assert.equal(findNode(g, 'ManualSigmas').inputs.sigmas, '1.0, 0.9375, 0.875, 0.75, 0.5, 0.25, 0.0')
})

// 场景/道具没有参考图，走的就是这条路。参考图那条线必须**整个摘掉**：
// 留空的 LoadImage 会去列 input/ 目录，报 [Errno 13] Permission denied: '…\input'
// —— 看着像权限问题，真因是空文件名，而且要到 ComfyUI 执行时才炸，白等一个来回。
test('buildGenerateRequest：无参考图 = 纯文生图，LoadImage 与 images.image_1 被摘掉', async () => {
  const adapter = new QwenImageAdapter()
  const req = (await adapter.buildGenerateRequest(cfg(), { id: 2, prompt: 'p', size: '512x512' })) as any
  const g = req.body.prompt
  assert.equal(findNode(g, 'LoadImage'), undefined, 'LoadImage 必须整个摘掉，不能留空文件名')
  assert.equal('images.image_1' in findNode(g, 'TextEncodeQwenImage21').inputs, false,
    'images.image_1 键必须删掉，不能留着悬空或空串')
  assert.equal(findNode(g, 'EmptySD3LatentImage').inputs.width, 512)
  assert.equal(typeof findNode(g, 'RandomNoise').inputs.noise_seed, 'number')

  // delete 不能污染下一个请求：紧接着再带参考图跑一次，LoadImage 和 images.image_1 都得回来
  const withRef = (await adapter.buildGenerateRequest(cfg(), {
    id: 4, prompt: 'p', referenceImages: JSON.stringify([refDataUrl]),
  })) as any
  assert.ok(findNode(withRef.body.prompt, 'LoadImage'), '上一个请求的 delete 泄漏到了这一个')
  assert.ok(Array.isArray(findNode(withRef.body.prompt, 'TextEncodeQwenImage21').inputs['images.image_1']))
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
