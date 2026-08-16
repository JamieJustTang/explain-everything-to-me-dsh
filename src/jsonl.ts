/** Shared JSONL line decoding for the foreign-session parsers. */

/**
 * Parse one JSONL line into a record-shaped object.
 * @param line - one line of a foreign session file.
 * @returns the parsed object, or `undefined` for a malformed line, a
 * non-object value, or an array.
 */
export function parseJsonlLine(line: string): Record<string, unknown> | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
  return parsed as Record<string, unknown>
}
