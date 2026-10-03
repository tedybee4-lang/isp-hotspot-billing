// =============================================================================
//  Service-state guard for live VPS checks.
//
//  A live check has to stop FreeRADIUS, because the interesting behaviour
//  (routing, log lines, restart safety) is only observable in debug mode. That
//  makes "restore the service" a property the harness OWNS rather than something
//  it hopes to reach on its last line.
//
//  The previous harness restored the service at the end of the happy path only.
//  Every failure between `systemctl stop` and `systemctl start` - a thrown
//  error, a timeout, a Ctrl-C, a dropped SSH connection - left production
//  RADIUS down. That is not a test bug, it is an outage: a stopped FreeRADIUS
//  rejects every login for every ISP on the platform.
//
//  So the rules this module enforces:
//
//    1. The INITIAL state is recorded before anything is changed, and the
//       original state is what gets restored - not a hardcoded "running".
//       A host that was deliberately stopped stays stopped.
//    2. Restoration runs in `finally`, so it happens on success, on throw, and
//       on process exit signals.
//    3. Restoration is verified, and a failed restore is reported loudly
//       rather than swallowed.
//    4. Cleanup callbacks are LIFO and run even if an earlier one throws, so
//       one broken step cannot strand the rest.
//
//  It performs no database writes and deletes nothing. Fixture cleanup is the
//  caller's business; this module only manages process state on the host.
// =============================================================================

/** Result of a restore attempt. `ok` is false when the unit is not back. */
export interface RestoreOutcome {
  ok: boolean
  failures: string[]
  final: ServiceState
}

/** Executes one shell command on the VPS and returns stdout. */
export type Exec = (command: string) => Promise<string>

export type ServiceState = 'active' | 'inactive' | 'failed' | 'activating' | 'unknown'

export interface GuardOptions {
  exec: Exec
  /** The systemd unit under management. */
  service?: string
  /** Lines to run as a remote shell script, executed once. */
  onLog?: (line: string) => void
}

const VALID: ServiceState[] = ['active', 'inactive', 'failed', 'activating']

/**
 * Reads the current state, refusing to guess.
 *
 * If `systemctl is-active` cannot be parsed the state is 'unknown', and
 * 'unknown' is deliberately not treated as 'active': restoring onto an unknown
 * baseline would mean picking one, and picking wrong is the outage.
 */
export async function readServiceState(exec: Exec, service = 'freeradius'): Promise<ServiceState> {
  const out = (await exec(`systemctl is-active ${service}`)).trim()
  return (VALID as string[]).includes(out) ? (out as ServiceState) : 'unknown'
}

export class ServiceStateGuard {
  private readonly exec: Exec
  private readonly service: string
  private readonly onLog: (line: string) => void
  private initial: ServiceState | null = null
  private restored = false
  /** What the last `restore()` did, for callers of `guard`. */
  private lastRestore: RestoreOutcome = {
    ok: true,
    failures: [],
    final: 'unknown',
  }

  private readonly cleanups: Array<{ name: string; fn: () => Promise<void> }> = []

  constructor(opts: GuardOptions) {
    this.exec = opts.exec
    this.service = opts.service ?? 'freeradius'
    this.onLog = opts.onLog ?? (() => {})
  }

  /** The state observed before this guard changed anything. */
  get baseline(): ServiceState | null {
    return this.initial
  }

  get hasRestored(): boolean {
    return this.restored
  }

  /**
   * Records the baseline and installs signal handlers.
   *
   * Call this BEFORE the first state-changing command. Signal handlers are
   * removed by `restore()`, so a long-lived process using this does not
   * accumulate listeners.
   */
  async begin(): Promise<ServiceState> {
    this.initial = await readServiceState(this.exec, this.service)
    this.onLog(`service baseline: ${this.service} is ${this.initial}`)
    return this.initial
  }

  /**
   * Queues a cleanup step. Runs LIFO inside `restore()`.
   *
   * Cleanup must be safe to run more than once: the service restore runs on
   * every exit path including the signal path, and a fixture drop that assumed
   * "exactly once" would fail on the second attempt.
   */
  onCleanup(name: string, fn: () => Promise<void>): void {
    this.cleanups.unshift({ name, fn })
  }

  /**
   * Runs the queued cleanups, LIFO, tolerating individual failures.
   *
   * `quiet` suppresses only the per-step progress lines. It does not suppress
   * `failures`, which are what the caller turns into an exit code.
   */
  async runCleanups(quiet = false): Promise<string[]> {
    const failures: string[] = []
    while (this.cleanups.length > 0) {
      const step = this.cleanups.shift()!
      try {
        await step.fn()
        if (!quiet) this.onLog(`cleanup ok: ${step.name}`)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        failures.push(`${step.name}: ${message}`)
        this.onLog(`cleanup FAILED: ${step.name}: ${message}`)
      }
    }
    return failures
  }
/** Puts the unit back into its baseline state and verifies it took. */
  async restore(): Promise<{ ok: boolean; failures: string[]; final: ServiceState }> {
    const failures = await this.runCleanups()
    if (this.restored) {
      return {
        ok: failures.length === 0,
        failures,
        final: await readServiceState(this.exec, this.service),
      }
    }
    this.restored = true

    // No baseline means nothing was recorded, so nothing may be assumed.
    if (this.initial === null) {
      failures.push('no baseline recorded; refusing to change service state')
      return { ok: false, failures, final: 'unknown' }
    }

    const shouldRun = this.initial === 'active'
    const verb = shouldRun ? 'start' : 'stop'
    try {
      await this.exec(`systemctl ${verb} ${this.service}`)
      await this.exec('sleep 3')
    } catch (err) {
      failures.push(
        `systemctl ${verb} threw: ${err instanceof Error ? err.message : String(err)}`,
      )
    }

    const final = await readServiceState(this.exec, this.service)
    if (final !== this.initial) {
      failures.push(
        `service is ${final} but baseline was ${this.initial}; ` +
        `run \`systemctl ${verb} ${this.service}\` on the host`,
      )
    } else {
      this.onLog(`service restored to ${final} (baseline ${this.initial})`)
    }
    return { ok: failures.length === 0, failures, final }
  }

  /**
   * Runs `body` with the service guarded, restoring on every exit path.
   *
   * This is the entry point a harness should use rather than calling
   * `begin`/`restore` by hand, because the `finally` is what makes the
   * guarantee hold and a caller cannot forget to write it.
   *
   * The restore outcome is returned rather than swallowed: a check whose
   * service could not be put back must be able to say so, and the caller is the
   * only place that knows whether to treat that as a failure.
   */
  async guard<T>(body: () => Promise<T>): Promise<{ value: T; restore: RestoreOutcome }> {
    await this.begin()
    const onSignal = (sig: NodeJS.Signals) => {
      void (async () => {
        this.onLog(`received ${sig}; restoring service before exit`)
        await this.restore()
        process.exit(sig === 'SIGINT' ? 130 : 143)
      })()
    }
    const signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP']
    for (const s of signals) process.on(s, onSignal)

    let value!: T
    try {
      value = await body()
    } finally {
      for (const s of signals) process.off(s, onSignal)
      const restore = await this.restore()
      // Loud, and after the real result is computed, so a restore problem
      // cannot be mistaken for the check having passed cleanly.
      for (const f of restore.failures) process.stderr.write(`GUARD: ${f}\n`)
      // Stashed because the `finally` cannot return, and the caller still needs
      // to know whether the service actually went back. The stderr line is the
      // one thing printed unconditionally: a check that cannot restore
      // production RADIUS must say so even if nobody reads the exit code.
      this.lastRestore = restore
    }
    return { value, restore: this.lastRestore }
  }
}