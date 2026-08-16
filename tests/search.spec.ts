import { describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveConfig } from '../src/config.ts'
import { searchForeignSessions } from '../src/search.ts'

interface Sandbox {
  readonly claudeRoot: string
  readonly codexRoot: string
  readonly config: ReturnType<typeof resolveConfig>
  cleanup(): Promise<void>
}

async function sandbox(overrides: Record<string, number | string> = {}): Promise<Sandbox> {
  const root = await mkdtemp(join(tmpdir(), 'foreign-transcript-search-'))
  const claudeRoot = join(root, 'claude-projects')
  const codexRoot = join(root, 'codex-sessions')
  await mkdir(join(claudeRoot, '-work-project'), { recursive: true })
  await mkdir(join(claudeRoot, '-other-project'), { recursive: true })
  await mkdir(join(codexRoot, '2026', '08', '15'), { recursive: true })
  const config = resolveConfig({ claudeProjectsRoot: claudeRoot, codexSessionsRoot: codexRoot, ...overrides })
  return { claudeRoot, codexRoot, config, cleanup: () => rm(root, { recursive: true, force: true }) }
}

function claudeSession(fields: { summary?: string; user: string; cwd: string; sessionId: string }): string {
  const lines: string[] = []
  if (fields.summary !== undefined) {
    lines.push(JSON.stringify({ type: 'summary', summary: fields.summary, sessionId: fields.sessionId, cwd: fields.cwd }))
  }
  lines.push(JSON.stringify({
    type: 'user',
    isSidechain: false,
    sessionId: fields.sessionId,
    cwd: fields.cwd,
    timestamp: '2026-08-15T08:00:00.000Z',
    message: { role: 'user', content: fields.user },
  }))
  lines.push(JSON.stringify({
    type: 'assistant',
    sessionId: fields.sessionId,
    cwd: fields.cwd,
    message: { role: 'assistant', content: [{ type: 'text', text: 'ack' }] },
  }))
  return `${lines.join('\n')}\n`
}

function codexSession(user: string, cwd: string): string {
  return `${[
    JSON.stringify({ type: 'session_meta', payload: { id: 'c-search', cwd } }),
    JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: user }] } }),
  ].join('\n')}\n`
}

async function write(path: string, text: string, ageSeconds: number): Promise<void> {
  await writeFile(path, text, 'utf8')
  const time = new Date(Date.now() - ageSeconds * 1000)
  await utimes(path, time, time)
}

describe('searchForeignSessions', () => {
  it('ranks summary matches above first-user matches, then newest first, across projects', async () => {
    const box = await sandbox()
    try {
      await write(join(box.claudeRoot, '-work-project', 'a.jsonl'), claudeSession({ user: 'fix the parser regression', cwd: '/work/project', sessionId: 'a' }), 100)
      await write(join(box.claudeRoot, '-other-project', 'b.jsonl'), claudeSession({ summary: 'Parser hardening rollout', user: 'continue', cwd: '/other/project', sessionId: 'b' }), 500)
      await write(join(box.claudeRoot, '-work-project', 'c.jsonl'), claudeSession({ user: 'unrelated painting notes', cwd: '/work/project', sessionId: 'c' }), 50)
      const found = await searchForeignSessions({ origin: 'claude', query: 'parser', config: box.config })
      expect(found.map(candidate => candidate.topic)).toEqual(['Parser hardening rollout', 'fix the parser regression'])
      expect(found[0]).toMatchObject({ topicSource: 'summary', cwd: '/other/project', startedAt: '2026-08-15T08:00:00.000Z' })
      expect(found[1]).toMatchObject({ topicSource: 'first-user-message' })
    } finally {
      await box.cleanup()
    }
  })

  it('requires every term, respects searchResults, and returns nothing on no match', async () => {
    const box = await sandbox({ searchResults: 2 })
    try {
      for (let index = 0; index < 4; index++) {
        await write(
          join(box.claudeRoot, '-work-project', `s${index}.jsonl`),
          claudeSession({ user: `release note draft ${index}`, cwd: '/work/project', sessionId: `s${index}` }),
          index * 10,
        )
      }
      expect((await searchForeignSessions({ origin: 'claude', query: 'release note', config: box.config })).length).toBe(2)
      expect(await searchForeignSessions({ origin: 'claude', query: 'release note missing-term', config: box.config })).toEqual([])
    } finally {
      await box.cleanup()
    }
  })

  it('lists every newest session for an empty query and bounds the scan by latestScanLimit', async () => {
    const box = await sandbox({ latestScanLimit: 2 })
    try {
      await write(join(box.claudeRoot, '-work-project', 'n1.jsonl'), claudeSession({ user: 'newest task', cwd: '/w', sessionId: 'n1' }), 1)
      await write(join(box.claudeRoot, '-work-project', 'n2.jsonl'), claudeSession({ user: 'middle task', cwd: '/w', sessionId: 'n2' }), 10)
      await write(join(box.claudeRoot, '-work-project', 'n3.jsonl'), claudeSession({ user: 'oldest but matching task', cwd: '/w', sessionId: 'n3' }), 100)
      const listed = await searchForeignSessions({ origin: 'claude', query: '', config: box.config })
      expect(listed.map(candidate => candidate.topic)).toEqual(['newest task', 'middle task'])
      const matched = await searchForeignSessions({ origin: 'claude', query: 'matching', config: box.config })
      expect(matched).toEqual([])
    } finally {
      await box.cleanup()
    }
  })

  it('skips other-origin files, topic-less files, and absent roots', async () => {
    const box = await sandbox()
    try {
      await write(join(box.claudeRoot, '-work-project', 'codex-shaped.jsonl'), codexSession('claude-root codex content', '/work/project'), 1)
      await write(join(box.claudeRoot, '-work-project', 'headless.jsonl'), `${JSON.stringify({ type: 'attachment', attachment: { type: 'hook_success' } })}\n`, 2)
      expect(await searchForeignSessions({ origin: 'claude', query: 'codex', config: box.config })).toEqual([])
      expect(await searchForeignSessions({ origin: 'claude', query: 'anything', config: box.config })).toEqual([])
      const absent = resolveConfig({ claudeProjectsRoot: join(box.claudeRoot, 'absent'), codexSessionsRoot: box.codexRoot })
      expect(await searchForeignSessions({ origin: 'claude', query: 'x', config: absent })).toEqual([])
    } finally {
      await box.cleanup()
    }
  })

  it('searches codex rollout trees by first user message and skips machine-only content', async () => {
    const box = await sandbox()
    try {
      const day = join(box.codexRoot, '2026', '08', '15')
      await write(join(day, 'rollout-a.jsonl'), codexSession('migrate the config loader', '/work/project'), 10)
      await write(join(day, 'rollout-b.jsonl'), `${[
        JSON.stringify({ type: 'session_meta', payload: { id: 'env-only', cwd: '/work/project' } }),
        JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>\nunix\n</environment_context>' }] } }),
      ].join('\n')}\n`, 5)
      const found = await searchForeignSessions({ origin: 'codex', query: 'config loader', config: box.config })
      expect(found.map(candidate => candidate.topic)).toEqual(['migrate the config loader'])
      expect(found[0]).toMatchObject({ origin: 'codex', topicSource: 'first-user-message', cwd: '/work/project' })
    } finally {
      await box.cleanup()
    }
  })

  it('propagates cancellation before reading the next candidate', async () => {
    const box = await sandbox()
    try {
      await write(join(box.claudeRoot, '-work-project', 'a.jsonl'), claudeSession({ user: 'cancel me', cwd: '/w', sessionId: 'a' }), 1)
      const controller = new AbortController()
      controller.abort()
      await expect(searchForeignSessions({ origin: 'claude', query: 'cancel', config: box.config, signal: controller.signal }))
        .rejects.toThrow(/cancelled/u)
    } finally {
      await box.cleanup()
    }
  })
})

describe('Codex bootstrap depth', () => {
  it('reads past an opening instruction block larger than the legacy head cap', async () => {
    const box = await sandbox()
    try {
      const meta = JSON.stringify({
        type: 'session_meta',
        payload: { id: 'c-deep', cwd: '/work/project', instructions: 'x'.repeat(48_000) },
      })
      const user = JSON.stringify({
        type: 'response_item',
        payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'explain the merged CHI plan' }] },
      })
      const path = join(box.codexRoot, '2026', '08', '15', 'rollout-deep.jsonl')
      await write(path, `${meta}\n${user}\n`, 0)
      const found = await searchForeignSessions({ origin: 'codex', query: 'merged', config: box.config, signal: undefined })
      expect(found).toHaveLength(1)
      expect(found[0]?.topic).toContain('merged CHI plan')
    } finally {
      await box.cleanup()
    }
  })

  it('still finds nothing when the head cap cannot reach the first user message', async () => {
    const box = await sandbox({ searchHeadBytes: 32_768 })
    try {
      const meta = JSON.stringify({
        type: 'session_meta',
        payload: { id: 'c-deep', cwd: '/work/project', instructions: 'x'.repeat(48_000) },
      })
      const user = JSON.stringify({
        type: 'response_item',
        payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'explain the merged CHI plan' }] },
      })
      const path = join(box.codexRoot, '2026', '08', '15', 'rollout-deep.jsonl')
      await write(path, `${meta}\n${user}\n`, 0)
      expect(await searchForeignSessions({ origin: 'codex', query: 'merged', config: box.config, signal: undefined })).toHaveLength(0)
    } finally {
      await box.cleanup()
    }
  })
})
