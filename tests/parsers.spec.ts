import { describe, expect, it } from 'vitest'
import { ellipsize } from '../src/brief.ts'
import { parseClaudeCodeTranscript } from '../src/claude-code.ts'
import { parseCodexTranscript } from '../src/codex.ts'
import { ForeignTranscriptError } from '../src/config.ts'

function lines(...records: unknown[]): string {
  return `${records.map(record => JSON.stringify(record)).join('\n')}\n`
}

describe('ellipsize', () => {
  it('keeps short text and ellipsizes text past the cap', () => {
    expect(ellipsize('short', 10)).toBe('short')
    expect(ellipsize('0123456789abcdef', 11)).toBe('0123456789…')
  })
})

describe('parseClaudeCodeTranscript', () => {
  const META = {
    cwd: '/work/project',
    gitBranch: 'main',
    sessionId: 's-claude-1',
    timestamp: '2026-08-15T08:00:00.000Z',
  }

  it('parses dialogue, tool calls, and summaries while skipping housekeeping rows', () => {
    const transcript = parseClaudeCodeTranscript(lines(
      { type: 'queue-operation', operation: 'enqueue', ...META },
      { type: 'summary', summary: 'Earlier compacted work', ...META },
      {
        type: 'user',
        isSidechain: false,
        message: { role: 'user', content: 'Fix the failing build' },
        ...META,
      },
      {
        type: 'user',
        isSidechain: false,
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'output' }] },
        ...META,
      },
      {
        type: 'assistant',
        isSidechain: false,
        message: {
          role: 'assistant',
          model: 'claude-opus-5',
          content: [
            { type: 'text', text: 'Reading the config first.' },
            { type: 'tool_use', name: 'Read', input: { file_path: '/work/project/src/index.ts' } },
            { type: 'tool_use', name: 'RunLong', input: { command: 'x'.repeat(200) } },
            { type: 'text', text: '' },
          ],
        },
        ...META,
      },
      { type: 'attachment', attachment: { type: 'hook_success' }, ...META },
      { type: 'user', isSidechain: true, message: { role: 'user', content: 'sidechain prompt' }, ...META },
      { type: 'assistant', isSidechain: true, message: { role: 'assistant', content: [{ type: 'text', text: 'sidechain reply' }] }, ...META },
      { type: 'user', isMeta: true, message: { role: 'user', content: 'meta notice' }, ...META },
    ), 20)
    expect(transcript.origin).toBe('claude')
    expect(transcript.sessionId).toBe('s-claude-1')
    expect(transcript.cwd).toBe('/work/project')
    expect(transcript.gitBranch).toBe('main')
    expect(transcript.startedAt).toBe('2026-08-15T08:00:00.000Z')
    expect(transcript.model).toBe('claude-opus-5')
    expect(transcript.items).toEqual([
      { kind: 'summary', text: 'Earlier compacted work' },
      { kind: 'user', text: 'Fix the failing build' },
      { kind: 'assistant', text: 'Reading the config first.' },
      { kind: 'tool-call', name: 'Read', brief: '{"file_path":"/work…' },
      { kind: 'tool-call', name: 'RunLong', brief: '{"command":"xxxxxxx…' },
    ])
  })

  it('accepts array user content, skips a tool_use without a name, and skips a summary row without text', () => {
    const transcript = parseClaudeCodeTranscript(lines(
      { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'part one' }, { type: 'text', text: 'part two' }] }, ...META },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', input: { a: 1 } }] } },
      { type: 'summary' },
    ), 100)
    expect(transcript.items).toEqual([{ kind: 'user', text: 'part one\npart two' }])
  })

  it('skips malformed lines and empty lines, and serializes a missing tool input as null', () => {
    const text = `${JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Probe', input: undefined }] }, ...META })}\n`
      + 'not json at all\n'
      + '\n'
      + '42\n'
      + `${JSON.stringify({ type: 'unknown-future-type', ...META })}\n`
    const transcript = parseClaudeCodeTranscript(text, 50)
    expect(transcript.items).toEqual([{ kind: 'tool-call', name: 'Probe', brief: 'null' }])
  })

  it('recognizes a housekeeping-only log without producing items', () => {
    const transcript = parseClaudeCodeTranscript(lines({ type: 'attachment', attachment: { type: 'hook_success' } }), 50)
    expect(transcript.items).toEqual([])
  })

  it('throws on a file with no recognizable records', () => {
    expect(() => parseClaudeCodeTranscript(lines({ hello: 'world' }), 50))
      .toThrow(ForeignTranscriptError)
    expect(() => parseClaudeCodeTranscript('', 50)).toThrow(/no recognizable Claude Code session records/u)
  })
})

describe('parseCodexTranscript', () => {
  const META = { type: 'session_meta', payload: { id: 's-codex-1', cwd: '/work/project', timestamp: '2026-08-15T09:00:00.000Z', git: { branch: 'trunk' } } }

  function responseItem(payload: unknown): unknown {
    return { type: 'response_item', payload }
  }

  it('parses dialogue, tool calls, and compaction summaries while skipping duplicates and machine context', () => {
    const transcript = parseCodexTranscript(lines(
      META,
      { type: 'turn_context', payload: { model: 'gpt-5.6' } },
      responseItem({ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Continue the migration' }] }),
      responseItem({ type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>\nunix\n</environment_context>' }] }),
      responseItem({ type: 'message', role: 'user', content: [{ type: 'input_text', text: '<user_instructions>be terse</user_instructions>' }] }),
      responseItem({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Picking up at the schema step.' }, { type: 'output_text', text: 'Second paragraph.' }] }),
      responseItem({ type: 'reasoning', payload: { summary: [] } }),
      responseItem({ type: 'function_call', name: 'shell', arguments: 'pnpm test' }),
      responseItem({ type: 'function_call', arguments: 42 }),
      responseItem({ type: 'function_call_output', output: 'ok' }),
      responseItem({ type: 'local_shell_call', action: { type: 'exec', command: ['ls', '-la'] } }),
      responseItem({ type: 'local_shell_call', action: {} }),
      responseItem({ type: 'custom_tool_call', tool_name: 'apply_patch', input: 'patch body' }),
      responseItem({ type: 'custom_tool_call', name: 'fallback', input: 7 }),
      responseItem({ type: 'web_search_call', action: { query: 'node 24 release notes' } }),
      { type: 'event_msg', payload: { type: 'user_message', message: 'Continue the migration' } },
      { type: 'compacted', payload: { message: 'Summary of dropped turns' } },
    ), 50)
    expect(transcript.origin).toBe('codex')
    expect(transcript.sessionId).toBe('s-codex-1')
    expect(transcript.cwd).toBe('/work/project')
    expect(transcript.gitBranch).toBe('trunk')
    expect(transcript.model).toBe('gpt-5.6')
    expect(transcript.items).toEqual([
      { kind: 'user', text: 'Continue the migration' },
      { kind: 'assistant', text: 'Picking up at the schema step.\nSecond paragraph.' },
      { kind: 'tool-call', name: 'shell', brief: 'pnpm test' },
      { kind: 'tool-call', name: 'function', brief: '' },
      { kind: 'tool-call', name: 'shell', brief: 'ls -la' },
      { kind: 'tool-call', name: 'shell', brief: '' },
      { kind: 'tool-call', name: 'apply_patch', brief: 'patch body' },
      { kind: 'tool-call', name: 'fallback', brief: '' },
      { kind: 'tool-call', name: 'web_search_call', brief: '' },
      { kind: 'summary', text: 'Summary of dropped turns' },
    ])
  })

  it('falls back to session_id, skips unknown roles and bare text blocks, and tolerates malformed rows', () => {
    const transcript = parseCodexTranscript(lines(
      { type: 'session_meta', payload: { session_id: 's-codex-2' } },
      responseItem({ type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'instructions' }] }),
      responseItem({ type: 'message', role: 'user', content: [{ type: 'text', text: 'plain text block' }] }),
      responseItem({ type: 'message', role: 'user', content: 'not-an-array' }),
      responseItem({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '' }] }),
      'torn tail without newline terminator',
      { type: 'compacted', payload: { message: 42 } },
      { type: 'turn_context', payload: {} },
    ), 50)
    expect(transcript.sessionId).toBe('s-codex-2')
    expect(transcript.items).toEqual([{ kind: 'user', text: 'plain text block' }])
  })

  it('throws on a file with no recognizable records', () => {
    expect(() => parseCodexTranscript(lines({ hello: 'world' }), 50))
      .toThrow(/no recognizable Codex session records/u)
  })
})
