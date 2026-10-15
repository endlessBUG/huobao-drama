import { toSnakeCaseArray } from '../utils/transform.js'
import { getDramaStylePrompt } from './style-preset.js'

/**
 * 三视图骨架句 —— 与 workspace/skills/prompt-generator/character-prompt/SKILL.md 的
 * 「输出结构」一致（那份是给 agent 看的规范，这里是空框时的兜底，两边改动要同步）。
 * 只取骨架句：这套版式是产品给的默认值，[槽位]（长什么样、穿什么）由用户在框里自己写。
 */
const SHEET_SKELETON_WITH_REF = [
  '以参考图中的同一人物为准，脸型、五官、发型、肤色、妆容、服装与配饰一律照参考图原样保留，只改变角度与构图',
  '角色设定参考图，左侧为正脸特写，右侧并列展示正面、90 度侧面、背面三张等高全身视图',
  '特写与全身视图都是同一角色，全身入镜，中性 A 字站姿，三张全身视图等高并排、头顶脚底对齐',
  '正脸特写与三个视图的脸、发型和服装完全一致，妆容与配饰同样一致，且与参考图是同一人',
  '纯白背景，柔和均匀的光线，电影质感',
].join('，')

const SHEET_SKELETON_TEXT_ONLY = [
  '角色设定参考图，左侧为正脸特写，右侧并列展示正面、90 度侧面、背面三张等高全身视图',
  '特写与全身视图都是同一角色，全身入镜，中性 A 字站姿，三张全身视图等高并排、头顶脚底对齐',
  '正脸特写与三个视图的脸、发型和服装完全一致，妆容与配饰同样一致',
  '纯白背景，柔和均匀的光线，电影质感',
].join('，')

/**
 * 空框时真正发给模型的提示词（= 框里显示的默认值）：项目视觉风格 + 三视图骨架。
 * 带参考图的骨架（「服装与配饰一律照参考图原样保留」）只在真有参考图时带，判定口径同 referenceImageFor()
 * —— 参考图是用户上传的原图（localPath），不是上一轮生成的产物。
 */
export function characterSheetDefaultPrompt(stylePrompt: string, hasRefImage: boolean): string {
  return [stylePrompt || '', hasRefImage ? SHEET_SKELETON_WITH_REF : SHEET_SKELETON_TEXT_ONLY].filter(Boolean).join(', ')
}

/**
 * 角色列表 + `sheet_default_prompt`：前端把它显示在「最终提示词」框里（空框时），
 * 所以这串必须与生成时用的默认值**逐字一致** —— 别在前端再抄一份。
 */
export async function charactersWithSheetDefault<T extends { localPath?: string | null }>(chars: T[], dramaId: number | null | undefined) {
  const stylePrompt = await getDramaStylePrompt(dramaId)
  return toSnakeCaseArray(chars as any).map((ch) => ({
    ...ch,
    sheet_default_prompt: characterSheetDefaultPrompt(stylePrompt, !!(ch as any).local_path),
  }))
}
