import { Hono } from 'hono'
import { getConfigById, getActiveConfig } from '../services/ai.js'
import { baseOf } from '../services/adapters/comfyui-common.js'
import { LORA_BY_FILE } from '../services/adapters/comfyui-video.js'
import { success, badRequest } from '../utils/response.js'

const app = new Hono()

// GET /comfyui/loras?config_id=N —— 本机 ComfyUI 的 LoRA 清单，给工作台上方那个下拉用。
// 只读列表、不触发生成（触发一律走 /api/v1/tasks，这是硬规矩）。数据源是 6006 的
// object_info/LoraLoaderModelOnly —— 1006 实测它返回文件名数组 + strength 的默认/范围，
// 所以列表永远和 models/loras/ 里的真文件一致：写死一份列表就会出现「下拉里有、图上没有」。
// 非 comfyui 配置回 supported:false，前端据此不显示这个下拉。
app.get('/', async (c) => {
  const id = c.req.query('config_id')
  const config = id ? await getConfigById(Number(id)) : await getActiveConfig('video')
  if (!config) return badRequest(c, '没有可用的视频服务配置')
  if (config.provider !== 'comfyui') return success(c, { supported: false, items: [] })
  try {
    const r = await fetch(`${baseOf(config.baseUrl)}/api/object_info/LoraLoaderModelOnly`,
      { signal: AbortSignal.timeout(6000) })
    if (!r.ok) return badRequest(c, `ComfyUI 返回 ${r.status}`)
    const j = await r.json()
    const required = j?.LoraLoaderModelOnly?.input?.required || {}
    // note = 这支是干什么的，前端直接拼在名字后面（用户要求「lora 后面要写上 lora 的作用」）。
    // 没登记的（以后自己下的新文件）回空串、只显示文件名 —— 不会因为「后端没写死」就看不见它。
    const items = (required.lora_name?.[0] || []).map((name: string) => ({
      name, label: name.replace(/\.safetensors$/, ''),
      key: LORA_BY_FILE[name]?.key || '',
      note: LORA_BY_FILE[name]?.note || '',
      // 1023 用户「分镜选择 lora 时产出 lora 的配置」：下拉里选中一条也把它登记的 config 带出来
      config: LORA_BY_FILE[name]?.config || null,
    }))
    return success(c, { supported: true, items, strength: required.strength_model?.[1] || {} })
  } catch (e: any) {
    // 6006 没起来 / 没装这个节点：回空清单而不是报错，让工作台照常能发车（不挂 LoRA 就是老行为）
    return success(c, { supported: true, items: [], error: String(e?.message || e) })
  }
})

export default app
