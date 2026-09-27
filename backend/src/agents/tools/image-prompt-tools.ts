/**
 * 提示词生成 Agent 工具
 * 模块级单例 — dramaId 通过 RequestContext 按请求注入
 *
 * Agent 负责创作最终提示词：
 * 1. 场景 → 固定视角 + 前景/中景/后景分层构图
 * 2. 道具 → 白底单品静物（single product shot on pure white background）
 * （角色提示词不在这里：完全由用户在详情页手写，见 routes/characters.ts）
 * 工具负责读取资产信息与保存 Agent 产出的最终提示词（保存时注入项目视觉风格）
 */
import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import { db, schema } from '../../db/index.js'
import { eq } from 'drizzle-orm'
import { now } from '../../utils/response.js'
import { getDramaStylePrompt } from '../../services/style-preset.js'
import { getDramaId } from '../context.js'

// ─── 场景提示词 ───────────────────────────────────────

const readScenes = createTool({
  id: 'read_scenes',
  description: '读取当前剧集中的所有场景信息，用于生成场景固定视角最终提示词。',
  inputSchema: z.object({}),
  execute: async (_input, context) => {
    const dramaId = getDramaId(context?.requestContext)
    if (!dramaId) return { error: 'Missing dramaId in request context' }
    const scenes = (await db.select().from(schema.scenes)
      .where(eq(schema.scenes.dramaId, dramaId)))
      .filter(s => !s.deletedAt)
    return {
      scenes: scenes.map(s => ({
        id: s.id,
        location: s.location,
        time: s.time || '',
        prompt: s.prompt || '',
        lighting: s.lighting || '',
        final_prompt: s.finalPrompt || '',
      })),
    }
  },
})

const saveSceneFinalPrompt = createTool({
  id: 'save_scene_final_prompt',
  description: '保存为场景创作的固定视角（前景/中景/后景）最终提示词。项目视觉风格会由工具自动拼接，prompt 参数中不要包含风格词。',
  inputSchema: z.object({
    scene_id: z.number(),
    prompt: z.string().describe('场景固定视角最终提示词（使用会话语言指令指定的目标语言，不含风格词）'),
  }),
  execute: async ({ scene_id, prompt }, context) => {
    const dramaId = getDramaId(context?.requestContext)
    if (!dramaId) return { error: 'Missing dramaId in request context' }
    const [s] = await db.select().from(schema.scenes)
      .where(eq(schema.scenes.id, scene_id))
    if (!s) return { error: 'Scene not found' }

    const stylePrompt = await getDramaStylePrompt(dramaId)
    const finalPrompt = stylePrompt ? `${stylePrompt}, ${prompt}` : prompt
    await db.update(schema.scenes)
      .set({ finalPrompt, updatedAt: now() })
      .where(eq(schema.scenes.id, scene_id))

    return {
      scene_id: s.id,
      location: s.location,
      saved: true,
      final_prompt: finalPrompt,
    }
  },
})

const saveSceneGridPrompt = createTool({
  id: 'save_scene_grid_prompt',
  description: '保存为场景创作的九宫格（3x3 多角度）最终提示词。项目视觉风格会由工具自动拼接，prompt 参数中不要包含风格词。',
  inputSchema: z.object({
    scene_id: z.number(),
    prompt: z.string().describe('场景九宫格最终提示词（3x3 固定 9 视角，无人物；模板结构/标签恒英文，语言跟随会话指令，不含风格词）'),
  }),
  execute: async ({ scene_id, prompt }, context) => {
    const dramaId = getDramaId(context?.requestContext)
    if (!dramaId) return { error: 'Missing dramaId in request context' }
    const [s] = await db.select().from(schema.scenes)
      .where(eq(schema.scenes.id, scene_id))
    if (!s) return { error: 'Scene not found' }

    const stylePrompt = await getDramaStylePrompt(dramaId)
    const finalPrompt = stylePrompt ? `${stylePrompt}, ${prompt}` : prompt
    await db.update(schema.scenes).set({
      gridPrompt: finalPrompt,
      updatedAt: now(),
    }).where(eq(schema.scenes.id, scene_id))

    return {
      scene_id: s.id,
      location: s.location,
      saved: true,
      grid_prompt: finalPrompt,
    }
  },
})

// ─── 道具提示词 ───────────────────────────────────────

const readProps = createTool({
  id: 'read_props',
  description: '读取当前剧集项目中的所有道具信息，用于生成道具白底单品最终提示词。',
  inputSchema: z.object({}),
  execute: async (_input, context) => {
    const dramaId = getDramaId(context?.requestContext)
    if (!dramaId) return { error: 'Missing dramaId in request context' }
    const props = (await db.select().from(schema.props)
      .where(eq(schema.props.dramaId, dramaId)))
      .filter(p => !p.deletedAt)
    return {
      props: props.map(p => ({
        id: p.id,
        name: p.name,
        type: p.type || '',
        description: p.description || '',
        final_prompt: p.finalPrompt || '',
      })),
    }
  },
})

const savePropFinalPrompt = createTool({
  id: 'save_prop_final_prompt',
  description: '保存为道具创作的白底单品最终提示词。项目视觉风格会由工具自动拼接，prompt 参数中不要包含风格词。',
  inputSchema: z.object({
    prop_id: z.number(),
    prompt: z.string().describe('道具白底单品最终提示词（使用会话语言指令指定的目标语言，不含风格词）'),
  }),
  execute: async ({ prop_id, prompt }, context) => {
    const dramaId = getDramaId(context?.requestContext)
    if (!dramaId) return { error: 'Missing dramaId in request context' }
    const [p] = await db.select().from(schema.props)
      .where(eq(schema.props.id, prop_id))
    if (!p) return { error: 'Prop not found' }

    const stylePrompt = await getDramaStylePrompt(dramaId)
    const finalPrompt = stylePrompt ? `${stylePrompt}, ${prompt}` : prompt
    await db.update(schema.props)
      .set({ finalPrompt, updatedAt: now() })
      .where(eq(schema.props.id, prop_id))

    return {
      prop_id: p.id,
      prop_name: p.name,
      saved: true,
      final_prompt: finalPrompt,
    }
  },
})

export const imagePromptTools = {
  readScenes,
  saveSceneFinalPrompt,
  saveSceneGridPrompt,
  readProps,
  savePropFinalPrompt,
}
