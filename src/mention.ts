/**
 * Inline `foreign-session:` mention extraction from user-typed text.
 * @module @deepseek-ai/dsh-foreign-transcript/mention
 */

/** URI scheme prefix recognized in user text. */
export const FOREIGN_SESSION_SCHEME = 'foreign-session:'

/** Markdown-link mentions first, then bare scheme tokens. */
const MENTION_PATTERN = /@\[[^\]]*\]\(foreign-session:[^)\s]*\)|foreign-session:[^\s)]*/gu

/**
 * Trailing sentence punctuation a bare mention cannot end with: text that
 * follows the mention in prose, never part of a specifier. Paths and the
 * `?latest` suffix never end with these, so only the final run is trimmed.
 */
const TRAILING_PUNCTUATION = '.,;:!?、，。；：！？）」』"\''

/**
 * Trim the trailing punctuation run off one mention payload.
 * @param token - matched mention text without the scheme prefix.
 * @returns the token without trailing prose punctuation.
 */
function trimTrailingPunctuation(token: string): string {
  let end = token.length
  while (end > 0 && TRAILING_PUNCTUATION.includes(token[end - 1] as string)) end--
  return token.slice(0, end)
}

/**
 * Extract foreign-session specifiers from one text value.
 *
 * Both `@[label](foreign-session:claude)` markdown links and bare
 * `foreign-session:<specifier>` tokens are recognized, with any trailing
 * sentence punctuation treated as prose. Duplicate specifiers collapse to
 * their first appearance.
 *
 * @param text - one user-typed text block.
 * @returns unique specifiers in appearance order, without the scheme prefix.
 */
export function extractForeignMentions(text: string): string[] {
  const specifiers: string[] = []
  for (const match of text.matchAll(MENTION_PATTERN)) {
    const token = match[0]
    const open = token.indexOf('(')
    const payload = open >= 0 ? token.slice(open + 1, -1) : token
    const specifier = trimTrailingPunctuation(payload.slice(FOREIGN_SESSION_SCHEME.length))
    if (specifier !== '' && !specifiers.includes(specifier)) specifiers.push(specifier)
  }
  return specifiers
}
