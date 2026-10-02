/**
 * Job runner behaviour.
 *
 * These use a fake store rather than Supabase, because the properties that
 * matter here are local: an unknown job kind is not retried forever, a missing
 * router is a permanent failure rather than a loop, success is recorded only
 * when the handler succeeded, and a handler that exceeds its budget is stopped.
 *
 * The row-locking guarantee itself (`for update skip locked`) lives in Postgres
 * and is exercised by the migration, not from here.
 */
import { describe, expect, it, vi } from 'vitest'
import { JobRunner, shouldRetry, withTimeout, type JobStore, type RouterJob } from './runner.ts'
import { RouterConnectError } from './session.ts'
import type { RouterTarget } from './router-client.ts'

const target: RouterTarget = {
  nodeId: 'n1', ispId: 'i1', name: 'RB941', host: '10.0.0.1',
  apiPort: 8728, apiSslPort: 8729, restPort: 8080,
  username: 'u', password: 'p', timeoutMs: 5000,
}

function job(over: Partial<RouterJob> = {}): RouterJob {
  return {
    id: 'job-1', isp_id: 'i1', node_id: 'n1', kind: 'heartbeat',
    payload: {}, status: 'pending', attempt_count: 1, max_attempts: 5,
    timeout_secs: 5,
    ...over,
  }
}

interface Recorded {
  completed: Array<{ id: string; result: Record<string, unknown>; method: string | null }>
  failed: Array<{ id: string; error: string; retryable: boolean }>
}

const emptyRecorded = (): Recorded => ({ completed: [], failed: [] })

function fakeStore(jobs: RouterJob[], recorded: Recorded, targets: RouterTarget[] = [target]): JobStore {
  let queue = [...jobs]
  return {
    async claim() { const out = queue; queue = []; return out },
    async complete(id, result, method) { recorded.completed.push({ id, result, method }) },
    async fail(id, error, _result, _method, _duration, retryable) {
      recorded.failed.push({ id, error, retryable })
    },
    async targets() { return targets },
  }
}

const client = { openSessions: 0, run: vi.fn(), closeAll: vi.fn() } as never

describe('JobRunner', () => {
  it('records a success only when the handler succeeded', async () => {
    const recorded = emptyRecorded()
    const runner = new JobRunner({
      workerName: 'w1',
      store: fakeStore([job()], recorded),
      client,
      handlers: { heartbeat: async () => ({ ok: true, durationMs: 5, method: 'api_ssl' }) },
    })
    await runner.pass()
    expect(recorded.completed).toHaveLength(1)
    expect(recorded.completed[0].method).toBe('api_ssl')
    expect(recorded.failed).toHaveLength(0)
  })

  it('records a failure when the handler reports one', async () => {
    const recorded = emptyRecorded()
    const runner = new JobRunner({
      workerName: 'w1',
      store: fakeStore([job()], recorded),
      client,
      handlers: {
        heartbeat: async () => ({ ok: false, durationMs: 3, error: 'router refused', retryable: true }),
      },
    })
    await runner.pass()
    expect(recorded.completed).toHaveLength(0)
    expect(recorded.failed[0].error).toBe('router refused')
    expect(recorded.failed[0].retryable).toBe(true)
  })

  it('does not retry an unknown job kind forever', async () => {
    const recorded = emptyRecorded()
    const runner = new JobRunner({
      workerName: 'w1',
      store: fakeStore([job({ kind: 'not_a_real_kind' })], recorded),
      client,
      handlers: {},
    })
    await runner.pass()
    expect(recorded.failed).toHaveLength(1)
    // A platform bug, not a router problem: retrying cannot add a missing handler.
    expect(recorded.failed[0].retryable).toBe(false)
  })

  it('fails a job whose router has no credentials, without retrying', async () => {
    const recorded = emptyRecorded()
    const runner = new JobRunner({
      workerName: 'w1',
      store: fakeStore([job({ node_id: 'unknown-router' })], recorded, []),
      client,
      handlers: { heartbeat: async () => ({ ok: true, durationMs: 1 }) },
    })
    await runner.pass()
    expect(recorded.failed[0].retryable).toBe(false)
    expect(recorded.failed[0].error).toMatch(/credentials/i)
  })

  it('stops a handler that exceeds its time budget', async () => {
    const recorded = emptyRecorded()
    const runner = new JobRunner({
      workerName: 'w1',
      store: fakeStore([job({ timeout_secs: 0 })], recorded),
      client,
      // Never resolves: exactly the hang this guard exists for.
      handlers: { heartbeat: () => new Promise(() => {}) },
    })
    await runner.pass()
    expect(recorded.completed).toHaveLength(0)
    expect(recorded.failed[0].error).toMatch(/budget/)
  })

  it('does not execute a job for a router outside its own target set', async () => {
    const recorded = emptyRecorded()
    const handler = vi.fn(async () => ({ ok: true, durationMs: 1 }))
    const runner = new JobRunner({
      workerName: 'w1',
      store: fakeStore([job({ node_id: 'someone-elses-router' })], recorded),
      client,
      handlers: { heartbeat: handler },
    })
    await runner.pass()
    expect(handler).not.toHaveBeenCalled()
  })

  it('runs the jobs it claimed in order', async () => {
    const seen: string[] = []
    const recorded = emptyRecorded()
    const runner = new JobRunner({
      workerName: 'w1',
      store: fakeStore([job({ id: 'a' }), job({ id: 'b' })], recorded),
      client,
      handlers: { heartbeat: async (j) => { seen.push(j.id); return { ok: true, durationMs: 1 } } },
    })
    await runner.pass()
    expect(seen).toEqual(['a', 'b'])
  })

  it('survives a storage failure without dying', async () => {
    const runner = new JobRunner({
      workerName: 'w1',
      store: {
        claim: async () => { throw new Error('supabase unreachable') },
        complete: async () => {}, fail: async () => {},
        targets: async () => [target],
      },
      client,
      handlers: {},
      log: () => {},
    })
    await expect(runner.pass()).resolves.toBeUndefined()
  })
})
describe('shouldRetry', () => {
  it('retries a refused connection, because the router may come back', () => {
    expect(shouldRetry(new RouterConnectError('connection refused', 'api_ssl'))).toBe(true)
  })

  it('does not retry a wrong password', () => {
    expect(shouldRetry(new Error('cannot log in'))).toBe(false)
    expect(shouldRetry(new Error('invalid user name or password (6)'))).toBe(false)
  })

  it('does not retry a router-side refusal', () => {
    expect(shouldRetry(new RouterConnectError('not enough permissions', null, undefined, false)))
      .toBe(false)
  })

  it('retries an unexpected error, since it may be transient', () => {
    expect(shouldRetry(new Error('socket hang up'))).toBe(true)
  })
})

describe('withTimeout', () => {
  it('resolves when the work finishes in time', async () => {
    await expect(withTimeout(Promise.resolve('ok'), 1000, 'too slow')).resolves.toBe('ok')
  })

  it('rejects with the given message when it does not', async () => {
    await expect(withTimeout(new Promise(() => {}), 10, 'budget exceeded'))
      .rejects.toThrow('budget exceeded')
  })

  it('propagates the original rejection rather than masking it', async () => {
    await expect(withTimeout(Promise.reject(new Error('router said no')), 1000, 'x'))
      .rejects.toThrow('router said no')
  })
})