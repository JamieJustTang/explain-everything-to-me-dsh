import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import AgentRegistry, { agentEvents, type Agent, type PreStepDecision } from '@deepseek-ai/dsh-agent'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import { CallId, createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import UserQuestionService, { UserQuestionError } from '@deepseek-ai/dsh-user-questions'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as foreignTranscript from '../src/index.ts'

const SIGNAL = new AbortController().signal

const CLAUDE_SESSION = `${[
  JSON.stringify({ type: 'user', sessionId: 'c1', cwd: '/work/project', message: { role: 'user', content: 'ship it' } }),
  JSON.stringify({ type: 'assistant', sessionId: 'c1', cwd: '/work/project', message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] } }),
].join('\n')}\n`

const CLAUDE_TWO_EXCHANGES = `${[
  JSON.stringify({ type: 'user', sessionId: 'c2', cwd: '/work/project', message: { role: 'user', content: 'set up the harness' } }),
  JSON.stringify({ type: 'assistant', sessionId: 'c2', cwd: '/work/project', message: { role: 'assistant', content: [{ type: 'text', text: 'harness ready' }] } }),
  JSON.stringify({ type: 'user', sessionId: 'c2', cwd: '/work/project', message: { role: 'user', content: 'ship it now' } }),
  JSON.stringify({ type: 'assistant', sessionId: 'c2', cwd: '/work/project', message: { role: 'assistant', content: [{ type: 'text', text: 'shipped' }] } }),
].join('\n')}\n`

/** A stub agent whose session cwd and inject spy the surfaces read. */
function stubAgent(cwd: string): Agent & { inject: ReturnType<typeof vi.fn> } {
  const id = SessionId('foreign-transcript-test')
  const session = Session.create(id, undefined, {
    version: 0,
    id,
    createdAt: 0,
    cwd,
  })
  return {
    id,
    session,
    inject: vi.fn(),
    followup: vi.fn(),
  } as unknown as Agent & { inject: ReturnType<typeof vi.fn> }
}

async function writeSession(root: string, relative: string, text: string): Promise<string> {
  const path = join(root, relative)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, text, 'utf8')
  await utimes(path, new Date(), new Date())
  return path
}

interface Harness {
  readonly ctx: Context
  readonly plugin: Awaited<ReturnType<Context['plugin']>>
  readonly claudeRoot: string
  readonly asked: { questions: unknown[] }
  cleanup(): Promise<void>
}

async function harness(): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), 'foreign-transcript-ui-'))
  const claudeRoot = join(root, 'claude-projects')
  const codexRoot = join(root, 'codex-sessions')
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(CommandRuntime)
  await ctx.plugin(UserQuestionService)
  const asked = { questions: [] as unknown[] }
  ctx.userQuestions.registerProvider({
    ask: async (request) => {
      asked.questions.push(request)
      if (askBehavior.error !== undefined) throw askBehavior.error
      return { answers: [{ id: request.questions[0]?.id ?? 'q', selected: [...askBehavior.selected] }] }
    },
  })
  const plugin = await ctx.plugin(foreignTranscript, {
    claudeProjectsRoot: claudeRoot,
    codexSessionsRoot: codexRoot,
  })
  return { ctx, plugin, claudeRoot, asked, cleanup: () => rm(root, { recursive: true, force: true }) }
}

/** Scripted answers for the harness's user-questions provider. */
const askBehavior: { selected: string[]; error: UserQuestionError | undefined } = { selected: [], error: undefined }

beforeEach(() => {
  askBehavior.selected = []
  askBehavior.error = undefined
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('foreign-transcript registration', () => {
  it('exposes Loader-safe plugin exports and registers and disposes the command and tool', async () => {
    const test = await harness()
    try {
      expect(foreignTranscript.name).toBe('foreign-transcript')
      expect(foreignTranscript.inject).toEqual(['agents', 'commands', 'tools'])
      const loader = Object.create(Loader.prototype) as Loader
      expect(loader.unwrapExports(foreignTranscript)).toBe(foreignTranscript)
      const agent = stubAgent('/work/project')
      expect(test.ctx.commands.list(agent)).toContainEqual({
        name: 'import-session',
        description: 'Import a Claude Code or Codex session transcript from this machine as conversation context',
        input: { hint: 'claude [topic keywords] | codex [topic keywords] | path to a session .jsonl under the configured roots; --latest / --first N / --last N bound the import to part of the session' },
      })
      const schema = test.ctx.tools.schemas().find(entry => entry.name === 'import_foreign_session')
      expect(schema?.parameters.properties).toMatchObject({
        scope: { enum: ['full', 'latest', 'first', 'last'] },
        exchanges: { type: 'number' },
      })
      expect(test.ctx.tools.schemas().some(schema => schema.name === 'import_foreign_session')).toBe(true)

      await test.plugin.dispose()
      expect(test.ctx.commands.find(agent, 'import-session')).toBeUndefined()
      expect(test.ctx.tools.schemas().some(schema => schema.name === 'import_foreign_session')).toBe(false)
    } finally {
      await test.cleanup()
    }
  })

  it('fails plugin load on invalid configuration', () => {
    expect(() => {
      foreignTranscript.apply(new Context(), { maxMentionsPerMessage: 0 })
    }).toThrow(/positive safe integer/u)
  })
})

describe('/import-session command', () => {
  it('reports usage for empty input', async () => {
    const test = await harness()
    try {
      const agent = stubAgent('/work/project')
      const execution = await test.ctx.commands.execute(agent, '/import-session', SIGNAL)
      expect(execution?.result).toEqual({
        kind: 'error',
        text: 'usage: /import-session [--latest | --first N | --last N] <claude|codex|path-to-session.jsonl> [topic keywords] — "claude"/"codex" imports the newest session for the current project; with keywords the best topic match across all of that origin\'s sessions is imported; --latest keeps only the last user message through the session end, --first N the opening N exchanges, --last N the most recent N exchanges; anything typed after the first line is submitted to the model as your instruction once the import lands',
      })
    } finally {
      await test.cleanup()
    }
  })

  it('injects durable recall context for the newest claude session and reports success', async () => {
    const test = await harness()
    try {
      const path = await writeSession(
        test.claudeRoot,
        join('-work-project', 'session-1.jsonl'),
        CLAUDE_SESSION,
      )
      const agent = stubAgent('/work/project')
      const execution = await test.ctx.commands.execute(agent, '/import-session claude', SIGNAL)
      expect(execution?.result.kind).toBe('success')
      if (execution?.result.kind !== 'success') throw new Error('expected success')
      expect(execution.result.text).toContain('Imported 2 transcript items')
      expect(execution.result.text).toContain(path)
      expect(agent.inject).toHaveBeenCalledTimes(1)
      const injected = agent.inject.mock.calls[0]![0] as { source: unknown; content: { type: string; text: string }[] }
      expect(injected.source).toEqual({
        kind: 'foreign-transcript',
        form: 'recall',
        version: 1,
        origin: 'claude',
        path,
        label: 'session-1.jsonl',
        scope: 'full',
        totalItems: 2,
        omittedBytes: 0,
      })
      expect(injected.content[0]?.text).toContain('<foreign-session origin="claude"')
      expect(injected.content[0]?.text).toContain('[user]\nship it')
    } finally {
      await test.cleanup()
    }
  })

  it('imports only the latest exchange with the --latest flag, and reports usage when the flag names no session', async () => {
    const test = await harness()
    try {
      await writeSession(
        test.claudeRoot,
        join('-work-project', 'session-latest.jsonl'),
        CLAUDE_TWO_EXCHANGES,
      )
      const agent = stubAgent('/work/project')
      const execution = await test.ctx.commands.execute(agent, '/import-session --latest claude', SIGNAL)
      expect(execution?.result.kind).toBe('success')
      if (execution?.result.kind !== 'success') throw new Error('expected success')
      expect(execution.result.text).toContain('Imported the latest exchange (2 transcript items)')
      expect(agent.inject).toHaveBeenCalledTimes(1)
      const injected = agent.inject.mock.calls[0]![0] as {
        source: { scope: string; totalItems: number }
        content: { type: string; text: string }[]
      }
      expect(injected.source).toMatchObject({ scope: 'latest', totalItems: 2 })
      expect(injected.content[0]?.text).toContain('Scope: latest exchange only')
      expect(injected.content[0]?.text).toContain('[user]\nship it now')
      expect(injected.content[0]?.text).not.toContain('set up the harness')

      const flagAlone = await test.ctx.commands.execute(agent, '/import-session --latest', SIGNAL)
      expect(flagAlone?.result).toMatchObject({ kind: 'error' })
      if (flagAlone?.result.kind !== 'error') throw new Error('expected error')
      expect(flagAlone.result.text).toMatch(/^usage:/u)

      const opening = await test.ctx.commands.execute(agent, '/import-session --first 1 claude', SIGNAL)
      expect(opening?.result.kind).toBe('success')
      if (opening?.result.kind !== 'success') throw new Error('expected success')
      expect(opening.result.text).toContain('Imported the first 1 exchanges (2 transcript items)')
      const openingInjected = agent.inject.mock.calls.at(-1)?.[0] as {
        source: { scope: string; exchanges?: number }
        content: { text: string }[]
      }
      expect(openingInjected.source).toMatchObject({ scope: 'first', exchanges: 1 })
      expect(openingInjected.content[0]?.text).toContain('[user]\nset up the harness')
      expect(openingInjected.content[0]?.text).not.toContain('ship it now')

      const closing = await test.ctx.commands.execute(agent, '/import-session claude --last 1', SIGNAL)
      expect(closing?.result.kind).toBe('success')
      expect(closing?.result.kind === 'success' && closing.result.text).toContain('Imported the last 1 exchanges (2 transcript items)')

      const conflicted = await test.ctx.commands.execute(agent, '/import-session --latest --first 2 claude', SIGNAL)
      expect(conflicted?.result).toMatchObject({ kind: 'error' })
      if (conflicted?.result.kind !== 'error') throw new Error('expected error')
      expect(conflicted.result.text).toMatch(/choose one scope flag/u)

      const missingCount = await test.ctx.commands.execute(agent, '/import-session --first claude', SIGNAL)
      expect(missingCount?.result).toMatchObject({ kind: 'error' })
      if (missingCount?.result.kind !== 'error') throw new Error('expected error')
      expect(missingCount.result.text).toMatch(/needs a positive integer exchange count/u)
    } finally {
      await test.cleanup()
    }
  })

  it('submits the lines after the first as the instruction for the next turn', async () => {
    const test = await harness()
    try {
      await writeSession(
        test.claudeRoot,
        join('-work-project', 'session-instruct.jsonl'),
        CLAUDE_SESSION,
      )
      const agent = stubAgent('/work/project')
      const execution = await test.ctx.commands.execute(
        agent,
        '/import-session claude ship\n\n向我解释GPT提出的CHI工程和实验设计文档。',
        SIGNAL,
      )
      expect(execution?.result.kind).toBe('success')
      if (execution?.result.kind !== 'success') throw new Error('expected success')
      expect(execution.result.text).toContain('rides the next turn')
      expect(agent.inject).toHaveBeenCalledTimes(1)
      const followupSpy = vi.spyOn(agent, 'followup')
      expect(followupSpy).toHaveBeenCalledTimes(1)
      const followup = followupSpy.mock.calls[0]![0] as { source: unknown; content: { type: string; text: string }[] }
      expect(followup.source).toEqual({ kind: 'user' })
      expect(followup.content[0]?.text).toBe('向我解释GPT提出的CHI工程和实验设计文档。')

      const single = await test.ctx.commands.execute(agent, '/import-session claude', SIGNAL)
      expect(single?.result.kind).toBe('success')
      expect(followupSpy).toHaveBeenCalledTimes(1)
    } finally {
      await test.cleanup()
    }
  })

  it('imports the best topic match and lists the alternatives', async () => {
    const test = await harness()
    try {
      const best = await writeSession(
        test.claudeRoot,
        join('-other-project', 'topic-best.jsonl'),
        `${JSON.stringify({ type: 'summary', summary: 'Parser hardening rollout', sessionId: 'tb', cwd: '/other/project' })}\n${CLAUDE_SESSION}`,
      )
      const other = await writeSession(
        test.claudeRoot,
        join('-work-project', 'topic-other.jsonl'),
        CLAUDE_SESSION.replace('ship it', 'ship the parser rewrite'),
      )
      const agent = stubAgent('/work/project')
      const execution = await test.ctx.commands.execute(agent, '/import-session claude parser', SIGNAL)
      expect(execution?.result.kind).toBe('success')
      if (execution?.result.kind !== 'success') throw new Error('expected success')
      expect(execution.result.text).toContain(best)
      expect(execution.result.text).toContain('Other topic matches:')
      expect(execution.result.text).toContain(other)
      expect(agent.inject).toHaveBeenCalledTimes(1)
    } finally {
      await test.cleanup()
    }
  })

  it('asks which matches to import when several topics match, honoring multi-select', async () => {
    const test = await harness()
    try {
      const first = await writeSession(
        test.claudeRoot,
        join('-other-project', 'pick-a.jsonl'),
        `${JSON.stringify({ type: 'summary', summary: 'Parser hardening rollout', sessionId: 'pa', cwd: '/other/project' })}\n${CLAUDE_SESSION}`,
      )
      const second = await writeSession(
        test.claudeRoot,
        join('-work-project', 'pick-b.jsonl'),
        CLAUDE_SESSION.replace('ship it', 'ship the parser rewrite'),
      )
      askBehavior.selected = ['2. ship the parser rewrite', '1. Parser hardening rollout']
      const agent = stubAgent('/work/project')
      const execution = await test.ctx.commands.execute(agent, '/import-session claude parser', SIGNAL)
      expect(execution?.result.kind).toBe('success')
      expect(test.asked.questions).toHaveLength(1)
      const question = (test.asked.questions[0] as { questions: { multiSelect?: boolean; options: { label: string }[] }[] }).questions[0]
      expect(question?.multiSelect).toBe(true)
      expect(question?.options.map(option => option.label)).toEqual([
        '1. Parser hardening rollout',
        '2. ship the parser rewrite',
      ])
      expect(agent.inject).toHaveBeenCalledTimes(2)
      const injectedPaths = agent.inject.mock.calls.map(call => (call[0] as { source: { path: string } }).source.path)
      expect(injectedPaths).toEqual([second, first])
      expect(execution?.result.kind === 'success' && execution.result.text).toContain(second)
    } finally {
      await test.cleanup()
    }
  })

  it('imports a single match without asking, and falls back to the best match when the question aborts', async () => {
    const test = await harness()
    try {
      await writeSession(
        test.claudeRoot,
        join('-work-project', 'only-one.jsonl'),
        CLAUDE_SESSION.replace('ship it', 'ship the parser rewrite'),
      )
      const agent = stubAgent('/work/project')
      await test.ctx.commands.execute(agent, '/import-session claude parser', SIGNAL)
      expect(test.asked.questions).toHaveLength(0)
      expect(agent.inject).toHaveBeenCalledTimes(1)

      await writeSession(
        test.claudeRoot,
        join('-other-project', 'second-match.jsonl'),
        `${JSON.stringify({ type: 'summary', summary: 'Parser hardening rollout', sessionId: 'sm', cwd: '/other/project' })}\n${CLAUDE_SESSION}`,
      )
      askBehavior.error = new UserQuestionError('ask_user_question was aborted before the user answered', 'ASK_ABORTED')
      const aborted = await test.ctx.commands.execute(agent, '/import-session claude parser', SIGNAL)
      expect(aborted?.result.kind).toBe('success')
      if (aborted?.result.kind !== 'success') throw new Error('expected success')
      expect(aborted.result.text).toContain('Other topic matches:')
      expect(agent.inject).toHaveBeenCalledTimes(2)
      const lastInjected = agent.inject.mock.calls.at(-1)?.[0] as { source: { path: string } }
      expect(lastInjected.source.path).toContain('second-match.jsonl')
    } finally {
      await test.cleanup()
    }
  })

  it('reports a topic search with no matches, and rejects keywords with an explicit path', async () => {
    const test = await harness()
    try {
      const agent = stubAgent('/work/project')
      const missing = await test.ctx.commands.execute(agent, '/import-session claude nothing-matches-this', SIGNAL)
      expect(missing?.result).toMatchObject({ kind: 'error' })
      if (missing?.result.kind !== 'error') throw new Error('expected error')
      expect(missing.result.text).toMatch(/no claude session topic matches "nothing-matches-this"/u)

      const path = join(test.claudeRoot, 'anywhere.jsonl')
      const rejected = await test.ctx.commands.execute(agent, `/import-session ${path} extra words`, SIGNAL)
      expect(rejected?.result).toMatchObject({ kind: 'error' })
      if (rejected?.result.kind !== 'error') throw new Error('expected error')
      expect(rejected.result.text).toMatch(/keywords work with the claude\/codex keywords/u)
    } finally {
      await test.cleanup()
    }
  })

  it('returns an error result for a missing session', async () => {
    const test = await harness()
    try {
      const agent = stubAgent('/work/project')
      const execution = await test.ctx.commands.execute(agent, '/import-session claude', SIGNAL)
      expect(execution?.result).toMatchObject({ kind: 'error' })
      if (execution?.result.kind !== 'error') throw new Error('expected error')
      expect(execution.result.text).toMatch(/no Claude session directory/u)
    } finally {
      await test.cleanup()
    }
  })
})

describe('foreign-session mentions in user text', () => {
  async function fire(
    ctx: Context,
    agent: Agent,
    messages: UserMessage[],
    signal: AbortSignal = SIGNAL,
  ): Promise<PreStepDecision> {
    return agentEvents(ctx, agent).waterfall(
      'agent/pre-step',
      { messages: [], turn: 1, step: 1, signal },
      () => Promise.resolve({ kind: 'enter' as const, messages }),
    )
  }

  function enterMessages(decision: PreStepDecision): UserMessage[] {
    if (decision.kind !== 'enter') throw new Error(`expected enter decision, got ${decision.kind}`)
    return decision.messages
  }

  it('appends recall context after the claimed user message', async () => {
    const test = await harness()
    try {
      const path = await writeSession(
        test.claudeRoot,
        join('-work-project', 'session-2.jsonl'),
        CLAUDE_SESSION,
      )
      const agent = stubAgent('/work/project')
      const userMessage = createUserMessage({
        content: [{ type: 'text', text: `continue from foreign-session:${path} and finish the work` }],
        source: { kind: 'user' },
      })
      const messages = enterMessages(await fire(test.ctx, agent, [userMessage]))
      expect(messages).toHaveLength(2)
      expect(messages[0]).toBe(userMessage)
      expect(messages[1]?.source).toMatchObject({ kind: 'foreign-transcript', origin: 'claude', path })
      const block = messages[1]?.content[0]
      if (block?.type !== 'text') throw new Error('expected text context block')
      expect(block.text).toContain('[user]\nship it')
    } finally {
      await test.cleanup()
    }
  })

  it('expands a ?latest mention into latest-exchange context only', async () => {
    const test = await harness()
    try {
      const path = await writeSession(
        test.claudeRoot,
        join('-work-project', 'session-2.jsonl'),
        CLAUDE_TWO_EXCHANGES,
      )
      const agent = stubAgent('/work/project')
      const userMessage = createUserMessage({
        content: [{ type: 'text', text: `what did it just do? foreign-session:${path}?latest` }],
        source: { kind: 'user' },
      })
      const messages = enterMessages(await fire(test.ctx, agent, [userMessage]))
      expect(messages).toHaveLength(2)
      expect(messages[1]?.source).toMatchObject({ kind: 'foreign-transcript', path, scope: 'latest' })
      const block = messages[1]?.content[0]
      if (block?.type !== 'text') throw new Error('expected text context block')
      expect(block.text).toContain('Scope: latest exchange only')
      expect(block.text).toContain('[user]\nship it now')
      expect(block.text).not.toContain('set up the harness')
    } finally {
      await test.cleanup()
    }
  })

  it('expands a ?last-N mention into a counted closing window', async () => {
    const test = await harness()
    try {
      const path = await writeSession(
        test.claudeRoot,
        join('-work-project', 'session-2.jsonl'),
        CLAUDE_TWO_EXCHANGES,
      )
      const agent = stubAgent('/work/project')
      const userMessage = createUserMessage({
        content: [{ type: 'text', text: `recap the finish: foreign-session:${path}?last-1` }],
        source: { kind: 'user' },
      })
      const messages = enterMessages(await fire(test.ctx, agent, [userMessage]))
      expect(messages).toHaveLength(2)
      expect(messages[1]?.source).toMatchObject({ kind: 'foreign-transcript', path, scope: 'last', exchanges: 1 })
      const block = messages[1]?.content[0]
      if (block?.type !== 'text') throw new Error('expected text context block')
      expect(block.text).toContain('Scope: last 1 exchange')
      expect(block.text).toContain('[user]\nship it now')
      expect(block.text).not.toContain('set up the harness')
    } finally {
      await test.cleanup()
    }
  })

  it('leaves steps without mentions untouched, passes rejects through, and stops on aborted signals', async () => {
    const test = await harness()
    try {
      const agent = stubAgent('/work/project')
      const plain = createUserMessage({ content: [{ type: 'text', text: 'no mention here' }], source: { kind: 'user' } })
      expect(enterMessages(await fire(test.ctx, agent, [plain]))).toEqual([plain])

      const controller = new AbortController()
      controller.abort()
      const withMention = createUserMessage({
        content: [{ type: 'text', text: `foreign-session:${join(test.claudeRoot, 'anywhere.jsonl')}` }],
        source: { kind: 'user' },
      })
      expect(enterMessages(await fire(test.ctx, agent, [withMention], controller.signal))).toEqual([withMention])

      const rejected = await agentEvents(test.ctx, agent).waterfall(
        'agent/pre-step',
        { messages: [], turn: 1, step: 1, signal: SIGNAL },
        () => Promise.resolve({ kind: 'reject' as const }),
      )
      expect(rejected.kind).toBe('reject')
    } finally {
      await test.cleanup()
    }
  })

  it('ignores mentions inside non-user messages and rejects too many references', async () => {
    const test = await harness()
    try {
      const agent = stubAgent('/work/project')
      const pluginSourced = createUserMessage({
        content: [{ type: 'text', text: 'foreign-session:claude' }],
        source: { kind: 'foreign-transcript', form: 'recall', version: 1, origin: 'claude', path: '/x', label: 'x', scope: 'full', totalItems: 0, omittedBytes: 0 },
      })
      expect(enterMessages(await fire(test.ctx, agent, [pluginSourced]))).toEqual([pluginSourced])

      const four = createUserMessage({
        content: [{ type: 'text', text: 'foreign-session:a foreign-session:b foreign-session:c foreign-session:d' }],
        source: { kind: 'user' },
      })
      await expect(fire(test.ctx, agent, [four])).rejects.toThrow(/at most 3 foreign sessions/u)
    } finally {
      await test.cleanup()
    }
  })
})

describe('import_foreign_session tool', () => {
  let callCounter = 0

  it('searches by topic through the query parameter and rejects it for explicit paths', async () => {
    const test = await harness()
    try {
      await writeSession(
        test.claudeRoot,
        join('-other-project', 'tool-best.jsonl'),
        `${JSON.stringify({ type: 'summary', summary: 'Parser hardening rollout', sessionId: 'tb2', cwd: '/other/project' })}\n${CLAUDE_SESSION}`,
      )
      await writeSession(
        test.claudeRoot,
        join('-work-project', 'tool-other.jsonl'),
        CLAUDE_SESSION.replace('ship it', 'ship the parser rewrite'),
      )
      const agent = stubAgent('/work/project')
      const result = await test.ctx.tools.execute({
        signal: SIGNAL,
        callId: CallId(`call-${++callCounter}`),
        name: 'import_foreign_session',
        arguments: { specifier: 'claude', query: 'parser' },
        agent,
      })
      expect(result.isError).not.toBe(true)
      const text = result.content.filter(block => block.type === 'text').map(block => block.text).join('')
      expect(text).toContain('Imported the best topic match: Parser hardening rollout')
      expect(text).toContain('Other matches:')
      expect(text).toContain('ship the parser rewrite')
      expect(text).toContain('[user]')

      const rejected = await test.ctx.tools.execute({
        signal: SIGNAL,
        callId: CallId(`call-${++callCounter}`),
        name: 'import_foreign_session',
        arguments: { specifier: '/etc/hosts', query: 'parser' },
        agent,
      })
      expect(rejected.isError).toBe(true)
    } finally {
      await test.cleanup()
    }
  })

  it('lists candidates without importing', async () => {
    const test = await harness()
    try {
      await writeSession(
        test.claudeRoot,
        join('-other-project', 'list-a.jsonl'),
        `${JSON.stringify({ type: 'summary', summary: 'Parser hardening rollout', sessionId: 'la', cwd: '/other/project' })}\n${CLAUDE_SESSION}`,
      )
      const agent = stubAgent('/work/project')
      const result = await test.ctx.tools.execute({
        signal: SIGNAL,
        callId: CallId(`call-${++callCounter}`),
        name: 'search_foreign_sessions',
        arguments: { origin: 'claude', query: 'parser' },
        agent,
      })
      expect(result.isError).not.toBe(true)
      const text = result.content.filter(block => block.type === 'text').map(block => block.text).join('')
      expect(text).toContain('1. Parser hardening rollout')
      expect(text).toContain('list-a.jsonl')
      expect(text).toContain('ask_user_question')
      expect(agent.inject).not.toHaveBeenCalled()
    } finally {
      await test.cleanup()
    }
  })

  it('returns the projected transcript for a valid specifier and rejects paths outside the roots', async () => {
    const test = await harness()
    try {
      await writeSession(
        test.claudeRoot,
        join('-work-project', 'session-3.jsonl'),
        CLAUDE_SESSION,
      )
      const agent = stubAgent('/work/project')
      const result = await test.ctx.tools.execute({
        signal: SIGNAL,
        callId: CallId(`call-${++callCounter}`),
        name: 'import_foreign_session',
        arguments: { specifier: 'claude' },
        agent,
      })
      const text = result.content.filter(block => block.type === 'text').map(block => block.text).join('')
      expect(text).toContain('[user]\nship it')
      expect(text).not.toContain('Scope: latest exchange only')

      const failure = await test.ctx.tools.execute({
        signal: SIGNAL,
        callId: CallId(`call-${++callCounter}`),
        name: 'import_foreign_session',
        arguments: { specifier: '/etc/hosts' },
        agent,
      })
      expect(failure.isError).toBe(true)
      const failureText = failure.content.filter(block => block.type === 'text').map(block => block.text).join('')
      expect(failureText).toMatch(/outside the configured roots/u)
    } finally {
      await test.cleanup()
    }
  })

  it('imports only the latest exchange through the scope parameter', async () => {
    const test = await harness()
    try {
      await writeSession(
        test.claudeRoot,
        join('-work-project', 'session-4.jsonl'),
        CLAUDE_TWO_EXCHANGES,
      )
      const agent = stubAgent('/work/project')
      const result = await test.ctx.tools.execute({
        signal: SIGNAL,
        callId: CallId(`call-${++callCounter}`),
        name: 'import_foreign_session',
        arguments: { specifier: 'claude', scope: 'latest' },
        agent,
      })
      expect(result.isError).not.toBe(true)
      const text = result.content.filter(block => block.type === 'text').map(block => block.text).join('')
      expect(text).toContain('Scope: latest exchange only')
      expect(text).toContain('[user]\nship it now')
      expect(text).not.toContain('set up the harness')
    } finally {
      await test.cleanup()
    }
  })

  it('imports counted windows through scope plus exchanges, rejecting unpaired values', async () => {
    const test = await harness()
    try {
      await writeSession(
        test.claudeRoot,
        join('-work-project', 'session-5.jsonl'),
        CLAUDE_TWO_EXCHANGES,
      )
      const agent = stubAgent('/work/project')
      const opening = await test.ctx.tools.execute({
        signal: SIGNAL,
        callId: CallId(`call-${++callCounter}`),
        name: 'import_foreign_session',
        arguments: { specifier: 'claude', scope: 'first', exchanges: 1 },
        agent,
      })
      expect(opening.isError).not.toBe(true)
      const openingText = opening.content.filter(block => block.type === 'text').map(block => block.text).join('')
      expect(openingText).toContain('Scope: first 1 exchange')
      expect(openingText).toContain('[user]\nset up the harness')
      expect(openingText).not.toContain('ship it now')

      const missing = await test.ctx.tools.execute({
        signal: SIGNAL,
        callId: CallId(`call-${++callCounter}`),
        name: 'import_foreign_session',
        arguments: { specifier: 'claude', scope: 'last' },
        agent,
      })
      expect(missing.isError).toBe(true)
      const missingText = missing.content.filter(block => block.type === 'text').map(block => block.text).join('')
      expect(missingText).toMatch(/requires exchanges/u)

      const unpaired = await test.ctx.tools.execute({
        signal: SIGNAL,
        callId: CallId(`call-${++callCounter}`),
        name: 'import_foreign_session',
        arguments: { specifier: 'claude', scope: 'full', exchanges: 2 },
        agent,
      })
      expect(unpaired.isError).toBe(true)
      const unpairedText = unpaired.content.filter(block => block.type === 'text').map(block => block.text).join('')
      expect(unpairedText).toMatch(/takes no exchanges/u)
    } finally {
      await test.cleanup()
    }
  })
})
