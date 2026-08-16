/**
 * Specifier grammar and on-disk session location for foreign-session imports.
 * @module @deepseek-ai/dsh-foreign-transcript/specifier
 */

import { open, readdir, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { parseClaudeCodeTranscript } from './claude-code.ts'
import { CLAUDE_RECORD_TYPES } from './claude-code.ts'
import { parseCodexTranscript } from './codex.ts'
import { ForeignTranscriptError, type ResolvedConfig } from './config.ts'
import { parseJsonlLine } from './jsonl.ts'
import type { ForeignTranscript, ForeignTranscriptOrigin, ForeignTranscriptScope } from './types.ts'

/** One parsed user-facing specifier: an origin keyword or an explicit path. */
export type ForeignSpecifier =
  | { readonly kind: 'origin'; readonly origin: ForeignTranscriptOrigin }
  | { readonly kind: 'path'; readonly path: string }

/** Scope suffix a mention may end with: `?latest`, `?first-N`, or `?last-N` with a positive count. */
const SCOPE_SUFFIX_PATTERN = /\?(latest|first-([1-9][0-9]*)|last-([1-9][0-9]*))$/u

/** One specifier with the import scope its suffix named. */
export interface ScopedSpecifier {
  readonly specifier: string
  readonly scope: ForeignTranscriptScope
  /** Exchange count named by a `first-`/`last-` suffix; `undefined` otherwise. */
  readonly exchanges: number | undefined
}

/**
 * Split one user-facing specifier into its locating part and the import scope
 * it names.
 * @param input - raw specifier, possibly ending in `?latest`, `?first-N`, or `?last-N`.
 * @returns the specifier without the suffix plus the scope and count it named;
 * an input that is only the suffix yields an empty specifier that downstream
 * parsing rejects, and an unrecognized suffix stays part of the specifier.
 */
export function splitScopeSuffix(input: string): ScopedSpecifier {
  const match = SCOPE_SUFFIX_PATTERN.exec(input)
  if (match === null) return { specifier: input, scope: 'full', exchanges: undefined }
  const specifier = input.slice(0, match.index)
  const [token, first, last] = [match[1] as string, match[2], match[3]]
  if (token === 'latest') return { specifier, scope: 'latest', exchanges: undefined }
  return {
    specifier,
    scope: first !== undefined ? 'first' : 'last',
    exchanges: Number.parseInt(first ?? (last as string), 10),
  }
}

/**
 * Parse one user-facing specifier.
 * @param input - raw text: `claude`, `codex`, or a session-file path.
 * @returns the parsed specifier.
 * @throws {@link ForeignTranscriptError} with `FOREIGN_TRANSCRIPT_INVALID_SPECIFIER` on empty input.
 */
export function parseSpecifier(input: string): ForeignSpecifier {
  const trimmed = input.trim()
  if (trimmed === '') {
    throw new ForeignTranscriptError(
      'specifier must be "claude", "codex", or a path to a session .jsonl file',
      'FOREIGN_TRANSCRIPT_INVALID_SPECIFIER',
    )
  }
  if (trimmed === 'claude' || trimmed === 'codex') return { kind: 'origin', origin: trimmed }
  return { kind: 'path', path: trimmed }
}

/**
 * Encode one working directory the way Claude Code names its project
 * directory: every non-alphanumeric character becomes one `-`.
 * @param cwd - absolute working directory.
 * @returns the project directory name under the Claude projects root.
 */
export function claudeProjectSlug(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/gu, '-')
}

/**
 * Expand one leading `~` segment against the home directory; any other path
 * returns unchanged (anchoring is the caller's choice).
 * @param path - configured or supplied path, possibly `~`-prefixed.
 * @returns the path with any leading `~` replaced by the home directory.
 */
export function expandHome(path: string): string {
  if (path === '~') return homedir()
  if (path.startsWith('~/') || path.startsWith('~\\')) return join(homedir(), path.slice(2))
  return path
}

/** A located and parsed foreign session. */
export interface ResolvedForeignSession {
  readonly origin: ForeignTranscriptOrigin
  readonly path: string
  readonly transcript: ForeignTranscript
}

/**
 * Locate, read, and parse one foreign session.
 *
 * An origin keyword selects the newest session file whose recorded working
 * directory equals `cwd` (Claude project-slug directory for `claude`; newest
 * rollout headers scanned for `codex`). An explicit path must resolve inside
 * one of the configured roots — the import never reads session logs outside
 * them.
 *
 * @param options - specifier, working directory, validated configuration, and optional cancellation.
 * @returns the located session and its parsed transcript.
 * @throws {@link ForeignTranscriptError} on invalid specifiers, missing sessions, paths
 * outside the roots, unreadable files, and unrecognized formats.
 */
export async function resolveForeignSession(options: {
  readonly specifier: string
  readonly cwd: string
  readonly config: ResolvedConfig
  readonly signal?: AbortSignal | undefined
}): Promise<ResolvedForeignSession> {
  const { cwd, config, signal } = options
  const specifier = parseSpecifier(options.specifier)
  if (specifier.kind === 'origin') {
    return specifier.origin === 'claude'
      ? await resolveLatestClaude(cwd, config, signal)
      : await resolveLatestCodex(cwd, config, signal)
  }
  const path = resolve(cwd, expandHome(specifier.path))
  const roots = [
    resolve(expandHome(config.claudeProjectsRoot)),
    resolve(expandHome(config.codexSessionsRoot)),
  ]
  if (!roots.some(root => path === root || path.startsWith(root + sep))) {
    throw new ForeignTranscriptError(
      `session path ${JSON.stringify(path)} is outside the configured roots ${roots.map(root => JSON.stringify(root)).join(' and ')}`,
      'FOREIGN_TRANSCRIPT_OUTSIDE_ROOTS',
    )
  }
  const text = await readSessionFile(path, signal)
  return { ...sniffAndParse(path, text, config), path }
}

/**
 * Locate the newest Claude session file for one working directory.
 * @param cwd - working directory whose project directory is searched.
 * @param config - validated configuration.
 * @param signal - optional cancellation.
 * @returns the newest parsed session.
 * @throws {@link ForeignTranscriptError} with `FOREIGN_TRANSCRIPT_NOT_FOUND` when the project directory holds no session file.
 */
async function resolveLatestClaude(
  cwd: string,
  config: ResolvedConfig,
  signal: AbortSignal | undefined,
): Promise<ResolvedForeignSession> {
  const dir = resolve(expandHome(config.claudeProjectsRoot), claudeProjectSlug(cwd))
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch (error: unknown) {
    if (signal?.aborted) throw error
    throw new ForeignTranscriptError(
      `no Claude session directory for this project (looked for ${JSON.stringify(dir)})`,
      'FOREIGN_TRANSCRIPT_NOT_FOUND',
      { cause: error },
    )
  }
  let newest: { path: string; mtimeMs: number } | undefined
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue
    const path = join(dir, entry.name)
    const mtimeMs = (await stat(path)).mtimeMs
    if (newest === undefined || mtimeMs > newest.mtimeMs) newest = { path, mtimeMs }
  }
  if (newest === undefined) {
    throw new ForeignTranscriptError(
      `no Claude session files in ${JSON.stringify(dir)}`,
      'FOREIGN_TRANSCRIPT_NOT_FOUND',
    )
  }
  const text = await readSessionFile(newest.path, signal)
  return { ...sniffAndParse(newest.path, text, config), path: newest.path }
}

/**
 * Locate the newest Codex rollout file whose recorded working directory matches.
 * @param cwd - working directory matched against each rollout's `session_meta`.
 * @param config - validated configuration.
 * @param signal - optional cancellation.
 * @returns the newest matching parsed session.
 * @throws {@link ForeignTranscriptError} with `FOREIGN_TRANSCRIPT_NOT_FOUND` when no scanned rollout matches.
 */
async function resolveLatestCodex(
  cwd: string,
  config: ResolvedConfig,
  signal: AbortSignal | undefined,
): Promise<ResolvedForeignSession> {
  const root = resolve(expandHome(config.codexSessionsRoot))
  const files = (await readdir(root, { recursive: true, withFileTypes: true }))
    .filter(entry => entry.isFile() && entry.name.endsWith('.jsonl'))
    .map(entry => join(entry.parentPath, entry.name))
  const newestFirst: { path: string; mtimeMs: number }[] = []
  for (const path of files) {
    const mtimeMs = (await stat(path)).mtimeMs
    newestFirst.push({ path, mtimeMs })
  }
  newestFirst.sort((left, right) => right.mtimeMs - left.mtimeMs)
  const scanned = newestFirst.slice(0, config.latestScanLimit)
  if (scanned.length === 0) {
    throw new ForeignTranscriptError(
      `no Codex session files under ${JSON.stringify(root)}`,
      'FOREIGN_TRANSCRIPT_NOT_FOUND',
    )
  }
  for (const { path } of scanned) {
    let header: string | undefined
    try {
      header = await readFirstLine(path, signal)
    } catch {
      continue
    }
    let cwdOfRecord: unknown
    try {
      const record = JSON.parse(header) as { type?: unknown; payload?: { cwd?: unknown } }
      cwdOfRecord = record.type === 'session_meta' ? record.payload?.cwd : undefined
    } catch {
      continue
    }
    if (cwdOfRecord !== cwd) continue
    const text = await readSessionFile(path, signal)
    return { ...sniffAndParse(path, text, config), path }
  }
  throw new ForeignTranscriptError(
    scanned.length < newestFirst.length
      ? `no Codex session for ${JSON.stringify(cwd)} among the ${scanned.length} newest files (latestScanLimit ${config.latestScanLimit})`
      : `no Codex session for ${JSON.stringify(cwd)} among ${scanned.length} session files`,
    'FOREIGN_TRANSCRIPT_NOT_FOUND',
  )
}

/**
 * Read one session file as text.
 * @param path - file to read.
 * @param signal - optional cancellation.
 * @returns the complete file text.
 * @throws {@link ForeignTranscriptError} with `FOREIGN_TRANSCRIPT_READ_FAILED` on I/O failure.
 */
async function readSessionFile(path: string, signal: AbortSignal | undefined): Promise<string> {
  try {
    return await readFile(path, { encoding: 'utf8', signal })
  } catch (error: unknown) {
    if (signal?.aborted) throw error
    throw new ForeignTranscriptError(
      `failed to read session file ${JSON.stringify(path)}: ${error instanceof Error ? error.message : String(error)}`,
      'FOREIGN_TRANSCRIPT_READ_FAILED',
      { cause: error },
    )
  }
}

/**
 * Read the first line of one file, tolerating arbitrarily long first lines.
 * @param path - file to read.
 * @param signal - optional cancellation.
 * @returns the first line without its newline.
 */
async function readFirstLine(path: string, signal: AbortSignal | undefined): Promise<string> {
  const handle = await open(path, 'r')
  try {
    let buffer = Buffer.alloc(4096)
    let filled = 0
    for (;;) {
      // `null` reads sequentially: each call advances the file cursor instead
      // of restarting at byte 0 and duplicating the first chunk.
      const { bytesRead } = await handle.read(buffer, filled, buffer.length - filled, null)
      if (bytesRead === 0) return buffer.subarray(0, filled).toString('utf8')
      const newline = buffer.subarray(0, filled + bytesRead).indexOf(0x0A)
      if (newline >= 0) return buffer.subarray(0, newline).toString('utf8')
      filled += bytesRead
      if (filled === buffer.length) {
        const grown = Buffer.alloc(buffer.length * 2)
        buffer.copy(grown, 0, 0, filled)
        buffer = grown
      }
      if (signal?.aborted) throw new Error('readFirstLine aborted')
    }
  } finally {
    await handle.close()
  }
}

/**
 * Detect the format of one session file from its first record and parse it.
 * @param path - file the text came from, for diagnostics.
 * @param text - complete file text.
 * @param config - validated configuration.
 * @returns the origin and parsed transcript.
 * @throws {@link ForeignTranscriptError} with `FOREIGN_TRANSCRIPT_UNRECOGNIZED_FILE` when the first record identifies neither format.
 */
function sniffAndParse(
  path: string,
  text: string,
  config: ResolvedConfig,
): Omit<ResolvedForeignSession, 'path'> {
  for (const line of text.split('\n')) {
    if (line.length === 0) continue
    const record: { type?: unknown; sessionId?: unknown } | undefined = parseJsonlLine(line)
    if (record === undefined) continue
    if (record.type === 'session_meta') {
      return { origin: 'codex', transcript: parseCodexTranscript(text, config.maxToolBriefChars) }
    }
    if ((typeof record.type === 'string' && CLAUDE_RECORD_TYPES.has(record.type))
      || typeof record.sessionId === 'string') {
      return { origin: 'claude', transcript: parseClaudeCodeTranscript(text, config.maxToolBriefChars) }
    }
    throw new ForeignTranscriptError(
      `first record of ${JSON.stringify(path)} matches neither the Claude Code nor the Codex session format`,
      'FOREIGN_TRANSCRIPT_UNRECOGNIZED_FILE',
    )
  }
  throw new ForeignTranscriptError(
    `file ${JSON.stringify(path)} holds no parsable session records`,
    'FOREIGN_TRANSCRIPT_UNRECOGNIZED_FILE',
  )
}
