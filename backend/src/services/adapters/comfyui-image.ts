// 本机 ComfyUI + ComfyUI-OpenAI-Bridge 的图片 Adapter。
//
// 端点（OpenAI 兼容，但**没有** /v1/images/edits —— 实测 405，所以不能借用 openai adapter）:
//   POST {base}/v1/images/generations  body 带 async:true -> 202 {"id":"..","status":"queued"}
//   GET  {base}/v1/images/generations/{id} -> status=queued/running/succeeded/failed，成功带 url
// body 必须带 async:true：不带就是桥的同步档，它 await 到整个 ComfyUI 作业跑完才回包，
// 而 undici 的 headersTimeout 默认 300s —— 队列一挤（比如 GPU 上跑着别人的 3D 工作流）
// 就必然 abort 成 "fetch failed"（实测 305s 挂掉）。异步档 + 轮询没这个天花板。
//
// 参考图 **在这个 provider 上一律不传** —— 桥给 Krea-2 的两条路都做不了身份迁移（2026-09-27 实测）:
//   image + ref_method -> 桥内 Krea2RefImage「原生 in-context reference」：参考图 VAE 编码成
//     reference_latents 追加进 positive conditioning，模型把它当**画面内容**生成 →
//     参考图被画进画面一侧（桥节点 tooltip 原话）。use_method=index_timestep_zero 按 t=0
//     强锚定 → 残影重：实测左侧整片块状马赛克 + 两张脸叠加；use_method=index 残影轻，
//     但输出仍是嵌入的「画中画」，身份并不迁移（prompt 换成别人也照画）。
//   image + denoise    -> img2img：latent 尺寸随参考图（桥 _wf_image 忽略 w/h），出不了 1920x1080。
// 三视图要被前端切格，画面必须干净 → 只能走纯文生图。
// （这是**桥 + Krea-2** 的结论，别推广：角色三视图的参考图驱动走 qwen-image.ts —— 原生 /prompt +
//   Qwen-Image-2.1 的 reference latents 通道，参考图能真正带着身份与服装过来。）
import type {
  ImageProviderAdapter,
  ProviderRequest,
  AIConfig,
  ImageGenerationRecord,
  ImageGenResponse,
  ImagePollResponse,
} from './types'
import { baseOf } from './comfyui-common'

const DEFAULT_MODEL = 'krea2-turbo'

export class ComfyUIImageAdapter implements ImageProviderAdapter {
  provider = 'comfyui'

  buildGenerateRequest(config: AIConfig, record: ImageGenerationRecord): ProviderRequest {
    const body: any = {
      model: record.model || config.model || DEFAULT_MODEL,
      prompt: record.prompt || '',
      size: record.size || '1024x1024',
      n: 1,
      async: true,
    }

    return {
      method: 'POST',
      url: `${baseOf(config.baseUrl)}/v1/images/generations`,
      headers: { 'Content-Type': 'application/json' },
      body,
    }
  }

  parseGenerateResponse(result: any): ImageGenResponse {
    // 桥默认同步：data[0].url 指向 {base}/v1/files/<path>
    const imageUrl = result.data?.[0]?.url || result.url
    if (imageUrl) return { isAsync: false, imageUrl }
    if (result.data?.[0]?.b64_json) return { isAsync: false, imageUrl: undefined }
    if (result.id || result.task_id) return { isAsync: true, taskId: String(result.id || result.task_id) }
    throw new Error('ComfyUI 图片响应异常：缺少 data[0].url')
  }

  buildPollRequest(config: AIConfig, taskId: string): ProviderRequest {
    return {
      method: 'GET',
      url: `${baseOf(config.baseUrl)}/v1/images/generations/${taskId}`,
      headers: {},
      body: undefined,
    }
  }

  parsePollResponse(result: any): ImagePollResponse {
    const status = (result.status || '').toLowerCase()
    if (status === 'queued' || status === 'running' || status === 'pending') {
      return { status: 'processing' }
    }
    if (status === 'succeeded') {
      return { status: 'completed', imageUrl: result.url || null }
    }
    return { status: 'failed', error: result.error || `ComfyUI 图片生成失败（status: ${status}）` }
  }

  extractImageUrl(result: any): string | null {
    return result.data?.[0]?.url || result.url || null
  }

  extractImageBase64(result: any): { data: string; mimeType: string } | null {
    const b64 = result.data?.[0]?.b64_json
    return b64 ? { data: b64, mimeType: 'image/png' } : null
  }
}
