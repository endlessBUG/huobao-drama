// 1122 服饰解析：某镜某角色穿哪套 —— 优先本镜绑定，否则向本集更早的镜头回溯（继承上一镜）。
import { and, eq, lte, isNull, desc } from 'drizzle-orm'
import { db, schema } from '../db/index.js'

/** 返回该镜该角色应使用的服饰图（组合三视图优先，其次服饰图）；没有服饰绑定返回 null */
export async function resolveOutfitUrl(characterId: number, storyboardId: number): Promise<string | null> {
  const [sb] = await db.select().from(schema.storyboards).where(eq(schema.storyboards.id, storyboardId))
  if (!sb) return null
  const rows = await db.select({
    outfitId: schema.storyboardOutfits.outfitId,
    num: schema.storyboards.storyboardNumber,
  })
    .from(schema.storyboardOutfits)
    .innerJoin(schema.storyboards, eq(schema.storyboards.id, schema.storyboardOutfits.storyboardId))
    .where(and(
      eq(schema.storyboardOutfits.characterId, characterId),
      eq(schema.storyboards.episodeId, sb.episodeId),
      lte(schema.storyboards.storyboardNumber, sb.storyboardNumber),
    ))
    .orderBy(desc(schema.storyboards.storyboardNumber))
  for (const r of rows) {
    const [o] = await db.select().from(schema.characterOutfits)
      .where(and(eq(schema.characterOutfits.id, r.outfitId), isNull(schema.characterOutfits.deletedAt)))
    if (o) {
      // 1122 用户定稿：出片只用「角色×服饰」组合三视图（imageUrl 是衣服三视图、画面里没有人，
      // 当角色参考会把身份换丢）——没有组合三视图就回落角色三视图/肖像。
      if (o.sheetImageUrl) return o.sheetImageUrl
    }
  }
  return null
}
