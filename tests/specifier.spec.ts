import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, rm, utimes, writeFile, chmod } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  claudeProjectSlug,
  expandHome,
  parseSpecifier,
  resolveForeignSession,
  splitScopeSuffix,
} from '../src/specifier.ts'
import {
  ForeignTranscriptError,
  resolveConfig,
  DEFAULT_MAX_MENTIONS_PER_MESSAGE,
  DEFAULT_MAX_TOOL_BRIEF_CHARS,
  DEFAULT_MAX_TRANSCRIPT_BYTES,
} from '../src/config.ts'

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe('resolveConfig', () => {
  it('applies defaults and overrides', () => {
    expect(resolveConfig({})).toEqual({
      claudeProjectsRoot: '~/.claude/projects',
      codexSessionsRoot: '~/.codex/sessions',
      maxTranscriptBytes: DEFAULT_MAX_TRANSCRIPT_BYTES,
      maxMentionsPerMessage: DEFAULT_MAX_MENTIONS_PER_MESSAGE,
      latestScanLimit: 200,
      maxToolBriefChars: DEFAULT_MAX_TOOL_BRIEF_CHARS,
      searchHeadBytes: 32_768,
      searchResults: 5,
    })
    expect(resolveConfig({ claudeProjectsRoot: '/c', latestScanLimit: 5 })).toMatchObject({
      claudeProjectsRoot: '/c',
      latestScanLimit: 5,
    })
  })

  it.each([
    [{ claudeProjectsRoot: '' }, /claudeProjectsRoot must be a non-empty string/u],
    [{ codexSessionsRoot: '' }, /codexSessionsRoot must be a non-empty string/u],
    [{ maxTranscriptBytes: 0 }, /maxTranscriptBytes must be a positive safe integer/u],
    [{ maxMentionsPerMessage: 1.5 }, /maxMentionsPerMessage must be a positive safe integer/u],
    [{ latestScanLimit: -1 }, /latestScanLimit must be a positive safe integer/u],
    [{ maxToolBriefChars: Number.NaN }, /maxToolBriefChars must be a positive safe integer/u],
    [{ maxMentionsPerMessage: 6 }, /maxMentionsPerMessage must not exceed 5/u],
  ])('rejects invalid values', (config, message) => {
    expect(() => resolveConfig(config)).toThrow(message)
  })
})

describe('parseSpecifier', () => {
  it('parses origin keywords and trimmed paths', () => {
    expect(parseSpecifier('claude')).toEqual({ kind: 'origin', origin: 'claude' })
    expect(parseSpecifier(' codex ')).toEqual({ kind: 'origin', origin: 'codex' })
    expect(parseSpecifier(' /tmp/session.jsonl\n')).toEqual({ kind: 'path', path: '/tmp/session.jsonl' })
    expect(() => parseSpecifier('   ')).toThrow(ForeignTranscriptError)
  })
})

describe('claudeProjectSlug', () => {
  it('maps every non-alphanumeric character to one dash', () => {
    expect(claudeProjectSlug('/Users/jamie/Desktop/Knoweia/.claude/worktrees/sharp-lewin-64a8e5'))
      .toBe('-Users-jamie-Desktop-Knoweia--claude-worktrees-sharp-lewin-64a8e5')
    expect(claudeProjectSlug('/Users/jamie/桌面/项目')).toBe('-Users-jamie------')
  })
})

describe('expandHome', () => {
  it('expands one leading tilde segment only', () => {
    vi.stubEnv('HOME', '/home/tester')
    expect(expandHome('~')).toBe('/home/tester')
    expect(expandHome('~/sessions')).toBe('/home/tester/sessions')
    expect(expandHome('~\\sessions')).toBe('/home/tester/sessions')
    expect(expandHome('/opt/sessions')).toBe('/opt/sessions')
  })
})

/** One throwaway two-root sandbox with Claude and Codex session files. */
interface Sandbox {
  readonly root: string
  readonly claudeRoot: string
  readonly codexRoot: string
  readonly config: ReturnType<typeof resolveConfig>
  cleanup(): Promise<void>
}

async function sandbox(): Promise<Sandbox> {
  const root = await mkdtemp(join(tmpdir(), 'foreign-transcript-'))
  const claudeRoot = join(root, 'claude-projects')
  const codexRoot = join(root, 'codex-sessions')
  await mkdir(claudeRoot, { recursive: true })
  await mkdir(codexRoot, { recursive: true })
  const config = resolveConfig({ claudeProjectsRoot: claudeRoot, codexSessionsRoot: codexRoot })
  return {
    root,
    claudeRoot,
    codexRoot,
    config,
    cleanup: () => rm(root, { recursive: true, force: true }),
  }
}

const CLAUDE_SESSION = `${[
  JSON.stringify({ type: 'user', sessionId: 'c1', cwd: '/work/project', gitBranch: 'main', timestamp: '2026-08-15T08:00:00.000Z', message: { role: 'user', content: 'ship it' } }),
  JSON.stringify({ type: 'assistant', sessionId: 'c1', cwd: '/work/project', message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] } }),
].join('\n')}\n`

function codexSession(cwd: string, message: string): string {
  return `${[
    JSON.stringify({ type: 'session_meta', payload: { id: `id-${message}`, cwd } }),
    JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: message }] } }),
  ].join('\n')}\n`
}

async function write(path: string, text: string, ageSeconds: number): Promise<void> {
  await writeFile(path, text, 'utf8')
  const time = new Date(Date.now() - ageSeconds * 1000)
  await utimes(path, time, time)
}

describe('resolveForeignSession', () => {
  it('resolves the newest claude session for the working directory', async () => {
    const box = await sandbox()
    try {
      const project = join(box.claudeRoot, claudeProjectSlug('/work/project'))
      await mkdir(project)
      await write(join(project, 'older.jsonl'), CLAUDE_SESSION, 500)
      await write(join(project, 'newer.jsonl'), CLAUDE_SESSION, 100)
      await write(join(project, 'notes.txt'), 'not a session', 1)
      const resolved = await resolveForeignSession({ specifier: 'claude', cwd: '/work/project', config: box.config })
      expect(resolved.origin).toBe('claude')
      expect(resolved.path).toBe(join(project, 'newer.jsonl'))
      expect(resolved.transcript.items).toEqual([
        { kind: 'user', text: 'ship it' },
        { kind: 'assistant', text: 'done' },
      ])
    } finally {
      await box.cleanup()
    }
  })

  it('fails loudly when the claude project directory is absent or holds no session file', async () => {
    const box = await sandbox()
    try {
      await expect(resolveForeignSession({ specifier: 'claude', cwd: '/work/project', config: box.config }))
        .rejects.toThrow(/no Claude session directory/u)
      const project = join(box.claudeRoot, claudeProjectSlug('/work/project'))
      await mkdir(project)
      await expect(resolveForeignSession({ specifier: 'claude', cwd: '/work/project', config: box.config }))
        .rejects.toThrow(/no Claude session files/u)
    } finally {
      await box.cleanup()
    }
  })

  it('resolves the newest codex session matching the recorded working directory', async () => {
    const box = await sandbox()
    try {
      const day = join(box.codexRoot, '2026', '08', '15')
      await mkdir(day, { recursive: true })
      await write(join(day, 'rollout-a.jsonl'), codexSession('/other/project', 'other work'), 50)
      await write(join(day, 'rollout-b.jsonl'), codexSession('/work/project', 'matching work'), 100)
      await write(join(day, 'rollout-c.jsonl'), codexSession('/work/project', 'older matching work'), 900)
      const resolved = await resolveForeignSession({ specifier: 'codex', cwd: '/work/project', config: box.config })
      expect(resolved.origin).toBe('codex')
      expect(resolved.path.endsWith('rollout-b.jsonl')).toBe(true)
      expect(resolved.transcript.items).toEqual([{ kind: 'user', text: 'matching work' }])
    } finally {
      await box.cleanup()
    }
  })

  it('skips unreadable and malformed codex headers, and reports the scan limit', async () => {
    const box = await sandbox()
    try {
      const day = join(box.codexRoot, '2026', '08', '15')
      await mkdir(day, { recursive: true })
      const unreadable = join(day, 'rollout-unreadable.jsonl')
      await write(unreadable, codexSession('/work/project', 'locked'), 10)
      await chmod(unreadable, 0o000)
      const malformed = join(day, 'rollout-malformed.jsonl')
      await write(malformed, 'this header is not json\n', 20)
      await write(join(day, 'rollout-mismatch.jsonl'), codexSession('/elsewhere', 'mismatch'), 30)
      const limited = resolveConfig({ codexSessionsRoot: box.codexRoot, latestScanLimit: 1 })
      await expect(resolveForeignSession({ specifier: 'codex', cwd: '/work/project', config: limited }))
        .rejects.toThrow(/latestScanLimit 1/u)
      await expect(resolveForeignSession({ specifier: 'codex', cwd: '/work/project', config: box.config }))
        .rejects.toThrow(/no Codex session for "\/work\/project"/u)
    } finally {
      await box.cleanup()
    }
  })

  it('grows the header buffer for a very long first line', async () => {
    const box = await sandbox()
    try {
      const day = join(box.codexRoot, '2026', '08', '15')
      await mkdir(day, { recursive: true })
      const padding = 'x'.repeat(9000)
      const text = `${JSON.stringify({ type: 'session_meta', payload: { id: 'p', cwd: '/work/project', padding } })}\n${JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'long header ok' }] } })}\n`
      await write(join(day, 'rollout-long.jsonl'), text, 1)
      const resolved = await resolveForeignSession({ specifier: 'codex', cwd: '/work/project', config: box.config })
      expect(resolved.transcript.items).toEqual([{ kind: 'assistant', text: 'long header ok' }])
    } finally {
      await box.cleanup()
    }
  })

  it('fails loudly when the codex root holds no session file', async () => {
    const box = await sandbox()
    try {
      await expect(resolveForeignSession({ specifier: 'codex', cwd: '/work/project', config: box.config }))
        .rejects.toThrow(/no Codex session files/u)
    } finally {
      await box.cleanup()
    }
  })

  it('resolves explicit paths inside either root, relative to cwd, with tilde expansion', async () => {
    const box = await sandbox()
    try {
      vi.stubEnv('HOME', box.root)
      const project = join(box.claudeRoot, claudeProjectSlug('/work/project'))
      await mkdir(project)
      const file = join(project, 'explicit.jsonl')
      await write(file, CLAUDE_SESSION, 1)
      const claudeRelative = await resolveForeignSession({ specifier: 'explicit.jsonl', cwd: project, config: box.config })
      expect(claudeRelative.origin).toBe('claude')
      expect(claudeRelative.path).toBe(file)
      const day = join(box.codexRoot, '2026', '08', '15')
      await mkdir(day, { recursive: true })
      const codexFile = join(day, 'rollout-explicit.jsonl')
      await write(codexFile, codexSession('/work/project', 'explicit codex'), 1)
      const viaTilde = await resolveForeignSession({
        specifier: codexFile.replace(box.root, '~'),
        cwd: '/work/project',
        config: box.config,
      })
      expect(viaTilde.path).toBe(codexFile)
      expect(viaTilde.origin).toBe('codex')
    } finally {
      await box.cleanup()
    }
  })

  it('rejects paths outside the configured roots and unreadable or unrecognized files', async () => {
    const box = await sandbox()
    try {
      await expect(resolveForeignSession({ specifier: '/etc/hosts', cwd: '/work/project', config: box.config }))
        .rejects.toThrow(/outside the configured roots/u)
      const project = join(box.claudeRoot, claudeProjectSlug('/work/project'))
      await mkdir(project)
      await expect(resolveForeignSession({ specifier: join(project, 'missing.jsonl'), cwd: '/work/project', config: box.config }))
        .rejects.toThrow(/failed to read session file/u)
      const unknown = join(project, 'unknown.jsonl')
      await write(unknown, `${JSON.stringify({ type: 'strange-record' })}\n`, 1)
      await expect(resolveForeignSession({ specifier: unknown, cwd: '/work/project', config: box.config }))
        .rejects.toThrow(/matches neither/u)
      const garbage = join(project, 'garbage.jsonl')
      await write(garbage, 'not json\nalso not json\n', 1)
      await expect(resolveForeignSession({ specifier: garbage, cwd: '/work/project', config: box.config }))
        .rejects.toThrow(/holds no parsable session records/u)
    } finally {
      await box.cleanup()
    }
  })

  it('propagates cancellation from file reads', async () => {
    const box = await sandbox()
    try {
      const project = join(box.claudeRoot, claudeProjectSlug('/work/project'))
      await mkdir(project)
      await write(join(project, 'explicit.jsonl'), CLAUDE_SESSION, 1)
      const controller = new AbortController()
      controller.abort()
      await expect(resolveForeignSession({
        specifier: 'claude',
        cwd: '/work/project',
        config: box.config,
        signal: controller.signal,
      })).rejects.toThrow()
      await expect(resolveForeignSession({
        specifier: join(project, 'explicit.jsonl'),
        cwd: '/work/project',
        config: box.config,
        signal: controller.signal,
      })).rejects.toThrow()
      // An aborted signal plus a failing directory read surfaces the raw I/O
      // error instead of the not-found diagnosis.
      await expect(resolveForeignSession({
        specifier: 'claude',
        cwd: '/work/project/absent',
        config: box.config,
        signal: controller.signal,
      })).rejects.toThrow(/ENOENT|no such/u)
    } finally {
      await box.cleanup()
    }
  })
})

describe('splitScopeSuffix', () => {
  it('strips the latest suffix and leaves other specifiers at full scope', () => {
    expect(splitScopeSuffix('claude?latest')).toEqual({ specifier: 'claude', scope: 'latest', exchanges: undefined })
    expect(splitScopeSuffix('/tmp/sessions/rollout-1.jsonl?latest')).toEqual({
      specifier: '/tmp/sessions/rollout-1.jsonl',
      scope: 'latest',
      exchanges: undefined,
    })
    expect(splitScopeSuffix('claude')).toEqual({ specifier: 'claude', scope: 'full', exchanges: undefined })
    expect(splitScopeSuffix('claude?latestx')).toEqual({ specifier: 'claude?latestx', scope: 'full', exchanges: undefined })
    expect(splitScopeSuffix('?latest')).toEqual({ specifier: '', scope: 'latest', exchanges: undefined })
  })

  it('strips counted suffixes and leaves malformed ones as specifier text', () => {
    expect(splitScopeSuffix('claude?first-3')).toEqual({ specifier: 'claude', scope: 'first', exchanges: 3 })
    expect(splitScopeSuffix('claude?last-12')).toEqual({ specifier: 'claude', scope: 'last', exchanges: 12 })
    expect(splitScopeSuffix('.ft-codex/session.jsonl?first-1')).toEqual({
      specifier: '.ft-codex/session.jsonl',
      scope: 'first',
      exchanges: 1,
    })
    expect(splitScopeSuffix('claude?first-0')).toEqual({ specifier: 'claude?first-0', scope: 'full', exchanges: undefined })
    expect(splitScopeSuffix('claude?first-abc')).toEqual({ specifier: 'claude?first-abc', scope: 'full', exchanges: undefined })
  })
})
