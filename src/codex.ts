/**
 * Parser for Codex session rollout logs
 * (`~/.codex/sessions/YYYY/MM/DD/rollout-<timestamp>-<id>.jsonl`), written by
 * both the Codex CLI and Codex Desktop.
 * @module @deepseek-ai/dsh-foreign-transcript/codex
 */

import { ellipsize } from './brief.ts'
import { ForeignTranscriptError } from './config.ts'
import { TranscriptAccumulator } from './accumulator.ts'
import { parseJsonlLine } from './jsonl.ts'
import type { ForeignTranscript } from './types.ts'

/**
 * Tags wrapping machine-injected user-role content that is not a human turn.
 * Their payloads are session bootstrap material, not conversation.
 */
const SYSTEM_USER_TAGS = /^<(?:environment_context|user_instructions|turn_context|permissions|ide_context|skill_context)[\s>]/u

/** One content block of a Codex message; fields are probed per kind. */
interface CodexBlock {
  readonly type?: unknown
  readonly text?: unknown
}

/** One parsed JSONL record before narrowing; fields are probed per kind. */
interface CodexRecord {
  readonly type?: unknown
  readonly payload?: {
    readonly type?: unknown
    readonly id?: unknown
    readonly session_id?: unknown
    readonly cwd?: unknown
    readonly timestamp?: unknown
    readonly message?: unknown
    readonly role?: unknown
    readonly name?: unknown
    readonly tool_name?: unknown
    readonly input?: unknown
    readonly arguments?: unknown
    readonly action?: { readonly command?: unknown }
    readonly model?: unknown
    readonly git?: { readonly branch?: unknown }
    readonly content?: unknown
  }
}

/**
 * Parse one Codex rollout log into the neutral transcript model.
 *
 * Keeps `response_item` messages (skipping machine-injected tagged user
 * content), function/shell/custom tool-call one-liners, and `compacted`
 * summaries. Reasoning payloads and tool outputs are skipped, and `event_msg`
 * rows are skipped because they duplicate the `response_item` stream.
 * Malformed lines are skipped.
 *
 * @param text - complete rollout file contents.
 * @param briefLimit - character cap for one tool-call brief line.
 * @returns the parsed transcript.
 * @throws {@link ForeignTranscriptError} with `FOREIGN_TRANSCRIPT_UNRECOGNIZED_FILE` when no line carries a known record type.
 */
export function parseCodexTranscript(text: string, briefLimit: number): ForeignTranscript {
  const state = new TranscriptAccumulator()
  for (const line of text.split('\n')) {
    if (line.length === 0) continue
    const record: CodexRecord | undefined = parseJsonlLine(line)
    if (record === undefined) continue
    const payload = record.payload
    switch (record.type) {
      case 'session_meta': {
        state.recognized = true
        const id = typeof payload?.id === 'string' ? payload.id
          : typeof payload?.session_id === 'string' ? payload.session_id
            : ''
        if (state.sessionId === '') state.sessionId = id
        if (state.cwd === undefined && typeof payload?.cwd === 'string') state.cwd = payload.cwd
        if (state.startedAt === undefined && typeof payload?.timestamp === 'string') state.startedAt = payload.timestamp
        if (state.gitBranch === undefined && typeof payload?.git?.branch === 'string') state.gitBranch = payload.git.branch
        break
      }
      case 'turn_context':
        state.recognized = true
        if (state.model === undefined && typeof payload?.model === 'string') state.model = payload.model
        break
      case 'compacted':
        state.recognized = true
        if (typeof payload?.message === 'string' && payload.message.length > 0) {
          state.items.push({ kind: 'summary', text: payload.message })
        }
        break
      case 'response_item': {
        state.recognized = true
        const type = payload?.type
        if (type === 'message') {
          const role = payload?.role
          const body = messageText(payload)
          if (body === '' || (typeof role === 'string' && SYSTEM_USER_TAGS.test(body))) break
          if (role === 'user') state.items.push({ kind: 'user', text: body })
          else if (role === 'assistant') state.items.push({ kind: 'assistant', text: body })
        } else if (type === 'function_call') {
          const name = typeof payload?.name === 'string' && payload.name.length > 0 ? payload.name : 'function'
          const brief = typeof payload?.arguments === 'string' ? ellipsize(payload.arguments, briefLimit) : ''
          state.items.push({ kind: 'tool-call', name, brief })
        } else if (type === 'local_shell_call') {
          const command = payload?.action?.command
          const brief = Array.isArray(command)
            ? ellipsize(command.filter(part => typeof part === 'string').join(' '), briefLimit)
            : ''
          state.items.push({ kind: 'tool-call', name: 'shell', brief })
        } else if (type === 'custom_tool_call') {
          const name = typeof payload?.tool_name === 'string' && payload.tool_name.length > 0
            ? payload.tool_name
            : typeof payload?.name === 'string' && payload.name.length > 0 ? payload.name : 'custom'
          const brief = typeof payload?.input === 'string' ? ellipsize(payload.input, briefLimit) : ''
          state.items.push({ kind: 'tool-call', name, brief })
        } else if (typeof type === 'string' && type.endsWith('_call')) {
          state.items.push({ kind: 'tool-call', name: type, brief: '' })
        }
        break
      }
      default:
        break
    }
  }
  if (!state.recognized) {
    throw new ForeignTranscriptError(
      'file contains no recognizable Codex session records',
      'FOREIGN_TRANSCRIPT_UNRECOGNIZED_FILE',
    )
  }
  return state.finish('codex')
}

/**
 * Join the text parts of one `response_item` message payload.
 * @param payload - the message response item.
 * @returns joined text parts, or `''` when the payload holds none.
 */
function messageText(payload: CodexRecord['payload']): string {
  const blocks = payload?.content
  if (!Array.isArray(blocks)) return ''
  const texts: string[] = []
  for (const block of blocks) {
    const candidate = block as CodexBlock
    const textual = candidate.type === 'text'
      || (typeof candidate.type === 'string' && candidate.type.endsWith('_text'))
    if (textual && typeof candidate.text === 'string') texts.push(candidate.text)
  }
  return texts.join('\n')
}
