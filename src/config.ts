/** Configuration defaults and stable diagnostics for foreign-session imports. */

import type { Config } from './index.ts'

/** Default Claude Code projects root; `~` expands against the home directory. */
export const DEFAULT_CLAUDE_PROJECTS_ROOT = '~/.claude/projects'
/** Default Codex sessions root; `~` expands against the home directory. */
export const DEFAULT_CODEX_SESSIONS_ROOT = '~/.codex/sessions'
/** Default UTF-8 budget for one rendered foreign transcript. */
export const DEFAULT_MAX_TRANSCRIPT_BYTES = 65_536
/** Hard ceiling on foreign-session references accepted by one user message. */
export const MAX_MENTIONS = 5
/** Default foreign-session reference cap per user message. */
export const DEFAULT_MAX_MENTIONS_PER_MESSAGE = 3
/** Default newest-first file count scanned for a `claude`/`codex` specifier. */
export const DEFAULT_LATEST_SCAN_LIMIT = 200
/** Default character cap for one tool-call brief line. */
export const DEFAULT_MAX_TOOL_BRIEF_CHARS = 120
/**
 * Default byte cap on the head read used to extract one session's topic. Must
 * clear Codex's bootstrap: current rollouts open with a 20–50 KB instruction
 * block and can bury the first user message beyond 130 KB, so a short head
 * read yields no topic at all.
 */
export const DEFAULT_SEARCH_HEAD_BYTES = 262_144
/** Default candidate count returned by one topic search. */
export const DEFAULT_SEARCH_RESULTS = 5

const CONFIG_STRING_KEYS = ['claudeProjectsRoot', 'codexSessionsRoot'] as const
const CONFIG_NUMBER_KEYS = [
  'maxTranscriptBytes',
  'maxMentionsPerMessage',
  'latestScanLimit',
  'maxToolBriefChars',
  'searchHeadBytes',
  'searchResults',
] as const

/** Fully-defaulted configuration after load-time validation. */
export interface ResolvedConfig {
  readonly claudeProjectsRoot: string
  readonly codexSessionsRoot: string
  readonly maxTranscriptBytes: number
  readonly maxMentionsPerMessage: number
  readonly latestScanLimit: number
  readonly maxToolBriefChars: number
  readonly searchHeadBytes: number
  readonly searchResults: number
}

/** Stable failure codes exposed to callers and host adapters. */
export type ForeignTranscriptErrorCode =
  | 'FOREIGN_TRANSCRIPT_INVALID_CONFIG'
  | 'FOREIGN_TRANSCRIPT_INVALID_SPECIFIER'
  | 'FOREIGN_TRANSCRIPT_NOT_FOUND'
  | 'FOREIGN_TRANSCRIPT_OUTSIDE_ROOTS'
  | 'FOREIGN_TRANSCRIPT_UNRECOGNIZED_FILE'
  | 'FOREIGN_TRANSCRIPT_READ_FAILED'
  | 'FOREIGN_TRANSCRIPT_BUDGET_EXCEEDED'
  | 'FOREIGN_TRANSCRIPT_TOO_MANY'

/** Typed foreign-transcript failure with a stable routing code. */
export class ForeignTranscriptError extends Error {
  /** @param message Human-readable diagnosis. @param code Stable routing code. @param options Optional cause. */
  constructor(
    message: string,
    readonly code: ForeignTranscriptErrorCode,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'ForeignTranscriptError'
  }
}

/**
 * Apply defaults and reject values that cannot work at all.
 * @param config - raw plugin configuration.
 * @returns the fully-defaulted configuration.
 * @throws {@link ForeignTranscriptError} with `FOREIGN_TRANSCRIPT_INVALID_CONFIG` on any invalid value.
 */
export function resolveConfig(config: Config): ResolvedConfig {
  const resolved: ResolvedConfig = {
    claudeProjectsRoot: config.claudeProjectsRoot ?? DEFAULT_CLAUDE_PROJECTS_ROOT,
    codexSessionsRoot: config.codexSessionsRoot ?? DEFAULT_CODEX_SESSIONS_ROOT,
    maxTranscriptBytes: config.maxTranscriptBytes ?? DEFAULT_MAX_TRANSCRIPT_BYTES,
    maxMentionsPerMessage: config.maxMentionsPerMessage ?? DEFAULT_MAX_MENTIONS_PER_MESSAGE,
    latestScanLimit: config.latestScanLimit ?? DEFAULT_LATEST_SCAN_LIMIT,
    maxToolBriefChars: config.maxToolBriefChars ?? DEFAULT_MAX_TOOL_BRIEF_CHARS,
    searchHeadBytes: config.searchHeadBytes ?? DEFAULT_SEARCH_HEAD_BYTES,
    searchResults: config.searchResults ?? DEFAULT_SEARCH_RESULTS,
  }
  for (const name of CONFIG_STRING_KEYS) {
    if (resolved[name].length === 0) {
      throw new ForeignTranscriptError(`foreign-transcript: ${name} must be a non-empty string`, 'FOREIGN_TRANSCRIPT_INVALID_CONFIG')
    }
  }
  for (const name of CONFIG_NUMBER_KEYS) {
    const value: number = resolved[name]
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new ForeignTranscriptError(`foreign-transcript: ${name} must be a positive safe integer`, 'FOREIGN_TRANSCRIPT_INVALID_CONFIG')
    }
  }
  if (resolved.maxMentionsPerMessage > MAX_MENTIONS) {
    throw new ForeignTranscriptError(
      `foreign-transcript: maxMentionsPerMessage must not exceed ${MAX_MENTIONS}`,
      'FOREIGN_TRANSCRIPT_INVALID_CONFIG',
    )
  }
  return resolved
}
