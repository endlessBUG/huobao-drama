import { Hono } from 'hono'
import { eq } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { success, created, badRequest } from '../utils/response.js'
import { generateImage, generateVideo } from '../services/generation.js'
import { getActiveConfig, getConfigById } from '../services/ai.js'
import { getDramaStylePrompt } from '../services/style-preset.js'
import { LORA_REGISTRY } from '../services/adapters/comfyui-video.js'
import { appendFaceRefs } from '../services/face-refs.js'
import { resolveOutfitUrl } from '../services/outfits.js'
import { ensureSingleViewRef } from '../services/outfit-ref.js'
import { logTaskError, logTaskPayload, logTaskStart, logTaskSuccess } from '../utils/task-logger.js'

/** 1122 用户「去掉出衣服和人物融合那步」：app_settings.outfit_refs_enabled='0' 时角色参考回退角色三视图/肖像 */
async function outfitRefsEnabled(): Promise<boolean> {
  try {
    const [row] = await db.select().from(schema.appSettings).where(eq(schema.appSettings.key, 'outfit_refs_enabled'))
    return String(row?.value ?? '1') !== '0'
  } catch { return true }
}

/** 1119 技能分解表写进六段稿：subject_definitions / retention_analysis / detailed_description 各补一条 <Picture N> 绑定 */
function bindTechniquePictures(prompt: string, bound: Array<{ pic: number; name: string }>) {
  if (!prompt || !bound.length) return prompt
  const defs = bound.map(b => `<Subject ${b.pic}> is the ${b.name} effect reference from <Picture ${b.pic}>, showing the full sequence of that technique's energy effect: charge array, released blade-qi / frost blade, impact reaction on ground and air, and aftermath.`).join('\n')
  const rets = bound.map(b => `<Subject ${b.pic}> (appears in all shots): fully_preserved - the technique's effect shape, color, layering and sequence exactly as supplied by <Picture ${b.pic}>.`).join('\n')
  const desc = bound.map(b => `Every energy effect in this shot follows the shapes, colors and layering of <Picture ${b.pic}> (${b.name}).`).join(' ')
  let p = prompt
  if (p.includes('summary:')) p = p.replace('summary:', defs + '\nsummary:')
  if (p.includes('retention_analysis:')) p = p.replace('retention_analysis:', 'retention_analysis:\n' + rets)
  const k = p.indexOf('[Shot 1]')
  if (k >= 0) p = p.slice(0, k) + desc + '\n' + p.slice(k)
  else p = p + '\n' + desc
  // 画风前缀里的「no CGI」会压掉特效：有技能时改成「实拍级别的能量光效」
  p = p.replace('no CGI, no 3D render, no illustration', 'energy effects rendered as practical in-camera light and particles, photoreal, not cartoonish')
  return p
}

/** 1122 帧图绑定：人物→场景→道具→技能（行序），输出 refs 与 <Subject N>/<Picture N> 行。
 *  UI 与 API 都走这里，参考顺序和 Picture 编号永远一致。 */
async function frameBindings(storyboardId: number) {
  const refs: string[] = []
  const subj: string[] = []
  const chars = await db.select({ id: schema.storyboardCharacters.characterId })
    .from(schema.storyboardCharacters)
    .where(eq(schema.storyboardCharacters.storyboardId, storyboardId))
  const charNames: string[] = []
  for (const c of chars) {
    const [ch] = await db.select().from(schema.characters).where(eq(schema.characters.id, c.id))
    // 1122 服饰柜：该镜解析到的「角色×服饰」组合三视图优先，否则回落角色三视图/肖像。
    // 帧图用**单视图裁片**（四视拼版会被 qwen 当构图复制，单人镜变两张脸）。
    const outfitUrl = (await outfitRefsEnabled()) ? await resolveOutfitUrl(c.id, storyboardId) : null
    const url = outfitUrl ? (await ensureSingleViewRef(outfitUrl) || outfitUrl) : (ch?.sheetImageUrl || ch?.imageUrl)
    if (ch && url) { refs.push(url); charNames.push(ch.name); subj.push(`<Subject ${refs.length}> is ${ch.name} from <Picture ${refs.length}>.`) }
  }
  const [sb] = await db.select().from(schema.storyboards).where(eq(schema.storyboards.id, storyboardId))
  if (sb?.sceneId) {
    const [sc] = await db.select().from(schema.scenes).where(eq(schema.scenes.id, sb.sceneId))
    const url = sc?.gridImageUrl || sc?.imageUrl
    if (sc && url) { refs.push(url); subj.push(`<Subject ${refs.length}> is the ${sc.location} scene from <Picture ${refs.length}>.`) }
  }
  const props = await db.select({ id: schema.storyboardProps.propId })
    .from(schema.storyboardProps)
    .where(eq(schema.storyboardProps.storyboardId, storyboardId))
  for (const p of props) {
    const [pr] = await db.select().from(schema.props).where(eq(schema.props.id, p.id))
    if (pr?.imageUrl) { refs.push(pr.imageUrl); subj.push(`<Subject ${refs.length}> is the ${pr.name} from <Picture ${refs.length}>.`) }
  }
  const techs = await db.select({ id: schema.storyboardTechniques.techniqueId })
    .from(schema.storyboardTechniques)
    .where(eq(schema.storyboardTechniques.storyboardId, storyboardId))
  for (const t of techs) {
    const [tk] = await db.select().from(schema.techniques).where(eq(schema.techniques.id, t.id))
    if (tk?.imageUrl) { refs.push(tk.imageUrl); subj.push(`<Subject ${refs.length}> is the ${tk.name} effect reference from <Picture ${refs.length}>.`) }
  }
  // 1122 用户「为什么有两张人脸」：角色参考是「左脸特写+右三视」的拼版，qwen 会把它当构图复制，
  // 画面里就出现大头脸+全身/多份同人。补一句人数锚 + 禁止拼贴/多重曝光/重复人物。
  if (charNames.length) {
    subj.push(`画面里只有 ${charNames.length} 个人物：${charNames.join('、')}；不要拼贴、不要分屏、不要多重曝光、不要重复出现同一个人。`)
  }
  return { refs, subj }
}

const app = new Hono()

type TaskType = 'image' | 'video'

const WAN_MEDIA_TYPES = new Set([
  'first_frame',
  'last_frame',
  'reference_image',
  'reference_video',
  'reference_audio',
  'file',
  'link',
])

/**
 * 兼容项目原有扁平入参，也支持 Wan 3.0 官方 model/input/parameters 结构。
 */
function normalizeVideoRequest(body: any) {
  const input = body.input && typeof body.input === 'object' && !Array.isArray(body.input) ? body.input : {}
  const parameters = body.parameters && typeof body.parameters === 'object' && !Array.isArray(body.parameters)
    ? body.parameters
    : {}
  const media = Array.isArray(input.media) ? input.media : []

  const mediaUrls = (type: string) => media
    .filter((item: any) => item?.type === type)
    .map((item: any) => item?.url)

  return {
    ...body,
    prompt: body.prompt ?? input.prompt ?? '',
    reference_image_urls: body.reference_image_urls ?? mediaUrls('reference_image'),
    reference_video_urls: body.reference_video_urls ?? mediaUrls('reference_video'),
    reference_audio_urls: body.reference_audio_urls ?? mediaUrls('reference_audio'),
    first_frame_url: body.first_frame_url ?? mediaUrls('first_frame')[0],
    last_frame_url: body.last_frame_url ?? mediaUrls('last_frame')[0],
    file_url: body.file_url ?? mediaUrls('file')[0],
    link_url: body.link_url ?? mediaUrls('link')[0],
    generate_audio: body.generate_audio ?? parameters.audio,
    duration: body.duration ?? parameters.duration,
    aspect_ratio: body.aspect_ratio ?? parameters.ratio,
    resolution: body.resolution ?? parameters.resolution,
    seed: body.seed ?? parameters.seed,
    // 1108 单变量 A/B：显式步数覆盖 turbo 4 步（社区共识「4 步是下限、6–8 步明显更好」）。
    // 不传 = 适配器老口径（无 LoRA 4 步 / 挂 LoRA 按 config），逐字节不变。
    steps: body.steps ?? parameters.steps,
    prompt_extend: body.prompt_extend ?? parameters.prompt_extend,
    watermark: body.watermark ?? parameters.watermark,
    official_media: media,
  }
}

export function validateVideoRequest(body: any, provider?: string): string | null {
  for (const key of ['reference_image_urls', 'reference_video_urls', 'reference_audio_urls']) {
    if (body[key] !== undefined && !Array.isArray(body[key])) return `${key} 必须为数组`
    if (Array.isArray(body[key]) && body[key].some((url: any) => typeof url !== 'string' || !url.trim())) {
      return `${key} 中的每个 URL 都必须为非空字符串`
    }
  }

  if (body.official_media.length) {
    for (const item of body.official_media) {
      if (!item || typeof item !== 'object' || !WAN_MEDIA_TYPES.has(item.type) || typeof item.url !== 'string' || !item.url.trim()) {
        return 'input.media 中的每项都必须包含官方支持的 type 和非空 url'
      }
    }
    for (const type of ['first_frame', 'last_frame', 'file', 'link']) {
      if (body.official_media.filter((item: any) => item.type === type).length > 1) {
        return `Wan 3.0 input.media 中 ${type} 最多 1 项`
      }
    }
  }

  const imgs = body.reference_image_urls.length
  const vids = body.reference_video_urls.length
  const auds = body.reference_audio_urls.length
  const first = Boolean(body.first_frame_url)
  const last = Boolean(body.last_frame_url)
  const file = Boolean(body.file_url)
  const link = Boolean(body.link_url)

  if ((provider || '').toLowerCase() === 'aliyun') {
    if (imgs > 10 || vids > 5 || auds > 5) return 'Wan 3.0 参考素材超限：图片≤10、视频≤5、音频≤5'
    if (last && !first) return 'Wan 3.0 尾帧必须与首帧同时传入'
    if (file && link) return 'Wan 3.0 file 与 link 不能同时传入'
    if ((first || last) && (imgs + vids + auds > 0 || file || link)) {
      return 'Wan 3.0 的 first_frame/last_frame 不能与 reference_image/reference_video/reference_audio/file/link 混用'
    }
    const total = imgs + vids + auds + Number(first) + Number(last) + Number(file) + Number(link)
    if (total > 20) return 'Wan 3.0 input.media 最多 20 项'
  } else {
    if (imgs > 9 || vids > 3 || auds > 3) return '参考素材超限：图片≤9、视频≤3、音频≤3'
    if (auds > 0 && imgs + vids === 0) return '参考音频需要至少 1 个参考图片或视频'
  }

  if (!String(body.prompt || '').trim() && imgs + vids + auds === 0 && !first && !last && !file && !link) {
    return '视频生成需要至少一个参考素材或 prompt'
  }

  // 1025 用户「要」平台守卫（画面差的真因 = full_ref 引用了 N 个 <Picture>、却只送了 M<N 张参考图，
  // 场景/道具图没生成 → <Picture> 绑空槽 → 场景和道具纯靠文字现编、画面塌）。以前这条是**静默照发**，
  // 只有人眼事后才发现。comfyui 的 ref2v 才吃 <Picture N> 标签，所以只在它这条上判、别的厂商不受影响。
  if ((provider || '').toLowerCase() === 'comfyui') {
    const pics = [...String(body.prompt || '').matchAll(/<Picture (\d+)>/g)].map((m) => Number(m[1]))
    const maxPic = pics.length ? Math.max(...pics) : 0
    if (maxPic > imgs) {
      return `提示词引用了 <Picture ${maxPic}>，但只有 ${imgs} 张参考图 —— 场景/道具图没生成就会这样。` +
        `先把缺的资产图生成齐（<Picture> 按 角色1..k、场景k+1、道具k+2.. 编号，一张都不能空）再发车，` +
        `否则多出来的 <Picture> 绑到空槽、画面会塌。`
    }
  }
  return null
}

// POST /tasks — 发起生成任务（body.type: image | video）
app.post('/', async (c) => {
  const body = await c.req.json()
  const type = body.type as TaskType
  if (type !== 'image' && type !== 'video') return badRequest(c, 'type 必须为 image 或 video')

  if (type === 'image') {
    if (!body.prompt) return badRequest(c, '提示词必填')
  }

  const videoBody = type === 'video' ? normalizeVideoRequest(body) : null

  try {
    // 请求显式指定 config_id（工作台模型下拉跨厂商切换）时优先；
    // 未指定才回退到集锁定配置，避免锁定配置与所选模型错配（如锁定 Seedance 却传 MiniMax 模型名）
    let configId: number | undefined = body.config_id
    let episodeResolution: string | undefined
    let storyboardDramaId: number | undefined
    let storyboardLoraKey: string | undefined
    if (body.storyboard_id) {
      const [sb] = await db.select().from(schema.storyboards).where(eq(schema.storyboards.id, Number(body.storyboard_id)))
      if (sb) {
        const [ep] = await db.select().from(schema.episodes).where(eq(schema.episodes.id, sb.episodeId))
        const locked = type === 'image' ? ep?.imageConfigId : ep?.videoConfigId
        if (locked != null && configId == null) configId = locked
        if (type === 'video' && ep?.resolution) episodeResolution = ep.resolution
        storyboardDramaId = ep?.dramaId ?? undefined
        // 1019 用户「视频生成挂key对应的lora」：导演在拆镜时把功能 key 写进分镜，这里按 key 查表
        storyboardLoraKey = sb.loraKey || undefined
      }
    }

    // 1115 用户「这个思路集成到平台」：H3 full_ref 自动追加角色方脸特写参考（<Picture N>），
    // 并把标签写进 subject_definitions / retention_analysis / detailed_description。
    // 必须在 validateVideoRequest 之前做 —— 校验按最终图片数检查 <Picture N> 越界。
    if (type === 'video' && videoBody && body.storyboard_id && String(videoBody.prompt || '').includes('subject_definitions:')) {
      try {
        const charRows = await db.select({ id: schema.characters.id, imageUrl: schema.characters.imageUrl, sheetImageUrl: schema.characters.sheetImageUrl })
          .from(schema.storyboardCharacters)
          .innerJoin(schema.characters, eq(schema.storyboardCharacters.characterId, schema.characters.id))
          .where(eq(schema.storyboardCharacters.storyboardId, Number(body.storyboard_id)))
          .orderBy(schema.characters.id)
        // 1122 服饰柜：该镜解析到的「角色×服饰」组合三视图优先，否则回落角色三视图
        const chars: Array<typeof charRows[number]> = []
        const useOutfit = await outfitRefsEnabled()
        for (const r of charRows) {
          const outfitUrl = useOutfit ? await resolveOutfitUrl(r.id, Number(body.storyboard_id)) : null
          const sheet = outfitUrl || r.sheetImageUrl
          if ((sheet || r.imageUrl) && String(sheet || r.imageUrl).startsWith('static/')) chars.push({ ...r, sheetImageUrl: sheet })
        }
        if (chars.length) {
          // 1119 用户「生成的时候用三视图」：角色那张参考图换成三视图（原始图留档，UI 照旧展示）
          const refs = (videoBody.reference_image_urls || []).map((u: string) => {
            const hit = chars.find((r) => r.imageUrl === u)
            return hit?.sheetImageUrl ? hit.sheetImageUrl : u
          })
          videoBody.reference_image_urls = refs
          // 1119 技能：镜头绑定的分解表进参考图，**并且必须写进提示词的 <Picture N> 绑定** ——
          // 只在 refs 里塞图、提示词不提 = H3 完全不认（1292 实测：6 张参考、提示词只提 Picture 1-4，技能零效果）
          try {
            const techRows = await db.select({ name: schema.techniques.name, imageUrl: schema.techniques.imageUrl })
              .from(schema.storyboardTechniques)
              .innerJoin(schema.techniques, eq(schema.storyboardTechniques.techniqueId, schema.techniques.id))
              .where(eq(schema.storyboardTechniques.storyboardId, Number(body.storyboard_id)))
            const bound: Array<{ pic: number; name: string }> = []
            for (const t of techRows) {
              if (!t.imageUrl || !String(t.imageUrl).startsWith('static/')) continue
              if (!refs.includes(t.imageUrl)) refs.push(t.imageUrl)
              bound.push({ pic: refs.indexOf(t.imageUrl) + 1, name: String(t.name || '技能') })
            }
            if (bound.length) videoBody.prompt = bindTechniquePictures(videoBody.prompt || '', bound)
          } catch (err: any) {
            logTaskError('TaskAPI', 'technique-refs', { storyboardId: body.storyboard_id, error: String(err?.message || err).slice(0, 160) })
          }
          videoBody.reference_image_urls = refs
          const withFaces = await appendFaceRefs(videoBody.prompt || '', refs, chars as any)
          videoBody.prompt = withFaces.prompt
          videoBody.reference_image_urls = withFaces.refs
        }
      } catch (err: any) {
        logTaskError('TaskAPI', 'face-refs', { storyboardId: body.storyboard_id, error: String(err?.message || err).slice(0, 200) })
      }
    }

    if (type === 'video' && videoBody) {
      const effectiveConfig = configId
        ? (await getConfigById(configId)) ?? await getActiveConfig('video')
        : await getActiveConfig('video')
      const validationError = validateVideoRequest(videoBody, effectiveConfig?.provider)
      if (validationError) return badRequest(c, validationError)
    }

    logTaskStart('TaskAPI', 'generate', {
      type,
      storyboardId: body.storyboard_id,
      sceneId: body.scene_id,
      characterId: body.character_id,
      dramaId: body.drama_id,
    })
    logTaskPayload('TaskAPI', 'request body', body)

    // 视频生成时把项目视觉风格词注入提示词最前方（与图片侧的自动注入保持一致口径）
    let videoPrompt = videoBody?.prompt
    if (type === 'video' && String(videoPrompt || '').trim()) {
      const dramaId = body.drama_id ?? storyboardDramaId ?? null
      const stylePrompt = await getDramaStylePrompt(dramaId)
      if (stylePrompt) videoPrompt = `${stylePrompt}，\n${videoPrompt}`
      // 1119 有技能参考时，画风前缀里的「no CGI / no 3D render」会把剑气特效压没 → 换成实拍级能量光效
      if (String(videoPrompt).includes('effect reference from <Picture')) {
        videoPrompt = String(videoPrompt).replace('no CGI, no 3D render, no illustration', 'energy effects rendered as practical in-camera light and particles, photoreal, not cartoonish')
      }
    }

    // 1017 分镜首尾帧图：带 `frame_type` 的图片任务也吃项目画风，和上面 video 那条同口径。
    // 角色三视图 / 场景九宫格**不**注入 —— 它们自己的提示词写着「纯白背景、电影质感」，叠画风会打架。
    let imagePrompt = body.prompt
    let imageRefs: string[] | undefined = body.reference_images
    if (type === 'image' && body.frame_type && String(body.prompt || '').trim()) {
      const dramaId = body.drama_id ?? storyboardDramaId ?? null
      const stylePrompt = await getDramaStylePrompt(dramaId)
      // 1122 尾帧 = 首帧编辑（社区 FLF2V 口径）：以本镜首帧为唯一参考，
      // 构图/人物/服装/光线保持不变，只把动作表情改到末态。不再独立文生图（错误率高）。
      let bound = ''
      let usedFirstEdit = false
      if (body.frame_type === 'last_frame' && body.storyboard_id) {
        const [sbRow] = await db.select().from(schema.storyboards).where(eq(schema.storyboards.id, Number(body.storyboard_id)))
        if (sbRow?.firstFrameImage) {
          imageRefs = [sbRow.firstFrameImage]
          bound = '<Picture 1> 是本镜首帧：严格保持首帧的构图、机位、人物数量与位置、服装、发型、光线与场景不变，只在原人物身上改表情、视线与微小姿态到末态；画面上的人物数量必须与首帧完全一致，不要重复、复制或新增任何人物。'
          usedFirstEdit = true
        }
      }
      // 其余帧（cut 首帧/无首帧可编辑的尾帧）：参考顺序 = 人物→场景→道具→技能，由后端统一解析
      if (!usedFirstEdit && body.storyboard_id) {
        try {
          const b = await frameBindings(Number(body.storyboard_id))
          if (b.refs.length) {
            imageRefs = b.refs
            bound = b.subj.join(' ') + ' 人物外貌、服装与场景一律照参考图。'
          }
        } catch (err: any) {
          logTaskError('TaskAPI', 'frame-bindings', { storyboardId: body.storyboard_id, error: String(err?.message || err).slice(0, 200) })
        }
      }
      const bodyText = bound + String(body.prompt)
      imagePrompt = stylePrompt ? `${stylePrompt}，\n${bodyText}` : bodyText
    }

    // 1019 用户「视频生成挂key对应的lora」：没显式传 lora、但该分镜有导演写的 lora_key ⇒ 按 key 查登记表挂。
    // 概念词型（concept）的词已经在提示词正文里（提示词层按 key 注入的）⇒ loraTrigger 默认 false，不再前置。
    const autoLora = !videoBody?.lora && storyboardLoraKey ? LORA_REGISTRY[storyboardLoraKey] : undefined

    const id = type === 'image'
      ? await generateImage({
        storyboardId: body.storyboard_id,
        dramaId: body.drama_id,
        sceneId: body.scene_id,
        characterId: body.character_id,
        prompt: imagePrompt,
        model: body.model,
        size: body.size,
        // 1122 用户「qwen 分辨率很差」：允许调用方抬像素预算（qwen 默认会缩到 1344x768）
        maxPixels: body.max_pixels ?? body.maxPixels,
        referenceImages: imageRefs,
        frameType: body.frame_type,
        configId,
      })
      : await generateVideo({
        storyboardId: body.storyboard_id,
        dramaId: body.drama_id,
        prompt: videoPrompt,
        model: videoBody!.model,
        referenceMode: 'reference',
        imageUrl: videoBody!.image_url,
        firstFrameUrl: videoBody!.first_frame_url,
        lastFrameUrl: videoBody!.last_frame_url,
        // 1017（用户「保存 然后接入」）：graph 给桥里注册的工作流文件名（如 "shot1.json"）⇒ 那条单
        // 走 ComfyUI UI 里 Export(API) 出来的图；不给 = 桥的默认 native 图（现役定案），行为不变。
        graph: videoBody!.graph,
        referenceImageUrls: videoBody!.reference_image_urls,
        referenceVideoUrls: videoBody!.reference_video_urls,
        referenceAudioUrls: videoBody!.reference_audio_urls,
        referenceFileUrl: videoBody!.file_url,
        referenceLinkUrl: videoBody!.link_url,
        generateAudio: videoBody!.generate_audio,
        duration: videoBody!.duration,
        aspectRatio: videoBody!.aspect_ratio,
        resolution: episodeResolution || videoBody!.resolution,
        seed: videoBody!.seed,
        steps: videoBody!.steps,
        promptExtend: videoBody!.prompt_extend,
        watermark: videoBody!.watermark,
        chain: videoBody!.chain,
        latentChain: videoBody!.latent_chain ?? videoBody!.latentChain, // [1117] 段间 latent 直传
        lora: videoBody!.lora || autoLora?.file,
        loraStrength: videoBody!.lora_strength ?? videoBody!.loraStrength,
        loraTrigger: videoBody!.lora_trigger ?? videoBody!.loraTrigger ?? (autoLora?.concept ? false : undefined),
        sparse: videoBody!.sparse,   // 桥的 sol-attn 开关（A/B 仪表，默认关）
        noLora: videoBody!.no_lora ?? videoBody!.noLora, // 1115 去 turbo LoRA（native 裸权重 20 步）
        refine: videoBody!.refine,   // 1024 小脸修复二采（comfyui 专属，body 带 refine:true 即开）
        upscale: videoBody!.upscale, // 1025 RTX VSR ×2 默认全开，body `upscale:false` 关（以前没透传 = 关不掉）
        configId,
      })

    const [record] = await db.select().from(schema.sysTask)
      .where(eq(schema.sysTask.id, id))
    logTaskSuccess('TaskAPI', 'generate', { taskId: id, type, provider: record?.provider })
    return created(c, record)
  } catch (err: any) {
    logTaskError('TaskAPI', 'generate', { type, error: err.message })
    return badRequest(c, err.message)
  }
})

// GET /tasks/:id — 轮询任务状态
app.get('/:id', async (c) => {
  const id = Number(c.req.param('id'))
  const [row] = await db.select().from(schema.sysTask)
    .where(eq(schema.sysTask.id, id))
  return success(c, row || null)
})

// GET /tasks — 按 type / storyboard_id / drama_id 过滤
app.get('/', async (c) => {
  const type = c.req.query('type')
  const storyboardId = c.req.query('storyboard_id')
  const dramaId = c.req.query('drama_id')

  let rows = await db.select().from(schema.sysTask)

  if (type) rows = rows.filter(r => r.type === type)
  if (storyboardId) rows = rows.filter(r => r.storyboardId === Number(storyboardId))
  if (dramaId) rows = rows.filter(r => r.dramaId === Number(dramaId))

  return success(c, rows)
})

// DELETE /tasks/:id
app.delete('/:id', async (c) => {
  const id = Number(c.req.param('id'))
  await db.delete(schema.sysTask).where(eq(schema.sysTask.id, id))
  return success(c)
})

export default app
