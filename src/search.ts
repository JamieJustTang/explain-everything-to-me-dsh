/**
 * Keyword search over foreign session logs: match each session's topic first
 * and fall back to matching the head's full text, so an import can be selected
 * by what the session was about — or what it contains — instead of by path.
 * @module @deepseek-ai/dsh-foreign-transcript/search
 */

import { open, readdir, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { parseClaudeCodeTranscript } from './claude-code.ts'
import { parseCodexTranscript } from './codex.ts'
import { ForeignTranscriptError } from './config.ts'
import type { ResolvedConfig } from './config.ts'
import { expandHome } from './specifier.ts'
import type { ForeignTranscript, ForeignTranscriptOrigin } from './types.ts'

/** One topic-matching foreign session. */
export interface ForeignSessionCandidate {
  /** Absolute path of the session file. */
  readonly path: string
  /** Format family the file was recognized as. */
  readonly origin: ForeignTranscriptOrigin
  /** Session topic: its first summary row, or its first human user message; a label when only content matched. */
  readonly topic: string
  /** Which source the match came from. */
  readonly topicSource: 'summary' | 'first-user-message' | 'content'
  /** First record timestamp, when the head carried one. */
  readonly startedAt?: string
  /** Working directory the foreign session ran in, when recorded. */
  readonly cwd?: string
}

/** Topic label shown for a session whose head carries no extractable topic. */
const CONTENT_MATCH_LABEL = '(matched in content only)'

/**
 * Search one origin's session logs by keyword.
 *
 * Every session file under the origin's root is a candidate (newest first,
 * bounded by `latestScanLimit`). A file's topic is the first summary row in
 * its head, or its first human user message when no summary exists. A query
 * matches when every whitespace-separated term appears (case-insensitively)
 * in the topic; an empty query matches every session. When no session's topic
 * matches, the same terms are matched against each head's full text instead,
 * so a session whose relevant material sits deep in the conversation is still
 * found; those matches carry `topicSource: 'content'` and rank below every
 * topic match. Summary matches outrank first-user-message matches, then newer
 * files outrank older ones.
 *
 * @param options - origin, query, validated configuration, and optional cancellation.
 * @returns the top `searchResults` candidates, best first.
 */
export async function searchForeignSessions(options: {
  readonly origin: ForeignTranscriptOrigin
  readonly query: string
  readonly config: ResolvedConfig
  readonly signal?: AbortSignal | undefined
}): Promise<readonly ForeignSessionCandidate[]> {
  const { origin, query, config, signal } = options
  const terms = query.trim().toLowerCase().split(/\s+/u).filter(term => term !== '')
  const files = await listSessionFiles(origin, config)
  const topicMatches: ScoredCandidate[] = []
  const contentMatches: ScoredCandidate[] = []
  for (const { path, mtimeMs } of files) {
    if (signal?.aborted) throw new Error('foreign-transcript search was cancelled')
    let head: string
    try {
      head = await readHead(path, config.searchHeadBytes)
    } catch {
      continue
    }
    const transcript = parseHead(origin, head)
    // A head of the other format is never a candidate for either pass.
    if (transcript === undefined) continue
    const topic = topicFrom(transcript)
    if (topic !== undefined) {
      const topicLower = topic.text.toLowerCase()
      if (terms.length === 0 || terms.every(term => topicLower.includes(term))) {
        topicMatches.push({
          path,
          origin,
          topic: topic.text,
          topicSource: topic.source,
          ...topic.startedAt === undefined ? {} : { startedAt: topic.startedAt },
          ...topic.cwd === undefined ? {} : { cwd: topic.cwd },
          score: topic.source === 'summary' ? 2 : 1,
          mtimeMs,
        })
        continue
      }
    }
    if (terms.length > 0) {
      const headLower = head.toLowerCase()
      if (terms.every(term => headLower.includes(term))) {
        contentMatches.push({
          path,
          origin,
          topic: topic?.text ?? CONTENT_MATCH_LABEL,
          topicSource: 'content',
          ...topic?.startedAt === undefined ? {} : { startedAt: topic.startedAt },
          ...topic?.cwd === undefined ? {} : { cwd: topic.cwd },
          score: 0,
          mtimeMs,
        })
      }
    }
  }
  const matches = topicMatches.length > 0 ? topicMatches : contentMatches
  return matches
    .sort((left, right) => right.score - left.score || right.mtimeMs - left.mtimeMs)
    .slice(0, config.searchResults)
    .map(({ score: _score, mtimeMs: _mtimeMs, ...candidate }) => candidate)
}

/** One ranked candidate before score and mtime are stripped for return. */
type ScoredCandidate = ForeignSessionCandidate & { readonly score: number; readonly mtimeMs: number }

/**
 * List one origin's session files newest-first, bounded by the scan limit.
 * @param origin - format family whose root is scanned.
 * @param config - validated configuration.
 * @returns file paths with modification times, newest first.
 */
async function listSessionFiles(
  origin: ForeignTranscriptOrigin,
  config: ResolvedConfig,
): Promise<readonly { path: string; mtimeMs: number }[]> {
  const root = resolve(expandHome(
    origin === 'claude' ? config.claudeProjectsRoot : config.codexSessionsRoot,
  ))
  const paths: string[] = []
  try {
    if (origin === 'claude') {
      for (const entry of await readdir(root, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue
        for (const file of await readdir(join(entry.parentPath, entry.name), { withFileTypes: true })) {
          if (file.isFile() && file.name.endsWith('.jsonl')) {
            paths.push(join(file.parentPath, file.name))
          }
        }
      }
    } else {
      for (const file of await readdir(root, { recursive: true, withFileTypes: true })) {
        if (file.isFile() && file.name.endsWith('.jsonl')) {
          paths.push(join(file.parentPath, file.name))
        }
      }
    }
  } catch {
    // An absent or unreadable root simply holds no candidates.
    return []
  }
  const stamped = await Promise.all(paths.map(async (path) => {
    const mtimeMs = (await stat(path)).mtimeMs
    return { path, mtimeMs }
  }))
  return stamped
    .sort((left, right) => right.mtimeMs - left.mtimeMs)
    .slice(0, config.latestScanLimit)
}

/** One extracted session topic. */
interface SessionTopic {
  readonly text: string
  readonly source: 'summary' | 'first-user-message'
  readonly startedAt?: string
  readonly cwd?: string
}

/**
 * Parse one already-read head as the origin's format.
 * @param origin - expected format family of the file.
 * @param head - decoded head text of the session file.
 * @returns the parsed transcript, or `undefined` when the head is the other
 * format or holds no parsable record.
 */
function parseHead(origin: ForeignTranscriptOrigin, head: string): ForeignTranscript | undefined {
  try {
    return origin === 'claude'
      ? parseClaudeCodeTranscript(head, Number.MAX_SAFE_INTEGER)
      : parseCodexTranscript(head, Number.MAX_SAFE_INTEGER)
  } catch (error: unknown) {
    if (error instanceof ForeignTranscriptError) return undefined
    throw error
  }
}

/**
 * Extract one parsed transcript's topic.
 * @param transcript - parsed head transcript.
 * @returns the topic, or `undefined` when it holds no summary and no user item.
 */
function topicFrom(transcript: ForeignTranscript): SessionTopic | undefined {
  const summary = transcript.items.find(item => item.kind === 'summary')
  if (summary !== undefined) {
    return {
      text: summary.text,
      source: 'summary',
      ...transcript.startedAt === undefined ? {} : { startedAt: transcript.startedAt },
      ...transcript.cwd === undefined ? {} : { cwd: transcript.cwd },
    }
  }
  const firstUser = transcript.items.find(item => item.kind === 'user')
  if (firstUser === undefined) return undefined
  return {
    text: firstUser.text,
    source: 'first-user-message',
    ...transcript.startedAt === undefined ? {} : { startedAt: transcript.startedAt },
    ...transcript.cwd === undefined ? {} : { cwd: transcript.cwd },
  }
}

/**
 * Read the first bytes of one file as text.
 * @param path - file to read.
 * @param maxBytes - byte cap on the read.
 * @returns up to `maxBytes` decoded UTF-8 text (a torn final line is fine: parsers skip it).
 */
async function readHead(path: string, maxBytes: number): Promise<string> {
  const handle = await open(path, 'r')
  try {
    const buffer = Buffer.alloc(maxBytes)
    const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0)
    return buffer.subarray(0, bytesRead).toString('utf8')
  } finally {
    await handle.close()
  }
}
