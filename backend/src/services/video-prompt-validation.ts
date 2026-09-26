/**
 * 六段式英文全参考提示词结构校验。
 * ponytail: 只验结构（六段 header 齐全 + Subject/Picture 标签 + fully_preserved + <d> 对白），
 * 不验内容语义——内容正确性留给人工/实际生成验证。
 */
const SECTION_HEADERS = [
  /^subject_definitions:/m,
  /^summary:/m,
  /^retention_analysis:/m,
  /^detailed_description:/m,
  /^overall_soundscape:/m,
  /^non_diegetic_music:/m,
] as const

/** 是否满足六段式结构。用于 agent 产物质量门与人工/前端展示判断。 */
export function isVideoPromptFullRefFull(ref: string): boolean {
  if (!ref?.trim()) return false
  return SECTION_HEADERS.every(header => header.test(ref))
    && /<Subject \d+>/.test(ref)
    && /<Picture \d+>/.test(ref)
    && /\bfully_preserved\b/.test(ref)
    && /<d>.*?<\/d>/s.test(ref)
}
