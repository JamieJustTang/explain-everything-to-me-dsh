import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import * as ForeignTranscriptInvariant from '../src/invariant.ts'

async function setup(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(InvariantRegistry, { enabled: true })
  await ctx.plugin(ForeignTranscriptInvariant)
  return ctx
}

describe('foreign-transcript invariant companion', () => {
  it('registers the package-owned no-op installer', async () => {
    const register = vi.fn().mockReturnValue(() => {})
    const ctx = { invariants: { register } } as never as Context
    await ForeignTranscriptInvariant.apply(ctx)
    expect(register).toHaveBeenCalledWith('@deepseek-ai/dsh-foreign-transcript', expect.any(Function))
  })

  it('accepts every session event; the import leaves no relation to check', async () => {
    const ctx = await setup()
    expect(() => {
      const source = {
        kind: 'foreign-transcript',
        form: 'recall',
        version: 1,
        origin: 'claude',
        path: '/sessions/a.jsonl',
        label: 'a.jsonl',
        totalItems: 2,
        omittedBytes: 0,
      }
      ctx.emit('session/event', {} as Session, {
        type: 'user/message',
        seq: 0,
        time: 0,
        data: { content: [{ type: 'text', text: 'x' }], source },
      } as SessionEvent)
      ctx.emit('session/event', {} as Session, {
        type: 'turn/start',
        seq: 1,
        time: 0,
        data: { turn: 1 },
      } as SessionEvent)
      ctx.emit('tools/change')
    }).not.toThrow()
  })
})
