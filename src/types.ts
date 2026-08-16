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
