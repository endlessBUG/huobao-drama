import { readFileSync, openSync, readSync, closeSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

// 第二层 LoRA（社区治「特写解剖丑」= 权重不是措辞）。这条锁的是接线：
// 桥里那层挂错位置（接在 turbo 之前、或没人吃它的输出），后端会静默拿到一张没加 LoRA 的图。
const bridge = readFileSync('E:/AI/ComfyUI/custom_nodes/ComfyUI-OpenAI-Bridge/__init__.py', 'utf8')
const adapter = readFileSync(new URL('../src/services/adapters/comfyui-video.ts', import.meta.url), 'utf8')
const generation = readFileSync(new URL('../src/services/generation.ts', import.meta.url), 'utf8')
const tasks = readFileSync(new URL('../src/routes/tasks.ts', import.meta.url), 'utf8')
const route = readFileSync(new URL('../src/routes/comfyuiLoras.ts', import.meta.url), 'utf8')
const indexTs = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')
const useApi = readFileSync(new URL('../../frontend/app/composables/useApi.ts', import.meta.url), 'utf8')
const view = readFileSync(new URL('../../frontend/app/views/drama/episode.vue', import.meta.url), 'utf8')

test('桥：传了 lora 才插第二层，且接在 turbo 之后、注意力后端吃它', () => {
  assert.match(bridge, /window=22, lora=None, lora_strength=1\.0, latent_upscale=0\):/)
  assert.match(bridge, /if lora:\s*g\["2b"\] = \{"class_type": "LoraLoaderModelOnly"/)
  assert.match(bridge, /"model": \["2", 0\], "lora_name": lora,/)
  // 只有 97 吃 ["2",0]（下游走 m = "98" if sparse else "97"），所以改 97 的输入 = 整条链都过 LoRA
  assert.match(bridge, /g\["97"\]\["inputs"\]\["model"\] = \["2b", 0\]/)
  assert.match(bridge, /lora=b\.get\("lora"\) or None,/)
  assert.match(bridge, /lora_strength=\(b\.get\("lora_strength"\) if b\.get\("lora"\) else 1\.0\)/)
})

test('不传 lora 时 2b 不在图字典字面量里（老行为逐字节不变）', () => {
  const head = bridge.match(/def _wf_video\(prompt[\s\S]*?if sparse:/)?.[0]
  assert.ok(head, '找不到 _wf_video 开头')
  const g = head.match(/g = \{[\s\S]*?\n    \}/)?.[0] || ''
  assert.ok(g.includes('"2"') && !g.includes('"2b"'), '2b 只该出现在 if lora: 分支里')
})

test('后端三处白名单都带上 lora（快照 + record + 路由映射）', () => {
  assert.match(generation, /lora\?: string \| null/)
  // 少任何一处都静默失效：快照不落盘 → processTask 读不到；record 不传 → adapter 收不到
  assert.equal((generation.match(/lora: params\.lora,/g) || []).length, 2,
    'lora 必须同时进 createTask 的 params 快照和 processTask 的 record')
  assert.equal((generation.match(/loraTrigger: params\.loraTrigger,/g) || []).length, 2,
    'loraTrigger 开关（只要权重不碰触发词，归因实验靠它）同样要两处都带上')
  assert.match(tasks, /const autoLora = !videoBody\?\.lora && storyboardLoraKey \? LORA_REGISTRY\[storyboardLoraKey\] : undefined/)
  // 1019 用户「视频生成挂key对应的lora」：没显式传 lora 时按分镜的 lora_key 查表补 file
  assert.match(tasks, /lora: videoBody!\.lora \|\| autoLora\?\.file,/)
  assert.match(tasks, /loraStrength: videoBody!\.lora_strength \?\? videoBody!\.loraStrength,/)
  assert.match(tasks, /loraTrigger: videoBody!\.lora_trigger \?\? videoBody!\.loraTrigger \?\? \(autoLora\?\.concept \? false : undefined\),/)
})

test('adapter：body 带 lora / lora_strength，触发词按 key 的口径塞（token 型前置、concept 型已在正文里、没登记的不塞词）', () => {
  // 1019 用户「每个lora应该有个类型key…」「key是描述模型功能的」：登记表按功能 key 走，file 是其中一格
  assert.match(adapter, /export const LORA_REGISTRY: Record<string, \{/)
  assert.match(adapter, /file: string; t\?: string; concept\?: string; prompt\?: string; note: string;/)
  assert.match(adapter, /export const LORA_BY_FILE/)
  // lora_trigger:false = 只挂权重不碰词（concept 型的词已经在提示词正文里，再前置是重复）
  assert.match(adapter, /const tr = record\.lora && record\.loraTrigger !== false \? LORA_BY_FILE\[record\.lora\] : undefined/)
  assert.match(adapter, /const prompt = !tr\?\.t \|\| base\.toLowerCase\(\)\.includes\(tr\.t\.toLowerCase\(\)\) \? base : `\$\{tr\.t\} \$\{base\}`/)
  assert.match(adapter, /lora: record\.lora \|\| undefined,/)
  assert.match(adapter, /lora_strength: record\.lora \? \(record\.loraStrength \?\? LORA_BY_FILE\[record\.lora\]\?\.config\?\.strength \?\? 1\.0\) : undefined,/)
  // 1023 用户「分镜选择 lora 时产出 lora 的配置」⇒ steps 从这条 LoRA 的 config 取；1024 重做回 native
  // 后默认仍是 20（没挂 LoRA / config 没写 steps = 20）。
  assert.match(adapter, /steps: record\.lora \? \(LORA_BY_FILE\[record\.lora\]\?\.config\?\.steps \?\? 20\) : 20,/)
})

// 用户要求「lora 后面要写上 lora 的作用」：登记了就必须有 note，note 走接口到下拉
test('登记表里每一支都写了作用，且前端把它拼在名字后面', () => {
  const block = adapter.match(/export const LORA_REGISTRY[\s\S]*?\n\}(\r)?\n/)?.[0] || ''
  const parts = block.split(/\n  (?=[a-z0-9_]+: \{)/).slice(1)
  assert.ok(parts.length >= 8, `登记表条目太少 ${parts.length}`)
  for (const part of parts) {
    const key = (part.match(/^([a-z0-9_]+):/) || [])[1] || '?'
    assert.ok(/note: '.{10,}/.test(part), `${key} 登记了却没写 note —— 下拉里就只剩文件名`)
    assert.ok(/file: '[^']+\.safetensors'/.test(part), `${key} 没写 file`)
  }
  assert.match(route, /key: LORA_BY_FILE\[name\]\?\.key \|\| ''/)
  assert.match(route, /note: LORA_BY_FILE\[name\]\?\.note \|\| ''/)
  assert.match(view, /model: item\.note \? `\$\{item\.label\} — \$\{item\.note\}` : item\.label/)
})

// 1023 用户「登记lora的时候要登记配置信息 / 分镜选择lora的时候要产出 lora的配置」：config = 这条 LoRA
// 的用法 + 出处，登记进表、导演挑 key 的清单与 UI 下拉都把它产出、生成从同一份 config 取 steps/strength。
test('LoRA 登记了 config、选择时产出（导演清单 + UI 路由都带它）、生成从 config 取', async () => {
  const agents = readFileSync(new URL('../src/agents/index.ts', import.meta.url), 'utf8')
  const { LORA_REGISTRY } = await import('../src/services/adapters/comfyui-video.ts')
  const c = LORA_REGISTRY.pussy_spread.config
  assert.ok(c, 'pussy_spread 没登记 config')
  assert.equal(c.steps, 20, '1023 用户「换20步」⇒ Free Pussy config.steps=20')
  assert.equal(c.strength, 1.0, '作者没给推荐强度 ⇒ 默认 1.0')
  assert.equal(c.trigger, 'pussy', 'Free Pussy trainedWords = pussy')
  assert.equal(c.trainedOn, 'video', 'video-trained（不毁内容）')
  assert.match(c.source, /2934054/)
  // 「登记时登记配置」是通用规矩、不是只这一条：每条都得有 config
  for (const [k, v] of Object.entries(LORA_REGISTRY)) assert.ok(v.config, `${k} 没登记 config`)
  // 导演挑 key 的清单把 config 产出（agents/index.ts）
  assert.match(agents, /v\.config/)
  assert.match(agents, /配置: /)
  // UI 下拉路由也带 config
  assert.match(route, /config: LORA_BY_FILE\[name\]\?\.config/)
})

// 「能不能挂」的根判据：读两个文件的 safetensors 头（不整读，unet 是几 GB），把 LoRA 的 lora_A/B 键
// 还原成目标权重名，逐个问 unet 有没有 —— 少一个键 = ComfyUI 静默跳过那层。
// 前缀要剥：ComfyUI 的加载器把 LoRA 键里的 diffusion_model. 去掉再去对 unet 的权重名。
// 判据自己先用现役 turbo LoRA（生产天天跑、没它 4 步就是废图）验一遍，它必须也是 0 缺失（「判据先被审」）。
test('登记表里每支 LoRA 的落点与它写的 note 一致（说无效的真没落点，其余 0 缺失）', () => {
  // 参照 = **生产 native 图实际加载的那条 unet**（桥 `__init__.py:437` = minimax_h3_ref2va_pruned_nvfp4，
  // NVFP4、1132 键）—— 不是 fl2va-int8（那是另一个模型）。落点键名与量化档无关，但参照必须是我们真跑的。
  const unetPath = 'E:/AI/ComfyUI/models/diffusion_models/minimax_h3_ref2va_pruned_nvfp4.safetensors'
  const unetKeys = new Set(Object.keys(headerOf(unetPath)).filter((k) => k !== '__metadata__'))
  const targetsOf = (path) => {
    const h = headerOf(path)
    return [...new Set(Object.keys(h).filter((k) => k !== '__metadata__' && k.endsWith('.weight'))
      .map((k) => k.replace(/\.lora_[AB]\.weight$/, '.weight').replace(/^diffusion_model\./, '')))]
  }
  const control = 'minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16.safetensors'
  const ctl = targetsOf('E:/AI/ComfyUI/models/loras/' + control).filter((k) => !unetKeys.has(k))
  assert.equal(ctl.length, 0, `判据本身不对：连现役在跑的 turbo LoRA 都报 ${ctl.length} 个键没落点（前 5：${ctl.slice(0, 5).join(', ')}）`)

  const block = adapter.match(/export const LORA_REGISTRY[\s\S]*?\n\}(\r)?\n/)?.[0] || ''
  const parts = block.split(/\n  (?=[a-z0-9_]+: \{)/).slice(1)
  assert.ok(parts.length >= 8, `登记表条目太少 ${parts.length}`)
  for (const part of parts) {
    const key = (part.match(/^([a-z0-9_]+):/) || [])[1] || '?'
    const name = (part.match(/file: '([^']+)'/) || [])[1] || ''
    const file = 'E:/AI/ComfyUI/models/loras/' + name
    const targets = targetsOf(file)
    const missing = targets.filter((k) => !unetKeys.has(k))
    if (/无效/.test(part)) {
      // note 说它对 H3 无效 —— 那就必须真没落点（否则 note 是错的，会被静默挂上白花时间）
      assert.ok(missing.length > 0, `${key}：note 写「无效」但 ${targets.length} 个键全有落点，note 过时了`)
      continue
    }
    assert.ok(targets.length >= 100, `${key}: 键太少 ${targets.length}`)
    assert.equal(missing.length, 0,
      `${key}（${name}）有 ${missing.length} 个键在 unet 里没有落点，前 5：${missing.slice(0, 5).join(', ')}`)
  }
})

// 1019 用户「这里要根据角色选择合理的提示词。 这里是通用提示词」「分镜提示词开始要加个 不要脱离常识和物理规则」。
// 社区做法（本机已装的 BSAI-ComfyUI-Sol-H3）：`h3_t8/prompt_rewriter_8b.py:92` 把物理常识写成**指令条**
// （"Keep all actions physically plausible and paced to complete within the supplied duration."），
// `h3_t8/mv_lipsync_advanced.py:655` 更狠 —— 直接**校验成品提示词**、缺词就抛 ValueError，不靠模型自觉。
// ⇒ 颜色档与物理行都由代码保证（跟 ensureLoraBlock 同一个口径），这条测试锁行为不锁措辞。
test('登记表是通用骨架：{skin} 按角色肤色换档；最优提示词整段引进 + extreme close-up 降级；物理/常识行兜底补写', async () => {
  const { LORA_REGISTRY, loraBestPrompt } = await import('../src/services/adapters/comfyui-video.ts')
  const { ensureLoraBlock, ensurePhysics, PHYS_CN, PHYS_EN } = await import('../src/services/video-prompts.ts')
  assert.ok(LORA_REGISTRY.pussy_spread.prompt.includes('{skin}'), '登记表这段该是通用骨架、颜色留占位')
  const BEST = loraBestPrompt('pussy_spread')
  assert.ok(!BEST.includes('{skin}'), '没给角色文本时也要把占位换成默认档')
  assert.match(BEST, /labia rosy pink/) // 1019 用户「不够粉嫩」⇒ 默认档 = pink
  assert.match(loraBestPrompt('pussy_spread', '肤色偏黑'), /labia brown, a shade darker/)
  assert.match(loraBestPrompt('pussy_spread', '小麦色皮肤'), /matching her own skin tone/)
  assert.equal(loraBestPrompt('nope'), '')
  assert.equal(loraBestPrompt('skin_realism'), 'r34l1sm') // 没写 prompt 字段的 = 触发词本身就是全部描述语
  // 兜底引进：只有概念词 → 换成整段；整段已在 → 不动（幂等）；`extreme close-up` → 降到 close-up
  const onlyConcept = 'detailed_description:\n[Shot 2] her vulva, pussy spread, candlelight.\noverall_soundscape:\nbed creaks'
  const once = ensureLoraBlock(onlyConcept, BEST)
  assert.ok(once.includes(BEST), '只有触发词时要用整段替换')
  assert.ok(once.includes('soft neutral light'), '登记表里的光词要带进来')
  assert.equal(ensureLoraBlock(once, BEST), once, '整段已在时不许重复插')
  assert.ok(!/extreme close-up/.test(ensureLoraBlock('[Shot 1] an extreme close-up of her face\noverall_soundscape:\nquiet hums', BEST)),
    '1019 实测 extreme close-up 把器官画满整幅（用户「阴部太大了」）⇒ 带这段的镜一律降级')
  // 1021 用户「不要描述阴道的形状 可以说颜色」⇒ 挂在解剖名词上的尺寸/形状形容词由代码摘掉、颜色词一律不动
  const shaped = ensureLoraBlock('detailed_description:\n[Shot 1] a small narrow vulva, labia modest in frame, inserting from the closed narrow cleft, labia rosy pink\noverall_soundscape:\ncreaks', BEST)
  assert.ok(!/small narrow vulva|modest in frame|narrow cleft/.test(shaped), '尺寸/形状词要摘干净（它们与 pussy spread 反义）')
  assert.match(shaped, /labia rosy pink/, '颜色词不许被摘（用户「可以说颜色」）')
  assert.ok(shaped.includes(BEST), '登记表引进的禁止词行不许被这层兜底改写弄坏')
  assert.equal(ensureLoraBlock(shaped, BEST), shaped, '幂等')
  // 1021 库里存的**老整段**（1019 版带尺寸词）要原地换掉，不许「老的留着 + 新的再插一遍」
  const oldBlock = 'detailed_description:\n[Shot 1] a close-up framed below the waist, pussy spread, a small narrow vulva, labia modest in frame, labia rosy pink, soft neutral light on her vulva. the camera holds a static shot\noverall_soundscape:\ncreaks'
  const fixed = ensureLoraBlock(oldBlock, BEST)
  assert.ok(!/small narrow vulva|labia modest/.test(fixed), '老整段里的尺寸词要跟着一起被换掉')
  assert.equal((fixed.match(/pussy spread/gi) || []).length, 1, '不许留老的再插新的（实测会拼出 labia labia）')
  assert.ok(/the camera holds a static shot/.test(fixed), '换段不许吃掉后面那句')
  assert.equal(ensureLoraBlock(fixed, BEST), fixed, '换完再跑一遍要逐字不变')
  // 物理/常识行：缺了补在信息头之后 / detailed_description 之后
  const [vp, fr] = ensurePhysics('出场人物：@A；场景：@卧室。\n0-3秒：A 舔 B。',
    'detailed_description:\n[Shot 1] ...\noverall_soundscape:\n...')
  assert.ok(vp.split('\n')[1].startsWith(PHYS_CN.slice(0, 12)), '中文行要紧跟信息头')
  assert.ok(fr.includes(PHYS_EN), '英文行要进 full_ref')
  assert.ok(/detailed_description:\s*\nNo anatomy/.test(fr), '英文行要在 [Shot 1] 之前')
  assert.deepEqual(ensurePhysics(vp, fr), [vp, fr], '幂等')
  assert.ok(!/切到|切回|cuts to|transitions to/.test(PHYS_CN + PHYS_EN), '这两句里不许有切镜词（会被切镜数硬校验误计一刀）')
})

// 清单接口 + 那个下拉：列表走后端只读接口（生成仍然只走 /api/v1/tasks），非 comfyui 配置不显示
test('LoRA 清单走后端只读接口、路由挂上、前端接上', () => {
  assert.match(route, /object_info\/LoraLoaderModelOnly/)
  assert.match(route, /config\.provider !== 'comfyui'/)
  assert.match(route, /AbortSignal\.timeout\(6000\)/)
  assert.match(route, /items: \[\], error:/)   // 6006 没起来回空清单而不是报错，工作台照常能发车
  assert.match(indexTs, /api\.route\('\/comfyui\/loras', comfyuiLoras\)/)
  assert.match(useApi, /export const comfyuiAPI = \{/)
  assert.match(useApi, /api\.get\(`\/comfyui\/loras\$\{configId/)
})

test('工作台上方那个 LoRA 下拉：只在 comfyui 配置下出现，没选 = 完全不传', () => {
  assert.match(view, /v-if="loraOptions\.length"/)
  assert.match(view, /:default-label="t\('episode\.model\.loraNone'\)"/)
  assert.match(view, /lora: isComfyuiVideo\.value && loraModel\.value \? loraModel\.value : undefined/)
  assert.match(view, /watch\(isComfyuiVideo, loadComfyuiLoras\)/)
  assert.match(view, /const loraModel = ref\(readStoredModel\(MODEL_STORE_KEYS\.lora\)\)/)
})

test('四种语言都有 LoRA 文案', () => {
  for (const lang of ['zh', 'en', 'ja', 'ko']) {
    const j = JSON.parse(readFileSync(new URL(`../../frontend/app/locales/${lang}.json`, import.meta.url), 'utf8'))
    assert.ok(j.episode.topbar.lora, `${lang} 缺下拉标签`)
    assert.ok(j.episode.model.loraNone && j.episode.model.loraStrength && j.episode.model.loraStrengthHint,
      `${lang} 缺 LoRA 面板文案`)
    assert.ok(j.episode.model.loraStrengthHint.includes('0.6'), `${lang} 的强度提示该带上作者的轻档数`)
  }
})

// 1025 用户「要」平台守卫：画面差的根因 = full_ref 引用了 N 个 <Picture>、却只送 M<N 张参考图
// （场景/道具图没生成 → 多出来的 <Picture> 绑空槽 → 场景道具纯靠文字现编、画面塌）。以前静默照发，
// 只有人眼事后发现。这条锁「当场拒发 + 只在 comfyui 上判 + 送齐就放行」。
test('comfyui 参考图数 < full_ref 的 <Picture> 数时当场拒发', async () => {
  const { validateVideoRequest } = await import('../src/routes/tasks.ts')
  const mk = (refs, prompt) => ({
    prompt, reference_image_urls: refs, reference_video_urls: [],
    reference_audio_urls: [], official_media: [],
  })
  const p7 = 'detailed_description:\n[Shot 1] <Picture 1> and <Picture 7> the arena stage'
  // 只送 4 张、引用到 Picture 7 → 报错，且报出缺的是场景/道具图
  const err = validateVideoRequest(mk(['a', 'b', 'c', 'd'], p7), 'comfyui')
  assert.ok(err && /<Picture 7>/.test(err) && /4 张参考图/.test(err), `引用超过参考图数必须拒发，实际：${err}`)
  // 送齐 7 张 → 放行
  assert.equal(validateVideoRequest(mk(['1', '2', '3', '4', '5', '6', '7'], p7), 'comfyui'), null)
  // 非 comfyui 不吃这条（别的厂商没有 <Picture> 语义，同样的不匹配照发）
  assert.equal(validateVideoRequest(mk(['a', 'b', 'c', 'd'], p7), 'volcengine'), null)
  // 没有 <Picture> 标签的提示词（老行为）不受影响
  assert.equal(validateVideoRequest(mk(['a'], 'no tags here'), 'comfyui'), null)
})

function headerOf(path) {
  const fd = openSync(path, 'r')
  try {
    const first = Buffer.alloc(8)
    readSync(fd, first, 0, 8, 0)
    const len = Number(first.readBigUInt64LE(0))
    const buf = Buffer.alloc(len)
    readSync(fd, buf, 0, len, 8)
    return JSON.parse(buf.toString('utf8'))
  } finally { closeSync(fd) }
}
