/** Shared mutable accumulation for the foreign-session parsers. */

import type { ForeignTranscript, ForeignTranscriptItem, ForeignTranscriptOrigin } from './types.ts'

/**
 * Field-by-field accumulation of one foreign transcript while its parser walks
 * the file. Session metadata fields record their first observation only.
 */
export class TranscriptAccumulator {
  /** Conversation elements in log order. */
  readonly items: ForeignTranscriptItem[] = []
  /** Foreign session id as recorded in the log, when present. */
  sessionId = ''
  /** Working directory the foreign session ran in, when recorded. */
  cwd: string | undefined
  /** First record timestamp, when recorded. */
  startedAt: string | undefined
  /** Git branch the foreign session ran on, when recorded. */
  gitBranch: string | undefined
  /** Model name recorded for the session, when present. */
  model: string | undefined
  /** Whether any line carried a record type the parser recognizes. */
  recognized = false

  /**
   * Freeze the accumulated state into one finished transcript.
   * @param origin - format family the parser handles.
   * @returns the assembled transcript.
   */
  finish(origin: ForeignTranscriptOrigin): ForeignTranscript {
    return {
      origin,
      sessionId: this.sessionId,
      ...this.cwd === undefined ? {} : { cwd: this.cwd },
      ...this.startedAt === undefined ? {} : { startedAt: this.startedAt },
      ...this.gitBranch === undefined ? {} : { gitBranch: this.gitBranch },
      ...this.model === undefined ? {} : { model: this.model },
      items: this.items,
    }
  }
}
