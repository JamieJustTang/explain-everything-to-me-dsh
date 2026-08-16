/** Shared line-bounding helper for tool-call briefs. */

/**
 * Bound one brief line to a character cap.
 * @param text - candidate brief of any length.
 * @param limit - character cap; the result never exceeds it.
 * @returns the text, or its head with an ellipsis when it exceeds the cap.
 */
export function ellipsize(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, Math.max(0, limit - 1))}…`
}
