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
  assert.match(tasks, /lora: videoBody!\.lora,/)
  assert.match(tasks, /loraStrength: videoBody!\.lora_strength \?\? videoBody!\.loraStrength,/)
  assert.match(tasks, /loraTrigger: videoBody!\.lora_trigger \?\? videoBody!\.loraTrigger,/)
})

test('adapter：body 带 lora / lora_strength，触发词按每支的口径塞（没登记的 LoRA 不塞词）', () => {
  assert.match(adapter, /export const LORA_REGISTRY: Record<string, \{ t\?: string; replace\?: RegExp; note: string \}\>/)
  assert.match(adapter, /'h3-realism-people-t2v-i2v-r2v\.safetensors': \{ t: 'r34l1sm',/)
  // HMInnie 的触发词是「替换」不是「前置」（README 原话），而且复合词 pussy lips / juice / focus 必须留着
  assert.match(adapter, /'HMInnie_v1_e50\.safetensors': \{ t: 'inniepussy', replace: \/\\bpussy\\b\(\?!\\s\+\(lips\|juice\|focus\|presentation\)\)\/gi,/)
  // HMPussy V1 只登记 note 不登记 t：它的触发词就是普通词 pussy，提示词里本来就有，前置是重复
  assert.match(adapter, /'Vagina_minimax-h3_epoch20\.safetensors': \{\n\s*note:/)
  // lora_trigger:false = 只挂权重不碰词（C 臂换了 6 处，不归因清楚就别选它进生产）
  assert.match(adapter, /const tr = record\.lora && record\.loraTrigger !== false \? LORA_REGISTRY\[record\.lora\] : undefined/)
  assert.match(adapter, /const prompt = !tr\?\.t \? base : tr\.replace \? base\.replace\(tr\.replace, tr\.t\) : `\$\{tr\.t\} \$\{base\}`/)
  assert.match(adapter, /lora: record\.lora \|\| undefined,/)
  assert.match(adapter, /lora_strength: record\.lora \? \(record\.loraStrength \?\? 1\.0\) : undefined,/)
})

// 用户要求「lora 后面要写上 lora 的作用」：登记了就必须有 note，note 走接口到下拉
test('登记表里每一支都写了作用，且前端把它拼在名字后面', () => {
  const block = adapter.match(/export const LORA_REGISTRY[\s\S]*?\n\}/)?.[0] || ''
  const entries = [...block.matchAll(/'([^']+\.safetensors)':\s*\{([^}]*)\}/g)]
  assert.ok(entries.length >= 8, `登记表条目太少 ${entries.length}`)
  for (const [, name, body] of entries) {
    assert.ok(/note:/.test(body), `${name} 登记了却没写 note —— 下拉里就只剩文件名`)
    assert.ok(body.match(/note: '([^']{10,})'/), `${name} 的 note 太短或没引号`)
  }
  assert.match(route, /note: LORA_REGISTRY\[name\]\?\.note \|\| ''/)
  assert.match(view, /model: item\.note \? `\$\{item\.label\} — \$\{item\.note\}` : item\.label/)
})

// 「能不能挂」的根判据：读两个文件的 safetensors 头（不整读，unet 是几 GB），把 LoRA 的 lora_A/B 键
// 还原成目标权重名，逐个问 unet 有没有 —— 少一个键 = ComfyUI 静默跳过那层。
// 前缀要剥：ComfyUI 的加载器把 LoRA 键里的 diffusion_model. 去掉再去对 unet 的权重名。
// 判据自己先用现役 turbo LoRA（生产天天跑、没它 4 步就是废图）验一遍，它必须也是 0 缺失（「判据先被审」）。
test('登记表里每支 LoRA 的落点与它写的 note 一致（说无效的真没落点，其余 0 缺失）', () => {
  const unetPath = 'E:/AI/ComfyUI/models/diffusion_models/minimax_h3_fl2va_pruned_int8_convrot.safetensors'
  const unetKeys = new Set(Object.keys(headerOf(unetPath)).filter((k) => k !== '__metadata__'))
  const targetsOf = (path) => {
    const h = headerOf(path)
    return [...new Set(Object.keys(h).filter((k) => k !== '__metadata__' && k.endsWith('.weight'))
      .map((k) => k.replace(/\.lora_[AB]\.weight$/, '.weight').replace(/^diffusion_model\./, '')))]
  }
  const control = 'minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16.safetensors'
  const ctl = targetsOf('E:/AI/ComfyUI/models/loras/' + control).filter((k) => !unetKeys.has(k))
  assert.equal(ctl.length, 0, `判据本身不对：连现役在跑的 turbo LoRA 都报 ${ctl.length} 个键没落点（前 5：${ctl.slice(0, 5).join(', ')}）`)

  const block = adapter.match(/export const LORA_REGISTRY[\s\S]*?\n\}/)?.[0] || ''
  const entries = [...block.matchAll(/'([^']+\.safetensors)':\s*\{([^}]*)\}/g)]
  assert.ok(entries.length >= 8, `登记表条目太少 ${entries.length}`)
  for (const [, name, body] of entries) {
    const file = 'E:/AI/ComfyUI/models/loras/' + name
    const targets = targetsOf(file)
    const missing = targets.filter((k) => !unetKeys.has(k))
    if (/无效/.test(body)) {
      // note 说它对 H3 无效 —— 那就必须真没落点（否则 note 是错的，会被静默挂上白花时间）
      assert.ok(missing.length > 0, `${name}：note 写「无效」但 ${targets.length} 个键全有落点，note 过时了`)
      continue
    }
    assert.ok(targets.length >= 100, `${name}: 键太少 ${targets.length}`)
    assert.equal(missing.length, 0,
      `${name} 有 ${missing.length} 个键在 unet 里没有落点，前 5：${missing.slice(0, 5).join(', ')}`)
  }
})

// 替换那条正则的行为（从 adapter 源码里取，不另写一份 —— 否则测试和代码会各漂各的）
test('inniepussy 只换独立成词的 pussy，复合词全部留着', () => {
  const src = adapter.match(/replace: (\/\\bpussy\\b\(\?!.*?\/[a-z]+)/)?.[1]
  assert.ok(src, '找不到那条 replace 正则')
  const re = new Function('return ' + src)()
  const s = 'her pussy filling, the pussy lips closed, pink and wet, wet with pussy juice, ' +
    'the detailed realistic innie pussy with pussy focus, one thin closed cleft'
  const out = s.replace(re, 'inniepussy')
  assert.ok(out.includes('her inniepussy filling'), '主词没被换掉')
  assert.ok(out.includes('innie inniepussy with'), 'innie pussy 也该被换（它就是那个 shape 控制）')
  for (const keep of ['pussy lips closed', 'pussy juice', 'pussy focus'])
    assert.ok(out.includes(keep), `${keep} 被误换了：${out}`)
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
