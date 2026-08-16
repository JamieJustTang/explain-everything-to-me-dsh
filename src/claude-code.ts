/**
 * Parser for Claude Code session logs (`~/.claude/projects/<project>/<session>.jsonl`),
 * written by both the Claude Code CLI and Claude Desktop's agent sessions.
 * @module @deepseek-ai/dsh-foreign-transcript/claude-code
 */

import { ellipsize } from './brief.ts'
import { ForeignTranscriptError } from './config.ts'
import { TranscriptAccumulator } from './accumulator.ts'
import { parseJsonlLine } from './jsonl.ts'
import type { ForeignTranscript, ForeignTranscriptItem } from './types.ts'

/** Record types this parser recognizes; anything else in a line is skipped. */
export const CLAUDE_RECORD_TYPES = new Set([
  'summary',
  'user',
  'assistant',
  'attachment',
  'queue-operation',
  'system',
  'file-history-snapshot',
])

/** One content block of a Claude message array; fields are probed per kind. */
interface ClaudeBlock {
  readonly type?: unknown
  readonly text?: unknown
  readonly name?: unknown
  readonly input?: unknown
}

/** One shape a `message.content` value can take across Claude Code versions. */
type ClaudeContent = undefined | string | readonly ClaudeBlock[]

/** One parsed JSONL record before narrowing; fields are probed per kind. */
interface ClaudeRecord {
  readonly type?: unknown
  readonly isSidechain?: unknown
  readonly isMeta?: unknown
  readonly summary?: unknown
  readonly cwd?: unknown
  readonly gitBranch?: unknown
  readonly sessionId?: unknown
  readonly timestamp?: unknown
  readonly message?: {
    readonly role?: unknown
    readonly model?: unknown
    readonly content?: ClaudeContent
  }
}

/**
 * Parse one Claude Code session log into the neutral transcript model.
 *
 * Skips subagent sidechains, hook attachments, queued-prompt operations, meta
 * notices, and tool results; keeps human user text, assistant text, tool-call
 * one-liners, and summary rows from resumed sessions. Malformed lines (a torn
 * tail from a crashed writer) are skipped.
 *
 * @param text - complete session file contents.
 * @param briefLimit - character cap for one tool-call brief line.
 * @returns the parsed transcript.
 * @throws {@link ForeignTranscriptError} with `FOREIGN_TRANSCRIPT_UNRECOGNIZED_FILE` when no line carries a known record type.
 */
export function parseClaudeCodeTranscript(text: string, briefLimit: number): ForeignTranscript {
  const state = new TranscriptAccumulator()
  for (const line of text.split('\n')) {
    if (line.length === 0) continue
    const record: ClaudeRecord | undefined = parseJsonlLine(line)
    if (record === undefined) continue
    const type = record.type
    if (typeof type !== 'string' || !CLAUDE_RECORD_TYPES.has(type)) continue
    state.recognized = true
    if (typeof record.cwd === 'string' && state.cwd === undefined) state.cwd = record.cwd
    if (typeof record.gitBranch === 'string' && state.gitBranch === undefined) state.gitBranch = record.gitBranch
    if (typeof record.sessionId === 'string' && state.sessionId === '') state.sessionId = record.sessionId
    if (typeof record.timestamp === 'string' && state.startedAt === undefined) state.startedAt = record.timestamp
    if (type !== 'user' && type !== 'assistant' && type !== 'summary') continue
    if (record.isSidechain === true) continue
    if (type === 'summary') {
      if (typeof record.summary === 'string' && record.summary.length > 0) {
        state.items.push({ kind: 'summary', text: record.summary })
      }
      continue
    }
    if (record.isMeta === true) continue
    const content = record.message?.content
    if (typeof record.message?.model === 'string' && state.model === undefined) state.model = record.message.model
    if (type === 'user') {
      const text = userText(content)
      if (text !== '') state.items.push({ kind: 'user', text })
      continue
    }
    if (content !== undefined && typeof content !== 'string') {
      for (const block of content) appendAssistantBlocks(block, state.items, briefLimit)
    }
  }
  if (!state.recognized) {
    throw new ForeignTranscriptError(
      'file contains no recognizable Claude Code session records',
      'FOREIGN_TRANSCRIPT_UNRECOGNIZED_FILE',
    )
  }
  return state.finish('claude')
}

/**
 * Append the assistant-visible parts of one content block.
 * @param block - one assistant message content block.
 * @param items - transcript items collected so far.
 * @param briefLimit - character cap for one tool-call brief line.
 */
function appendAssistantBlocks(
  block: ClaudeBlock,
  items: ForeignTranscriptItem[],
  briefLimit: number,
): void {
  if (block.type === 'text' && typeof block.text === 'string' && block.text.length > 0) {
    items.push({ kind: 'assistant', text: block.text })
  } else if (block.type === 'tool_use' && typeof block.name === 'string') {
    items.push({ kind: 'tool-call', name: block.name, brief: briefFromJson(block.input, briefLimit) })
  }
}

/**
 * Extract human user text from one user-record content value, or `''` when the
 * record is a tool result or holds no text.
 * @param content - the record's `message.content`.
 * @returns the joined text, or `''`.
 */
function userText(content: ClaudeContent): string {
  if (typeof content === 'string') return content
  if (content === undefined) return ''
  const texts: string[] = []
  for (const block of content) {
    if (block.type === 'tool_result') return ''
    if (block.type === 'text' && typeof block.text === 'string') texts.push(block.text)
  }
  return texts.join('\n')
}

/**
 * Render one tool-call argument value as a bounded brief.
 * @param input - the `tool_use` input value.
 * @param briefLimit - character cap for the brief.
 * @returns compact JSON, ellipsized to the cap.
 */
function briefFromJson(input: unknown, briefLimit: number): string {
  if (input === undefined) return ellipsize('null', briefLimit)
  let serialized: string
  try {
    serialized = JSON.stringify(input)
  } catch {
    // JSON.stringify only throws on circular values, which JSON.parse output cannot contain.
    /* v8 ignore next 2 */
    return ''
  }
  return ellipsize(serialized, briefLimit)
}
