/**
 * 提示词库工具（全局、纯文字、无图）
 * 两步取：第一次不带参数 → 只回清单（id / 分组 / 标题 / 被用次数，不带正文，省 token）；
 *         第二次带 ids → 回那些条的完整正文 + 备注。
 * 清单每次写提示词前都拿一遍，正文只在需要那条时拉 ⇒ 加条目不增加每次调用的 token。
 * 只有被取过详情的条目 hits++，列表按 hits 降序 = 「常用」的口径。
 */
import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import { db, schema } from '../../db/index.js'
import { eq } from 'drizzle-orm'

async function bumpHits(ids: number[]) {
  for (const id of ids) {
    const [row] = await db.select({ hits: schema.promptLibrary.hits }).from(schema.promptLibrary)
      .where(eq(schema.promptLibrary.id, id))
    await db.update(schema.promptLibrary).set({ hits: (row?.hits || 0) + 1 })
      .where(eq(schema.promptLibrary.id, id))
  }
}

const readPromptLibrary = createTool({
  id: 'read_prompt_library',
  description: '读取共享提示词库：全局共用、纯文字、没有图，每条都是本机真跑过、验证过的写法（用词、形状、细节开关、踩过的坑）。用法分两步 —— 第一次不带任何参数调用，返回条目清单（id、分组、标题、被用次数），清单里不含正文；看到哪条跟当前镜头有关，就带它的 id 再调用一次，返回那条的完整正文和备注。写视频提示词、场景 / 道具的最终提示词、以及优化角色提示词之前都必须先走第一步（清单里有社区技法条目：场景技法 / 人物技法 / 道具技法），按当前题材最多取 1-2 条正文，不要整本读、不要凭记忆造词。',
  inputSchema: z.object({
    ids: z.array(z.number()).optional().describe('第二次调用用：要取详情的条目 id 列表（来自第一次返回的清单）。不传 = 只回清单。'),
    q: z.string().optional().describe('给清单做子串过滤（标题 / 内容 / 备注），只影响第一步。'),
  }),
  execute: async (input) => {
    const rows = await db.select().from(schema.promptLibrary)
    const active = rows.filter(r => r.isActive)
    const byUse = (a: any, b: any) => (b.hits || 0) - (a.hits || 0) || a.id - b.id

    if (input.ids?.length) {
      const want = new Set(input.ids)
      const picked = active.filter(r => want.has(r.id)).sort(byUse)
      void bumpHits(picked.map(r => r.id))
      return {
        mode: 'detail',
        matched: picked.length,
        entries: picked.map(r => ({
          id: r.id, group: r.groupName, title: r.title,
          text: r.text, note: r.note || '', hits: r.hits || 0,
        })),
      }
    }

    const needle = (input.q || '').toLowerCase()
    const pool = needle
      ? active.filter(r => r.title.toLowerCase().includes(needle) ||
          r.text.toLowerCase().includes(needle) || (r.note || '').toLowerCase().includes(needle))
      : active
    return {
      mode: 'index',
      total: pool.length,
      groups: Object.fromEntries(pool.reduce((acc, r) => {
        acc.set(r.groupName, (acc.get(r.groupName) || 0) + 1)
        return acc
      }, new Map<string, number>()).entries()),
      // 清单只给 id / 分组 / 标题 / 常用度，正文要第二次调用按 id 取
      entries: pool.sort(byUse).map(r => ({
        id: r.id, group: r.groupName, title: r.title, hits: r.hits || 0,
      })),
    }
  },
})

export const promptLibraryTools = { readPromptLibrary }
