import { describe, expect, it } from 'vitest'
import {
  readServiceState,
  ServiceStateGuard,
  type Exec,
} from '../../scripts/live/service-state'

/**
 * These tests are about the one property that matters: a live check must never
 * leave production RADIUS stopped.
 *
 * The failure this guards against already happened. A harness that restored the
 * service only on its last line left FreeRADIUS down for ~50 minutes after an
 * exception between `systemctl stop` and `systemctl start`, which rejects every
 * login for every tenant on the platform. So the cases below are written around
 * the ways a check can die, not around the way it usually succeeds.
 */

/** A fake host whose service state is a mutable string. */
function fakeHost(initial: string) {
  const commands: string[] = []
  let state = initial
  const exec: Exec = async (cmd: string) => {
    commands.push(cmd)
    if (cmd.startsWith('systemctl is-active')) return `${state}\n`
    if (cmd.startsWith('systemctl start')) state = 'active'
    if (cmd.startsWith('systemctl stop')) state = 'inactive'
    return ''
  }
  return {
    exec,
    commands,
    get state() { return state },
  }
}

describe('live harness service-state guard', () => {
  it('restores an active service after the body throws', async () => {
    const host = fakeHost('active')
    const guard = new ServiceStateGuard({ exec: host.exec })

    await expect(guard.guard(async () => {
      await host.exec('systemctl stop freeradius')
      expect(host.state).toBe('inactive')
      throw new Error('packet send failed')
    })).rejects.toThrow('packet send failed')

    expect(host.state).toBe('active')
    expect(guard.baseline).toBe('active')
    expect(guard.hasRestored).toBe(true)
  })

  it('restores after a rejected promise, not only after a throw', async () => {
    const host = fakeHost('active')
    const guard = new ServiceStateGuard({ exec: host.exec })

    await expect(guard.guard(async () => {
      await host.exec('systemctl stop freeradius')
      return Promise.reject(new Error('timeout waiting for Ready to process'))
    })).rejects.toThrow()

    expect(host.state).toBe('active')
  })

  it('restores the ORIGINAL state rather than assuming active', async () => {
    // A host deliberately stopped for maintenance must stay stopped; forcing it
    // live would start a service an operator had taken down on purpose. The
    // body deliberately leaves the service running, to prove the guard puts it
    // BACK to the baseline rather than agreeing with whatever it finds.
    const host = fakeHost('inactive')
    const guard = new ServiceStateGuard({ exec: host.exec })

    await guard.guard(async () => {
      await host.exec('systemctl start freeradius')
      expect(host.state).toBe('active')
    })

    expect(host.state).toBe('inactive')
    expect(host.commands).toContain('systemctl stop freeradius')
  })

  it('reports the failure when the service cannot be put back', async () => {
    const commands: string[] = []
    let state = 'active'
    // Reads active while the baseline is taken and while the body runs, then
    // keeps reporting inactive after a `start` that quietly did not take. The
    // restore did not work, and that has to be visible rather than assumed.
    const brokenExec: Exec = async (cmd) => {
      commands.push(cmd)
      if (cmd.startsWith('systemctl is-active')) return `${state}\n`
      if (cmd.startsWith('systemctl start')) {
        state = 'inactive'
        return ''
      }
      if (cmd.startsWith('systemctl stop')) state = 'inactive'
      return ''
    }
    const guard = new ServiceStateGuard({
      exec: brokenExec,
      // The guard reports problems loudly by design; this case provokes one on
      // purpose, so the noise is captured rather than scrolling past.
      onLog: () => {},
    })

    const { value, restore } = await guard.guard(async () => 'done')

    expect(value).toBe('done')
    expect(guard.hasRestored).toBe(true)
    expect(commands).toContain('systemctl start freeradius')
    // The baseline was active and it ended inactive, so restore must not be ok.
    expect(restore.ok).toBe(false)
    expect(restore.failures.join(' ')).toMatch(/inactive but baseline was active/)
  })
it('runs cleanups LIFO and still runs them when one throws', async () => {
    const host = fakeHost('active')
    const guard = new ServiceStateGuard({ exec: host.exec, onLog: () => {} })
    const order: string[] = []

    await guard.guard(async () => {
      guard.onCleanup('first', async () => { order.push('first') })
      guard.onCleanup('second', async () => {
        order.push('second')
        throw new Error('cleanup blew up')
      })
      guard.onCleanup('third', async () => { order.push('third') })
    })

    // Reverse registration order, and the failure did not skip the earlier one.
    expect(order).toEqual(['third', 'second', 'first'])
    expect(host.state).toBe('active')
  })

  it('runs cleanups before restoring the service', async () => {
    const host = fakeHost('active')
    const guard = new ServiceStateGuard({ exec: host.exec })
    const observed: string[] = []

    await guard.guard(async () => {
      guard.onCleanup('drop-fixtures', async () => {
        // Whatever a cleanup needs from the service must still be up here.
        observed.push(host.state)
      })
    })

    expect(observed).toEqual(['active'])
  })

  it('refuses to change state when no baseline was recorded', async () => {
    const host = fakeHost('active')
    const guard = new ServiceStateGuard({ exec: host.exec })

    // No begin(): nothing may be assumed about the original state.
    const outcome = await guard.restore()

    expect(outcome.ok).toBe(false)
    expect(outcome.failures.join(' ')).toMatch(/no baseline/i)
    expect(host.state).toBe('active')
  })

  it('treats an unparseable state as unknown rather than active', async () => {
    const exec: Exec = async (cmd) =>
      cmd.startsWith('systemctl is-active') ? 'weird-output\n' : ''
    expect(await readServiceState(exec)).toBe('unknown')
  })

  it('is idempotent, because signals and finally can both fire', async () => {
    const host = fakeHost('active')
    const guard = new ServiceStateGuard({ exec: host.exec })

    await guard.guard(async () => {})
    const first = host.commands.filter((c) => c === 'systemctl start freeradius').length
    // A second restore must not stack another restart.
    await guard.restore()
    const second = host.commands.filter((c) => c === 'systemctl start freeradius').length

    expect(first).toBe(1)
    expect(second).toBe(1)
  })

  it('removes its signal handlers so a long-lived process does not leak them', async () => {
    const before = process.listenerCount('SIGINT')
    const host = fakeHost('active')
    const guard = new ServiceStateGuard({ exec: host.exec })
    await guard.guard(async () => {})
    expect(process.listenerCount('SIGINT')).toBe(before)
  })
})
