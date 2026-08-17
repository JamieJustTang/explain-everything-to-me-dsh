/**
 * Foreign-session transcript import. Reads Claude Code (`~/.claude/projects`,
 * also written by Claude Desktop agent sessions) and Codex
 * (`~/.codex/sessions`, also written by Codex Desktop) session logs from this
 * machine and delivers them to the model as bounded, untrusted recall context
 * so work can continue from that point.
 *
 * Three entry surfaces share one core: the `/import-session` human command
 * (injects durable context that rides the next prompt; topic keywords with
 * several matches ask the user to pick through the user-questions seam),
 * `foreign-session:` mentions in user text (expanded in `agent/pre-step` on
 * every surface, including headless and ACP prompts), and two model tools:
 * `search_foreign_sessions` (topic search returning the candidate list) and
 * `import_foreign_session` (imports one transcript, optionally by query).
 * Every surface distinguishes import scope: the whole session (default) or
 * only the latest exchange — the command's `--latest` flag, the mention's
 * `?latest` suffix, and the tool's `scope` parameter.
 *
 * @module @deepseek-ai/dsh-foreign-transcript
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import type { CommandResult } from '@deepseek-ai/dsh-commands'
import { UserQuestionError } from '@deepseek-ai/dsh-user-questions'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, UserMessage } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { basename } from 'node:path'
import { ellipsize } from './brief.ts'
import { resolveConfig } from './config.ts'
import { ForeignTranscriptError, MAX_MENTIONS } from './config.ts'
import type { ResolvedConfig } from './config.ts'
import { extractForeignMentions } from './mention.ts'
import { projectForeignTranscript, resolveExchangeSelection } from './projection.ts'
import type { ExchangeSelection, ProjectedTranscript } from './projection.ts'
import { searchForeignSessions } from './search.ts'
import type { ForeignSessionCandidate } from './search.ts'
import { parseSpecifier, resolveForeignSession, splitScopeSuffix } from './specifier.ts'
import type { ForeignTranscriptOrigin, ForeignTranscriptScope, ForeignTranscriptSource } from './types.ts'
// Projects the MessageSourceMap merge onto the package root so aggregate
// programs consuming the declarations receive the 'foreign-transcript' source.
export type * from './types.ts'

export { ForeignTranscriptError } from './config.ts'
export type { ForeignTranscriptErrorCode } from './config.ts'
export {
  DEFAULT_CLAUDE_PROJECTS_ROOT,
  DEFAULT_CODEX_SESSIONS_ROOT,
  DEFAULT_MAX_MENTIONS_PER_MESSAGE,
  DEFAULT_MAX_TOOL_BRIEF_CHARS,
  DEFAULT_MAX_TRANSCRIPT_BYTES,
  DEFAULT_LATEST_SCAN_LIMIT,
  DEFAULT_SEARCH_HEAD_BYTES,
  DEFAULT_SEARCH_RESULTS,
  MAX_MENTIONS,
  resolveConfig as resolveForeignTranscriptConfig,
} from './config.ts'
export { FOREIGN_SESSION_SCHEME, extractForeignMentions } from './mention.ts'
export { projectForeignTranscript, resolveExchangeSelection } from './projection.ts'
export type { ExchangeSelection } from './projection.ts'
export {
  claudeProjectSlug,
  expandHome,
  parseSpecifier,
  resolveForeignSession,
  splitScopeSuffix,
} from './specifier.ts'
export { parseClaudeCodeTranscript, CLAUDE_RECORD_TYPES } from './claude-code.ts'
export { parseCodexTranscript } from './codex.ts'
export { searchForeignSessions } from './search.ts'
export type { ForeignSessionCandidate } from './search.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'foreign-transcript'

/** The agent registry, human-command registry, and tool registry this plugin extends. */
export const inject = ['agents', 'commands', 'tools']

/** Foreign-transcript plugin configuration; every field overridable from cordis.yml. */
export interface Config {
  /** Root of Claude Code project session directories. */
  claudeProjectsRoot?: string
  /** Root of Codex dated session directories. */
  codexSessionsRoot?: string
  /** Maximum rendered UTF-8 bytes for one imported transcript. */
  maxTranscriptBytes?: number
  /** Maximum distinct foreign-session references in one user message. */
  maxMentionsPerMessage?: number
  /** Newest-first rollout files inspected while locating the latest Codex session. */
  latestScanLimit?: number
  /** Character cap for one tool-call brief line in the rendered transcript. */
  maxToolBriefChars?: number
  /**
   * Byte cap on the head read used to extract one session's topic. Must clear
   * Codex's opening instruction block (20-50 KB; the first user message can sit
   * beyond 130 KB), or no topic is found at all.
   */
  searchHeadBytes?: number
  /** Candidate count returned by one topic search. */
  searchResults?: number
}

/** Schemastery validation for the plugin {@link Config}; invalid values fail plugin load. */
export const Config: z<Config> = z.object({
  claudeProjectsRoot: z.string(),
  codexSessionsRoot: z.string(),
  maxTranscriptBytes: z.number().step(1).min(1),
  maxMentionsPerMessage: z.number().step(1).min(1).max(MAX_MENTIONS),
  latestScanLimit: z.number().step(1).min(1),
  maxToolBriefChars: z.number().step(1).min(1),
  searchHeadBytes: z.number().step(1).min(1),
  searchResults: z.number().step(1).min(1),
})

/** Guidance appended to every no-topic-match failure. */
const NO_TOPIC_MATCH_HINT = ' — every whitespace-separated term must appear in the session\'s topic or its opening content; try fewer, more distinctive keywords'

const COMMAND_NAME = 'import-session'
const COMMAND_DESCRIPTION = 'Import a Claude Code or Codex session transcript from this machine as conversation context'
const COMMAND_HINT = 'claude [topic keywords] | codex [topic keywords] | path to a session .jsonl under the configured roots; --latest / --first N / --last N bound the import to part of the session'
const COMMAND_LATEST_FLAG = '--latest'
const COMMAND_FIRST_FLAG = '--first'
const COMMAND_LAST_FLAG = '--last'
const COMMAND_USAGE = 'usage: /import-session [--latest | --first N | --last N] <claude|codex|path-to-session.jsonl> [topic keywords] — "claude"/"codex" imports the newest session for the current project; with keywords the best topic match across all of that origin\'s sessions is imported; --latest keeps only the last user message through the session end, --first N the opening N exchanges, --last N the most recent N exchanges; anything typed after the first line is submitted to the model as your instruction once the import lands'

const TOOL_SPECIFIER_DESCRIPTION = 'Specifier to import: "claude" or "codex" for the newest session of the current project, or a path to a session .jsonl file under the configured roots.'
const TOOL_QUERY_DESCRIPTION = 'Optional topic keywords. With "claude"/"codex", the best-matching session topic across all of that origin\'s sessions is imported instead of the newest one; the result lists the other matches.'
const TOOL_SCOPE_DESCRIPTION = 'Import scope. "full" (default) imports the whole session transcript. "latest" imports only the latest exchange — the last user message through the end of the session — which fits questions like "what did it just do". "first" imports the opening exchanges and "last" the most recent ones, each requiring the exchanges count.'
const TOOL_EXCHANGES_DESCRIPTION = 'Exchange count for scope "first"/"last": how many exchanges to import, where one exchange is a user message plus the assistant reply and tool calls that follow it. Required with those scopes; must not accompany "full"/"latest".'
const TOOL_DESCRIPTION = 'Import one Claude Code or Codex session transcript from this machine as bounded text. Use it when the user points at work done in another agent (a Claude or Codex session) and wants to continue from it. Pass scope="latest" when the user asks what the other agent just did, scope="first"/"last" with an exchanges count for a bounded window of exchanges, and leave the default when they want the whole session\'s arc.'
const SEARCH_TOOL_DESCRIPTION = 'Search Claude Code or Codex session logs by keyword and return the matching sessions WITHOUT importing them. Terms match a session\'s topic first (its summary or first user message); when no topic matches, they are matched against the session\'s opening content instead, which finds sessions whose relevant material sits deeper. Retrieval is lexical: extract distinctive terms from what the user remembers — project and file names, document titles, domain jargon, Chinese and English variants of the same concept — and search with one or two of them; terms are AND-ed, so fewer terms match more sessions. When a query returns nothing, derive alternative terms (synonyms, the other language, a shorter fragment of a phrase) and retry over several rounds before concluding the material is not on this machine; an empty query lists the newest sessions, which browses by recency when every keyword fails. Present the matches to the user (use ask_user_question when they should choose), then call import_foreign_session with the chosen path(s).'

/** One prepared import shared by all three surfaces. */
interface PreparedImport {
  readonly origin: ForeignTranscriptOrigin
  readonly path: string
  readonly selection: ExchangeSelection
  readonly projected: ProjectedTranscript
}

/**
 * Flatten one selection into the durable scope kind plus its count field.
 * @param selection - validated scope selection.
 * @returns the flat `scope` and, for a counted selection, its `exchanges`.
 */
function scopeFields(selection: ExchangeSelection): {
  scope: ForeignTranscriptScope
  exchanges?: number
} {
  return selection.kind === 'count'
    ? { scope: selection.direction, exchanges: selection.exchanges }
    : { scope: selection.kind }
}

/**
 * Locate, parse, and project one foreign session.
 * @param specifier - user- or model-supplied specifier.
 * @param cwd - working directory for latest-session lookup and relative paths.
 * @param config - validated configuration.
 * @param signal - cancellation signal of the calling surface.
 * @param scope - the requested import scope kind.
 * @param exchanges - the requested exchange count, when the caller supplied one.
 * @returns the import plus its durable source metadata inputs.
 * @throws {@link ForeignTranscriptError} with `FOREIGN_TRANSCRIPT_INVALID_SPECIFIER` when the
 * scope kind and the exchange count do not pair.
 */
async function prepareImport(
  specifier: string,
  cwd: string,
  config: ResolvedConfig,
  signal: AbortSignal | undefined,
  scope: ForeignTranscriptScope,
  exchanges: number | undefined,
): Promise<PreparedImport> {
  const { origin, path, transcript } = await resolveForeignSession({ specifier, cwd, config, signal })
  const selection = resolveExchangeSelection(scope, exchanges)
  const label = basename(path)
  const projected = projectForeignTranscript(transcript, label, config.maxTranscriptBytes, selection)
  return { origin, path, selection, projected }
}

/** One best-match import plus the other topic candidates found beside it. */
interface SearchedImport {
  readonly prepared: PreparedImport
  readonly candidates: readonly ForeignSessionCandidate[]
}

/**
 * Search one origin by topic keywords and prepare the best match.
 * @param origin - origin keyword whose sessions are searched.
 * @param query - topic keywords; every term must appear in the topic.
 * @param cwd - working directory for relative paths.
 * @param config - validated configuration.
 * @param signal - cancellation signal of the calling surface.
 * @param scope - the requested import scope kind.
 * @param exchanges - the requested exchange count, when the caller supplied one.
 * @returns the best match prepared for import plus every returned candidate.
 * @throws {@link ForeignTranscriptError} with `FOREIGN_TRANSCRIPT_NOT_FOUND` when nothing matches.
 */
async function searchAndPrepare(
  origin: ForeignTranscriptOrigin,
  query: string,
  cwd: string,
  config: ResolvedConfig,
  signal: AbortSignal | undefined,
  scope: ForeignTranscriptScope,
  exchanges: number | undefined,
): Promise<SearchedImport> {
  const candidates = await searchForeignSessions({ origin, query, config, signal })
  const best = candidates[0]
  if (best === undefined) {
    throw new ForeignTranscriptError(
      `no ${origin} session topic matches ${JSON.stringify(query)}${NO_TOPIC_MATCH_HINT}`,
      'FOREIGN_TRANSCRIPT_NOT_FOUND',
    )
  }
  return { prepared: await prepareImport(best.path, cwd, config, signal, scope, exchanges), candidates }
}

/**
 * Render the candidate list for a topic search, best first.
 * @param candidates - search results.
 * @returns numbered lines naming each topic and path, or `''` for one match.
 */
function renderCandidates(candidates: readonly ForeignSessionCandidate[]): string {
  return candidates
    .slice(1)
    .map((candidate, index) => `  ${index + 2}. ${candidate.topic} — ${candidate.path}`)
    .join('\n')
}

/** Character cap for one candidate label shown in a question or list. */
const LABEL_MAX_CHARS = 100

/**
 * Render one candidate's selection label; the numeric prefix keeps labels unique when topics collide.
 * @param candidate - search result to label.
 * @param index - zero-based rank, shown as a one-based prefix.
 * @returns the unique label naming this candidate.
 */
function candidateLabel(candidate: ForeignSessionCandidate, index: number): string {
  return `${index + 1}. ${ellipsize(candidate.topic, LABEL_MAX_CHARS - `${index + 1}. `.length)}`
}

/**
 * Ask the user which of several topic matches to import, through the composed
 * user-questions seam.
 *
 * The question is multi-select, so the user may confirm several sessions; a
 * dismissed or aborted question surfaces as `undefined` selection rather than
 * an import. A missing seam, a missing UI provider, or any other
 * user-questions failure returns `undefined` so the caller falls back to
 * importing the best match unasked.
 *
 * @param ctx - plugin context carrying an optionally composed userQuestions service.
 * @param agent - the live root agent owning the session the command runs on;
 * web-UI providers route the question through it.
 * @param origin - origin keyword that was searched.
 * @param query - topic keywords that produced the candidates.
 * @param candidates - ranked search results.
 * @param signal - cancellation signal of the calling surface.
 * @returns the chosen candidates in selection order, or `undefined` to fall back.
 */
async function askWhichSessions(
  ctx: Context,
  agent: Agent,
  origin: ForeignTranscriptOrigin,
  query: string,
  candidates: readonly ForeignSessionCandidate[],
  signal: AbortSignal,
): Promise<readonly ForeignSessionCandidate[] | undefined> {
  const userQuestions = ctx.get('userQuestions')
  if (userQuestions === undefined) return undefined
  try {
    const labels = candidates.map(candidateLabel)
    const answer = await userQuestions.ask({
      agent,
      questions: [{
        id: 'foreign-transcript-pick',
        question: `Several ${origin} sessions match ${JSON.stringify(query)}. Which should be imported?`,
        header: 'Import session',
        multiSelect: true,
        options: candidates.map((candidate, index) => ({
          label: labels[index] as string,
          description: `${candidate.startedAt ?? 'unknown date'}${candidate.cwd === undefined ? '' : ` — ${candidate.cwd}`}`,
        })),
      }],
      signal,
    })
    const selected = answer.answers[0]?.selected ?? []
    const chosen = selected
      .map(label => labels.indexOf(label))
      .filter(index => index >= 0)
      .map(index => candidates[index] as ForeignSessionCandidate)
    return chosen.length === 0 ? undefined : chosen
  } catch (error: unknown) {
    if (error instanceof UserQuestionError && error.code === 'ASK_ABORTED') return undefined
    if (error instanceof UserQuestionError && error.code === 'NO_PROVIDER') return undefined
    throw error
  }
}

/**
 * Build the durable source record for one prepared import.
 * @param prepared - the prepared import.
 * @returns the message source naming origin, path, scope, and retention facts.
 */
function foreignSource(prepared: PreparedImport): ForeignTranscriptSource {
  return {
    kind: 'foreign-transcript',
    form: 'recall',
    version: 1,
    origin: prepared.origin,
    path: prepared.path,
    label: basename(prepared.path),
    ...scopeFields(prepared.selection),
    totalItems: prepared.projected.totalItems,
    omittedBytes: prepared.projected.omittedBytes,
  }
}

/**
 * Render the human-facing success account for one prepared import.
 * @param prepared - the prepared import.
 * @returns one-line success text for command and tool results.
 */
function renderSuccess(prepared: PreparedImport): string {
  const omission = prepared.projected.omittedBytes > 0
    ? ` (omitted ${prepared.projected.omittedBytes} bytes from the middle)`
    : ''
  const selection = prepared.selection
  const carried = selection.kind === 'full'
    ? `${prepared.projected.totalItems} transcript items`
    : selection.kind === 'latest'
      ? `the latest exchange (${prepared.projected.totalItems} transcript items)`
      : `the ${selection.direction} ${selection.exchanges} exchanges (${prepared.projected.totalItems} transcript items)`
  return `Imported ${carried}${omission} from ${prepared.origin} session ${prepared.path}.`
}

/**
 * Render the other topic matches for a searched tool result.
 * @param alternatives - candidates besides the imported best match.
 * @returns the bullet list with its leading blank line, or `''` when absent.
 */
function renderAlternatives(alternatives: readonly { path: string; topic: string }[] | undefined): string {
  if (alternatives === undefined || alternatives.length === 0) return ''
  const lines = alternatives.map(candidate => `- ${candidate.topic} — ${candidate.path}`).join('\n')
  return `\nOther matches:\n${lines}`
}

/**
 * Render one search tool result as the model-facing candidate list.
 * @param value - validated canonical output of `search_foreign_sessions`.
 * @returns the numbered candidate block with the follow-up instruction.
 */
function renderSearchResults(value: {
  origin: string
  query: string
  results: { path: string; topic: string; topicSource: string; startedAt?: string; cwd?: string }[]
}): ContentBlock {
  const lines = value.results.map((result, index) => {
    const when = result.startedAt === undefined ? '' : ` (${result.startedAt})`
    return `${index + 1}. ${result.topic}${when}\n   ${result.path}`
  })
  const guidance = value.results.length === 0
    ? `No ${value.origin} session topic matches ${JSON.stringify(value.query)}.`
    : 'Present these matches to the user (use ask_user_question when they should choose), then call import_foreign_session with the chosen path(s).'
  return { type: 'text', text: `${guidance}\n${lines.join('\n')}` }
}

/**
 * Register the human command, the mention expansion, and the model tool.
 * @param ctx - plugin context carrying the extended registries.
 * @param config - plugin configuration validated at load.
 * @throws when configuration values are invalid.
 */
export function apply(ctx: Context, config: Config): void {
  const resolved = resolveConfig(config)

  ctx.commands.register({
    name: COMMAND_NAME,
    description: COMMAND_DESCRIPTION,
    input: { hint: COMMAND_HINT },
    handler: async ({ agent, rawInput, signal }): Promise<CommandResult> => {
      // First line: specifier, scope flags, and topic keywords. Every line
      // after it is the user's instruction for the model, not search input.
      const [requestLine, ...instructionLines] = rawInput.split('\n')
      const instruction = instructionLines.join('\n').trim()
      const tokens = (requestLine ?? '').trim().split(/\s+/u).filter(token => token !== '')
      let scope: ForeignTranscriptScope = 'full'
      let exchanges: number | undefined
      const locating: string[] = []
      for (let index = 0; index < tokens.length; index++) {
        const token = tokens[index] as string
        if (token !== COMMAND_LATEST_FLAG && token !== COMMAND_FIRST_FLAG && token !== COMMAND_LAST_FLAG) {
          locating.push(token)
          continue
        }
        if (scope !== 'full') {
          return { kind: 'error', text: 'choose one scope flag: --latest, --first N, or --last N' }
        }
        if (token === COMMAND_LATEST_FLAG) {
          scope = 'latest'
          continue
        }
        const rawCount = tokens[index + 1]
        const count = rawCount === undefined ? Number.NaN : Number(rawCount)
        if (!Number.isSafeInteger(count) || count < 1) {
          return { kind: 'error', text: `${token} needs a positive integer exchange count, e.g. ${token} 3` }
        }
        scope = token === COMMAND_FIRST_FLAG ? 'first' : 'last'
        exchanges = count
        index++
      }
      const [firstWord, ...rest] = locating
      const specifier = firstWord ?? ''
      const query = rest.join(' ')
      if (specifier === '') return { kind: 'error', text: COMMAND_USAGE }
      const parsed = parseSpecifier(specifier)
      if (query !== '' && parsed.kind === 'path') {
        return { kind: 'error', text: 'topic keywords work with the claude/codex keywords, not with an explicit path' }
      }
      let preparedImports: PreparedImport[]
      let candidates: readonly ForeignSessionCandidate[] = []
      try {
        if (query !== '' && parsed.kind === 'origin') {
          candidates = await searchForeignSessions({ origin: parsed.origin, query, config: resolved, signal })
          if (candidates.length === 0) {
            throw new ForeignTranscriptError(
              `no ${parsed.origin} session topic matches ${JSON.stringify(query)}${NO_TOPIC_MATCH_HINT}`,
              'FOREIGN_TRANSCRIPT_NOT_FOUND',
            )
          }
          const chosen = candidates.length === 1
            ? [candidates[0] as ForeignSessionCandidate]
            : await askWhichSessions(ctx, agent, parsed.origin, query, candidates, signal) ?? [candidates[0] as ForeignSessionCandidate]
          preparedImports = await Promise.all(chosen.map(
            candidate => prepareImport(candidate.path, agent.session.header.cwd ?? process.cwd(), resolved, signal, scope, exchanges),
          ))
        } else {
          preparedImports = [await prepareImport(specifier, agent.session.header.cwd ?? process.cwd(), resolved, signal, scope, exchanges)]
        }
      } catch (error: unknown) {
        if (error instanceof ForeignTranscriptError) return { kind: 'error', text: error.message }
        throw error
      }
      for (const prepared of preparedImports) {
        agent.inject(createUserMessage({
          content: [{ type: 'text', text: prepared.projected.text }],
          source: foreignSource(prepared),
        }))
      }
      const importedList = preparedImports.map(prepared => renderSuccess(prepared)).join('\n')
      const alternatives = renderCandidates(candidates)
      if (instruction !== '') {
        agent.followup(createUserMessage({
          content: [{ type: 'text', text: instruction }],
          source: { kind: 'user' },
        }))
        return {
          kind: 'success',
          text: `${importedList} Your instruction rides the next turn.`
            + (alternatives === '' ? '' : `\nOther topic matches:\n${alternatives}`),
        }
      }
      return {
        kind: 'success',
        text: `${importedList} Each import will accompany your next message; ask your question to continue.`
          + (alternatives === '' ? '' : `\nOther topic matches:\n${alternatives}`),
      }
    },
  })

  ctx.on('agent/pre-step', async ({ agent, signal }, next): Promise<PreStepDecision> => {
    const decision = await next()
    if (decision.kind === 'reject' || signal.aborted) return decision
    const specifiers: string[] = []
    for (const message of decision.messages) {
      if (message.source.kind !== 'user') continue
      for (const block of message.content) {
        if (block.type === 'text') specifiers.push(...extractForeignMentions(block.text))
      }
    }
    if (specifiers.length === 0) return decision
    if (specifiers.length > resolved.maxMentionsPerMessage) {
      throw new ForeignTranscriptError(
        `a message may reference at most ${resolved.maxMentionsPerMessage} foreign sessions`,
        'FOREIGN_TRANSCRIPT_TOO_MANY',
      )
    }
    const contexts: UserMessage[] = []
    for (const mention of specifiers) {
      const { specifier, scope, exchanges } = splitScopeSuffix(mention)
      const prepared = await prepareImport(specifier, agent.session.header.cwd ?? process.cwd(), resolved, signal, scope, exchanges)
      contexts.push(createUserMessage({
        content: [{ type: 'text', text: prepared.projected.text }],
        source: foreignSource(prepared),
      }))
    }
    return { kind: 'enter', messages: [...decision.messages, ...contexts] }
  })

  ctx.tools.register(defineTool({
    name: 'import_foreign_session',
    description: TOOL_DESCRIPTION,
    parameters: {
      specifier: { type: 'string', required: true, description: TOOL_SPECIFIER_DESCRIPTION },
      query: { type: 'string', description: TOOL_QUERY_DESCRIPTION },
      scope: { type: 'string', enum: ['full', 'latest', 'first', 'last'], description: TOOL_SCOPE_DESCRIPTION },
      exchanges: { type: 'number', description: TOOL_EXCHANGES_DESCRIPTION },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          origin: { type: 'string', required: true, enum: ['claude', 'codex'] },
          path: { type: 'string', required: true },
          scope: { type: 'string', required: true, enum: ['full', 'latest', 'first', 'last'] },
          exchanges: { type: 'integer' },
          text: { type: 'string', required: true },
          totalItems: { type: 'integer', required: true },
          omittedBytes: { type: 'integer', required: true },
          matchedTopic: { type: 'string' },
          alternatives: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                path: { type: 'string', required: true },
                topic: { type: 'string', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.matchedTopic === undefined
          ? value.text
          : `Imported the best topic match: ${value.matchedTopic}`
            + renderAlternatives(value.alternatives)
            + `\n\n${value.text}`,
      }],
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const cwd = exec.agent?.session.header.cwd ?? process.cwd()
      const scope = args.scope ?? 'full'
      const parsed = parseSpecifier(args.specifier)
      const query = args.query?.trim() ?? ''
      if (query !== '') {
        if (parsed.kind === 'path') {
          throw new Error('import_foreign_session: query works with the claude/codex keywords, not with an explicit path')
        }
        const searched = await searchAndPrepare(parsed.origin, query, cwd, resolved, exec.signal, scope, args.exchanges)
        const best = searched.candidates[0] as ForeignSessionCandidate
        return {
          origin: searched.prepared.origin,
          path: searched.prepared.path,
          ...scopeFields(searched.prepared.selection),
          text: searched.prepared.projected.text,
          totalItems: searched.prepared.projected.totalItems,
          omittedBytes: searched.prepared.projected.omittedBytes,
          matchedTopic: best.topic,
          alternatives: searched.candidates.slice(1).map(candidate => ({ path: candidate.path, topic: candidate.topic })),
        }
      }
      const prepared = await prepareImport(args.specifier, cwd, resolved, exec.signal, scope, args.exchanges)
      return {
        origin: prepared.origin,
        path: prepared.path,
        ...scopeFields(prepared.selection),
        text: prepared.projected.text,
        totalItems: prepared.projected.totalItems,
        omittedBytes: prepared.projected.omittedBytes,
      }
    },
    presentCall: args => ({
      card: 'generic',
      title: 'Import foreign session',
      kind: 'other',
      rawInput: args.scope === undefined || args.scope === 'full'
        ? args.specifier
        : `${args.specifier} (${args.scope === 'latest' ? 'latest exchange' : `${args.scope} ${args.exchanges ?? '?'} exchanges`})`,
    }),
  }))

  ctx.tools.register(defineTool({
    name: 'search_foreign_sessions',
    description: SEARCH_TOOL_DESCRIPTION,
    parameters: {
      origin: {
        type: 'string',
        required: true,
        enum: ['claude', 'codex'],
        description: 'Which origin\'s session logs to search.',
      },
      query: {
        type: 'string',
        required: true,
        description: 'Topic keywords: every whitespace-separated term must appear in the session topic. An empty string lists the newest sessions.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          origin: { type: 'string', required: true, enum: ['claude', 'codex'] },
          query: { type: 'string', required: true },
          results: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                path: { type: 'string', required: true },
                topic: { type: 'string', required: true },
                topicSource: { type: 'string', required: true, enum: ['summary', 'first-user-message', 'content'] },
                startedAt: { type: 'string' },
                cwd: { type: 'string' },
              },
            },
          },
        },
      },
      render: (_args, value) => [renderSearchResults(value)],
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const candidates = await searchForeignSessions({ origin: args.origin, query: args.query, config: resolved, signal: exec.signal })
      return {
        origin: args.origin,
        query: args.query,
        results: candidates.map(candidate => ({
          path: candidate.path,
          topic: candidate.topic,
          topicSource: candidate.topicSource,
          ...candidate.startedAt === undefined ? {} : { startedAt: candidate.startedAt },
          ...candidate.cwd === undefined ? {} : { cwd: candidate.cwd },
        })),
      }
    },
    presentCall: args => ({ card: 'generic', title: 'Search foreign sessions', kind: 'other', rawInput: args }),
  }))
}
