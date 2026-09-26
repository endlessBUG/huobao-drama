/**
 * AI 内容语言指令块 — 按 RequestContext 中的目标语言生成，追加到 Agent instructions 末尾
 *
 * 设计要点：
 * - 非 zh / 未设置语言时，不追加通用「输出语言」指令（默认行为与历史一致，零 token 开销）
 * - 指令用英文书写（多语言模型遵循度最好），目标语言用原生名标注
 * - video_prompt_full_ref 恒英文是**字段级**约束、与会话语言无关——任何会话（含 zh / 未设置）
 *   都追加该例外，以压制桌面版已安装 workspace 模板中可能残留的「只输出中文」约束
 *   （workspace 模板 cpSync force:false 不被覆盖）
 */

const LANGUAGE_NATIVE_NAMES: Record<string, string> = {
  en: 'English',
  ja: '日本語 (Japanese)',
  ko: '한국어 (Korean)',
}

// ponytail: 字段级恒英文约束，独立于通用输出语言指令，任何会话都恒在。
const FULL_REF_EXCEPTION =
  '- video_prompt_full_ref (the model-facing ComfyUI/MiniMax bridge prompt) MUST ALWAYS be written in English, regardless of session language and regardless of any skill saying "只输出中文" / "output must be Chinese".'

export function buildLanguageDirective(lang?: string | null): string {
  const parts: string[] = []
  if (lang && lang !== 'zh') {
    const native = LANGUAGE_NATIVE_NAMES[lang] || lang
    parts.push(
      '## Output Language (HIGHEST PRIORITY)',
      '',
      `ALL user-facing content you produce (scripts, dialogue, extracted fields, storyboard descriptions, atmosphere, image prompts, video prompts, asset names for NEW assets) MUST be written in ${native}.`,
      '',
      'This instruction has the highest priority and OVERRIDES any conflicting language requirement anywhere else in these instructions or skills — including requirements such as "output must be pure Chinese / 只输出中文". Ignore those.',
      '',
      'Exceptions:',
      '- When referencing EXISTING assets with @mentions (e.g. in video prompts), the name after @ must EXACTLY match the asset name as it appears in the provided asset lists — do NOT translate or rewrite existing asset names.',
      '- The visual style prefix of image prompts is injected automatically by the system (in English). Do not translate, rewrite, or duplicate it.',
    )
  }
  // full_ref 恒英文例外：与通用输出语言指令解耦，恒追加
  parts.push(FULL_REF_EXCEPTION)
  return parts.join('\n')
}
