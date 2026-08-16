/**
 * Neutral transcript model shared by the foreign-session parsers and the
 * durable message source that provenances every imported transcript.
 * @module @deepseek-ai/dsh-foreign-transcript
 */

/** Which foreign agent wrote the session log on disk. */
export type ForeignTranscriptOrigin =
  /** Claude Code and Claude Desktop agent sessions under `~/.claude/projects`. */
  | 'claude'
  /** Codex CLI and Codex Desktop sessions under `~/.codex/sessions`. */
  | 'codex'

/**
 * How much of one foreign session an import carries. Explaining the whole
 * conversation, the latest exchange, the opening exchanges, or the most
 * recent few are different requests; the count-carrying kinds (`first`,
 * `last`) take an exchange count, the others stand alone.
 */
export type ForeignTranscriptScope =
  /** Every conversation item, byte-budgeted head and tail. */
  | 'full'
  /** Only the trailing exchange: the last user message through the session end; same as `last` with one exchange. */
  | 'latest'
  /** The first N exchanges from the session start; requires the exchanges count. */
  | 'first'
  /** The last N exchanges through the session end; requires the exchanges count. */
  | 'last'

/**
 * One ordered conversation element lifted out of a foreign session log.
 * Tool outputs are deliberately absent: the import keeps both sides of the
 * dialogue plus tool-call one-liners, and the byte budget bounds the whole.
 */
export type ForeignTranscriptItem =
  | { readonly kind: 'user'; readonly text: string }
  | { readonly kind: 'assistant'; readonly text: string }
  | { readonly kind: 'tool-call'; readonly name: string; readonly brief: string }
  | { readonly kind: 'summary'; readonly text: string }

/** One parsed foreign session log, in conversation order. */
export interface ForeignTranscript {
  /** Format family the file was recognized as. */
  readonly origin: ForeignTranscriptOrigin
  /** Foreign session id as recorded in the log, when present. */
  readonly sessionId: string
  /** Working directory the foreign session ran in, when recorded. */
  readonly cwd?: string
  /** First record timestamp, when recorded. */
  readonly startedAt?: string
  /** Git branch the foreign session ran on, when recorded. */
  readonly gitBranch?: string
  /** Model name recorded for the session, when present. */
  readonly model?: string
  /** Conversation elements in log order; may be empty for a bare header. */
  readonly items: readonly ForeignTranscriptItem[]
}

/**
 * Durable provenance of one imported-transcript context message. Merged into
 * the message-source map; `form: 'recall'` marks material lifted out of
 * another session's log, possibly reduced on the way in.
 */
export interface ForeignTranscriptSource {
  readonly kind: 'foreign-transcript'
  readonly form: 'recall'
  readonly version: 1
  readonly origin: ForeignTranscriptOrigin
  /** Absolute path of the session file the transcript was read from. */
  readonly path: string
  /** Display label for transcript headers (session file basename). */
  readonly label: string
  /** Import scope that selected the carried items. */
  readonly scope: ForeignTranscriptScope
  /** Exchange count carried with scope `first`/`last`; absent otherwise. */
  readonly exchanges?: number
  /** Item count before byte-budget retention. */
  readonly totalItems: number
  /** UTF-8 bytes dropped from the middle to fit the configured budget. */
  readonly omittedBytes: number
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'foreign-transcript': ForeignTranscriptSource
  }
}
