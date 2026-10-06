/**
 * VPS deployment artefacts.
 *
 * The systemd unit, install script and FreeRADIUS configuration are what turn
 * the worker from "code that runs" into "a service that survives a reboot". They
 * are also where a security mistake would be invisible in review, because
 * nothing executes them until someone installs onto a real host.
 *
 * These tests read the shipped files and assert the properties that matter:
 *   * no secret is committed anywhere
 *   * RADIUS is never opened to the world
 *   * the worker runs unprivileged with credentials in a file, not on argv
 *   * the RADIUS SQL the server executes matches the real schema
 *
 * Nothing here runs FreeRADIUS or touches a VPS. These are assertions about the
 * shipped configuration, not about a running system.
 */
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = join(import.meta.dirname, '..', '..')
const read = (...parts: string[]) => readFileSync(join(ROOT, ...parts), 'utf8')

/**
 * The file with its comments removed.
 *
 * These configuration files carry a lot of prose explaining WHY a value is what
 * it is, and several of those explanations quote the broken value verbatim:
 * `driver = "postgresql"` appears in a comment precisely because it does not
 * work. Asserting against the raw text therefore "finds" the bug it is meant to
 * prove is absent, which is how a configuration file ends up shipped carrying
 * the exact line its own comments warn against.
 */
const code = (...parts: string[]) =>
  read(...parts)
    .split('\n')
    .filter((l) => !l.trim().startsWith('#'))
    .join('\n')
const has = (...parts: string[]) => existsSync(join(ROOT, ...parts))

/**
 * Reads a harness file from scripts/.
 *
 * ROOT is the repository root, so `join(ROOT, '..', ...)` would escape it; the
 * segments are joined against ROOT directly instead.
 */
const harness = (...parts: string[]) => code(...parts)
describe('router provisioning claim response', () => {
  it('passes the detected architecture into discovery generation', () => {
    const provision = code('supabase', 'functions', 'router-provision', 'index.ts')
    expect(provision).toMatch(
      /buildDiscoveryTail\(\s*sessionId,\s*tag,\s*profile,\s*detected\.version,\s*detected\.architecture,\s*\)/,
    )
    expect(provision).toMatch(
      /async function buildDiscoveryTail\([\s\S]*?version: string \| null,\s*architecture: string \| null,/,
    )
    expect(provision).toMatch(/architecture,\s*tag,/)
  })
})

describe('live VPS checks cannot strand the RADIUS service', () => {
  it('ships the service-state guard the live checks depend on', () => {
    expect(has('scripts', 'live', 'service-state.ts')).toBe(true)
  })

  it('restores on every exit path, not only the happy one', () => {
    const guard = harness('scripts', 'live', 'service-state.ts')
    // A `try/finally` is the whole point: without it any throw between the stop
    // and the start is a platform-wide outage.
    expect(guard).toMatch(/try\s*\{/)
    expect(guard).toMatch(/finally\s*\{/)
    // The restore is inside the finally, not merely somewhere in the file.
    const finallyIdx = guard.indexOf('} finally {')
    const after = guard.slice(finallyIdx)
    expect(after).toMatch(/await this\.restore\(\)/)
  })

  it('records the initial state and restores that, not a hardcoded active', () => {
    const guard = harness('scripts', 'live', 'service-state.ts')
    // Reading the baseline is what makes the restore reversible.
    expect(guard).toMatch(/this\.initial\s*=\s*await readServiceState/)
    // A host that was deliberately stopped must stay stopped.
    expect(guard).toMatch(/shouldRun\s*=\s*this\.initial\s*===\s*'active'/)
    expect(guard).toMatch(/shouldRun\s*\?\s*'start'\s*:\s*'stop'/)
    // And "unknown" is never treated as "active", because that is the outage.
    expect(guard).toMatch(/includes\(out\)/)
    expect(guard).not.toMatch(/initial\s*===\s*'unknown'.*'start'/)
  })

  it('handles signals, so Ctrl-C cannot leave the service down', () => {
    const guard = harness('scripts', 'live', 'service-state.ts')
    for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
      expect(guard).toContain(sig)
    }
    expect(guard).toMatch(/process\.exit\(/)
  })

  it('runs registered cleanups, and keeps going when one fails', () => {
    const guard = harness('scripts', 'live', 'service-state.ts')
    expect(guard).toMatch(/onCleanup\(/)
    // A cleanup that throws must not skip the service restore.
    expect(guard).toMatch(/catch \(err\)/)
  })

  it('verifies the restore instead of assuming it worked', () => {
    const guard = harness('scripts', 'live', 'service-state.ts')
    expect(guard).toMatch(/final\s*!==\s*this\.initial/)
    expect(guard).toMatch(/failures\.push/)
  })

  it('regression test covers the failure modes, not just the happy path', () => {
    const tests = code('src', 'test', 'live-harness.test.ts')
    // The specific outage this exists to prevent.
    expect(tests).toMatch(/restores an active service after the body throws/)
    expect(tests).toMatch(/rejected promise/)
    expect(tests).toMatch(/ORIGINAL state rather than assuming active/)
  })

  it('never deletes production data from the harness', () => {
    // The guard manages process state only. Fixture teardown is explicit and
    // scoped to the test fixtures, never a blanket delete.
    const guard = harness('scripts', 'live', 'service-state.ts')
    expect(guard).not.toMatch(/\brm\b\s+-rf|delete\s+from|truncate|drop\s+table/i)
  })
})

/** Placeholders the shipped files are allowed to contain. */
const PLACEHOLDERS = /PASTE_[A-Z_]+_HERE|ENTER-[A-Z-]+-?REF|YOUR-PROJECT-REF/

const DEPLOY_FILES = [
  'deploy/install-vps.sh',
  'deploy/netisp-worker.service',
  'deploy/freeradius/sql.conf',
  'deploy/freeradius/clients.conf',
  'deploy/freeradius/radiusd.conf',
  'deploy/freeradius/authorize',
  'deploy/freeradius/post-auth',
  'deploy/freeradius/queries.conf',
  'deploy/freeradius/dictionary.netisp',
  'deploy/wireguard/netisp.conf.template',
  'worker/.env.example',
]

describe('secret hygiene in deployment files', () => {
  it('ships every deployment file it needs', () => {
    for (const f of DEPLOY_FILES) {
      expect(has(...f.split('/')), `${f} is missing`).toBe(true)
    }
  })

  it('puts the systemd start limit in [Unit], where systemd actually reads it', () => {
    const unit = read('deploy', 'netisp-worker.service')
    // A key written under the wrong section is reported as
    //   Unknown key name 'StartLimitIntervalSec' in section 'Service', ignoring
    // and then silently does nothing, so the guard that stops a crash-loop from
    // hiding behind a nominally "running" service was not in force on the host.
    // Section headers are matched at the start of a line. The comment above the
    // real header names Service in prose, and a plain indexOf would find that
    // one first and silently slice the wrong region.
    const unitStart = unit.search(/^\[Unit\]$/m)
    const serviceStart = unit.search(/^\[Service\]$/m)
    expect(unitStart).toBeGreaterThanOrEqual(0)
    expect(serviceStart).toBeGreaterThan(unitStart)
    const unitSection = unit.slice(unitStart, serviceStart)
    const serviceSection = unit.slice(serviceStart)
    expect(unitSection).toMatch(/StartLimitIntervalSec=60/)
    expect(unitSection).toMatch(/StartLimitBurst=5/)
    expect(serviceSection).not.toMatch(/^StartLimit/m)
  })
  it('contains no real-looking secret in any of them', () => {
    for (const f of DEPLOY_FILES) {
      const body = read(...f.split('/'))
      // A 40+ character run of base64-ish characters is what an accidentally
      // committed key looks like. Placeholders and shell expansions are fine.
      const suspicious = body.match(/[A-Za-z0-9+/]{40,}={0,2}/g) ?? []
      for (const candidate of suspicious) {
        expect(
          PLACEHOLDERS.test(candidate) || candidate.startsWith('${'),
          `${f} appears to contain a real credential`,
        ).toBe(true)
      }
    }
  })

  it('never commits a filled-in environment file', () => {
    // The real file must be ignored, or a `git add .` after editing it on the
    // VPS would publish the service-role key.
    const ignore = read('worker', '.gitignore')
    expect(ignore).toMatch(/^\.env$/m)
    expect(ignore).toMatch(/^\.env\.local$/m)
  })

  it('documents the required variables as placeholders, never values', () => {
    const env = read('worker', '.env.example')
    for (const name of [
      'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY',
      'ROUTER_CREDENTIALS_KEY', 'WORKER_NAME',
    ]) {
      expect(env, `${name} missing from .env.example`).toContain(name)
    }
    // Every secret is an explicit PASTE_ placeholder. A value here would be a
    // committed key, which is the one thing this file must never contain.
    for (const name of ['SUPABASE_SERVICE_ROLE_KEY', 'ROUTER_CREDENTIALS_KEY']) {
      const line = env.split('\n').find((l) => l.startsWith(`${name}=`))
      expect(line, `${name} has no assignment`).toBeTruthy()
      // Trim before matching: the file may carry CRLF, and a trailing \r is not
      // a reason to accept a real value.
      expect(line!.trim(), `${name} must be a placeholder`).toMatch(
        new RegExp(`^${name}=PASTE_[A-Z_]+_HERE$`),
      )
    }
  })

  it('warns that the service-role key bypasses RLS', () => {
    // A reader who does not know this will paste the service key into every
    // component and hand out cross-tenant access.
    const env = read('worker', '.env.example')
    expect(env).toMatch(/never the anon/i)
    expect(env).toMatch(/bypasses RLS/i)
  })
})

describe('the worker actually starts', () => {
  // Both of these were real failures found by building and running the worker
  // for real: it built cleanly and then died on startup. Neither is visible to
  // a config-shape test, so both are pinned here.

  it('does not run TypeScript directly through type stripping', () => {
    const pkg = read('worker', 'package.json')
    // `--experimental-strip-types` cannot handle a parameter property such as
    // `constructor(private readonly cfg: DbConfig)`, which db.ts uses. It exits
    // with ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX before a single line runs.
    expect(pkg).not.toMatch(/--experimental-strip-types/)
  })

  it('bundles to CommonJS on a .cjs extension', () => {
    const pkg = read('worker', 'package.json')
    const build = read('worker', 'build.mjs')
    const installer = read('deploy', 'install-vps.sh')
    const unit = read('deploy', 'netisp-worker.service')

    // package.json declares "type": "module", so a CommonJS bundle written to
    // dist/index.js is loaded as ESM and throws "require is not defined in ES
    // module scope". The extension has to be .cjs.
    expect(pkg).toMatch(/"build":\s*"node build\.mjs"/)
    expect(build).toContain(
      "existsSync('src/index.ts') ? 'src/index.ts' : 'worker/src/index.ts'",
    )
    expect(build).toMatch(/outfile:\s*'dist\/index\.cjs'/)
    expect(installer).toMatch(/node build\.mjs/)
    expect(installer).toMatch(/worker\/src\/assets\.d\.ts/)
    expect(installer).toMatch(/public\/hotspot/)
    // ExecStart must name the file that is actually produced.
    expect(unit).toMatch(/^ExecStart=.*dist\/index\.cjs$/m)
  })

  it('needs no banner shim, which would be a quoting hazard', () => {
    const installer = read('deploy', 'install-vps.sh')
    // The ESM build needed `--banner:js='import{createRequire}from"node:module"...'`.
    // When a shell drops those quotes the build still succeeds and the process
    // dies with "Unexpected identifier 'fromnode'". CommonJS output removes it.
    //
    // Comments are stripped first: the file explains this exact hazard above the
    // build command, and a test must not be satisfied by its own prose.
    const code = installer
      .split('\n')
      .filter((l) => !l.trim().startsWith('#'))
      .join('\n')
    expect(code).not.toMatch(/--banner:js/)
  })

  it('stages the worker so its relative import into _shared resolves', () => {
    const installer = read('deploy', 'install-vps.sh')
    const code = installer
      .split('\n')
      .filter((l) => !l.trim().startsWith('#'))
      .join('\n')
    // worker/src/session.ts imports '../../supabase/functions/_shared/session.ts'.
    // `..` twice from <root>/worker/src lands on <root>, so the stage must keep
    // the worker/ segment or esbuild cannot resolve the import.
    expect(code).toMatch(/supabase\/functions\/_shared\s+"\$stage"\/supabase\/functions\//)
    expect(code).toMatch(/worker\/src\/index\.ts/)
    // And it must not copy src to the stage root, which is the bug: that puts
    // the sources one level too shallow for the ../../ import to resolve.
    expect(code).not.toMatch(/cp -r "\$WORKER_SRC"\/src "\$stage"\/\s*$/)
  })
})

describe('systemd unit hardening', () => {
  const unit = read('deploy', 'netisp-worker.service')

  it('runs as a dedicated unprivileged account, not root', () => {
    expect(unit).toMatch(/^User=netisp-worker$/m)
    // `User=root` would be the single most damaging line in the file.
    expect(unit).not.toMatch(/^User=root$/m)
  })

  it('reads credentials from a file rather than the command line', () => {
    expect(unit).toMatch(/^EnvironmentFile=\/etc\/netisp-worker\/environment$/m)
    // A secret in ExecStart is visible to every local user through /proc.
    expect(unit).not.toMatch(/^ExecStart=.*SUPABASE_SERVICE_ROLE_KEY/m)
  })

  it('restarts on failure but stops a crash loop', () => {
    expect(unit).toMatch(/^Restart=always$/m)
    expect(unit).toMatch(/^RestartSec=\d+$/m)
    // Without a start limit a misconfiguration spins forever and the service
    // looks alive while doing nothing.
    expect(unit).toMatch(/^StartLimitBurst=\d+$/m)
  })

  it('applies the standard hardening set', () => {
    for (const directive of [
      'NoNewPrivileges=true',
      'PrivateTmp=true',
      'ProtectSystem=strict',
      'ProtectHome=true',
      'RestrictSUIDSGID=true',
      'LockPersonality=true',
    ]) {
      expect(unit, `${directive} missing`).toContain(directive)
    }
    // An empty capability set is the strongest statement available: the worker
    // needs no Linux capabilities at all.
    expect(unit).toMatch(/^CapabilityBoundingSet=\s*$/m)
  })

  it('waits for the network rather than claiming jobs too early', () => {
    expect(unit).toMatch(/After=network-online\.target/)
    expect(unit).toMatch(/Wants=network-online\.target/)
  })

  it('sends logs to the journal so rotation is handled', () => {
    expect(unit).toMatch(/^StandardOutput=journal$/m)
    expect(unit).toMatch(/^SyslogIdentifier=netisp-worker$/m)
  })
})

describe('firewall posture', () => {
  const script = read('deploy', 'install-vps.sh')

  it('opens RADIUS only for private source ranges', () => {
    // An unqualified `ufw allow 1812/udp` exposes RADIUS to the internet,
    // where it is a password oracle rather than an authentication service.
    expect(script).not.toMatch(/ufw allow 1812\/udp\s*$/m)
    expect(script).not.toMatch(/ufw allow 1813\/udp\s*$/m)
    expect(script).toMatch(/for cidr in 10\.0\.0\.0\/8 172\.16\.0\.0\/12 192\.168\.0\.0\/16/)
    expect(script).toMatch(/ufw allow from "\$cidr" to any port 1812 proto udp/)
    expect(script).toMatch(/ufw allow from "\$cidr" to any port 1813 proto udp/)
  })

  it('keeps the worker health endpoint on loopback', () => {
    expect(script).toMatch(/ufw allow from 127\.0\.0\.1 to any port 9090/)
  })

  it('checks RADIUS over UDP rather than a TCP probe', () => {
    // curl against 1812 proves nothing: RADIUS is UDP only.
    expect(script).toMatch(/ss -lun \| grep -qE/)
    expect(script).not.toMatch(/curl[^|]*1812/)
    expect(script).toContain('radtest')
  })

  it('explains why an exposed RADIUS port is dangerous', () => {
    // The comment is what stops the next person "fixing" the source ranges
    // back to a bare allow.
    expect(script).toMatch(/credential oracle/)
  })
})

describe('FreeRADIUS configuration', () => {
  it('never logs customer passwords', () => {
    const radiusd = read('deploy', 'freeradius', 'radiusd.conf')
    // `auth = yes` writes every password on every login attempt, which makes the
    // log file a credential store.
    expect(radiusd).toMatch(/^\s*auth = no$/m)
    expect(radiusd).toMatch(/^\s*badpass = no$/m)
    expect(radiusd).toMatch(/^\s*goodpass = no$/m)
  })

  it('binds to private addresses rather than every interface', () => {
    const radiusd = read('deploy', 'freeradius', 'radiusd.conf')
    expect(radiusd).toMatch(/^bind_address = 127\.0\.0\.1$/m)
    // A bare `bind_address = *` alongside an open firewall is the failure mode.
    expect(radiusd).not.toMatch(/^bind_address = \*$/m)
  })

  it('enables the protocols MikroTik actually uses', () => {
    const radiusd = read('deploy', 'freeradius', 'radiusd.conf')
    // PPPoE uses CHAP; HotSpot uses PAP or CHAP depending on the user profile.
    // Disabling either locks out real customers.
    expect(radiusd).toMatch(/Pap = yes/)
    expect(radiusd).toMatch(/CHAP = yes/)
    expect(radiusd).toMatch(/MS-CHAP = yes/)
  })

  it('allows roaming so a customer works across the ISP\'s routers', () => {
    const radiusd = read('deploy', 'freeradius', 'radiusd.conf')
    expect(radiusd).toMatch(/roaming \{/)
    expect(radiusd).toMatch(/enabled = yes/)
  })

  it('defines the MikroTik reply attributes it sends', () => {
    const dict = read('deploy', 'freeradius', 'dictionary.netisp')
    for (const attr of [
      'Mikrotik-Rate-Limit',
      'Mikrotik-Expires',
      'Mikrotik-Simultaneous-Limit',
    ]) {
      expect(dict, `${attr} not defined`).toContain(attr)
    }
  })

  it('escapes every user-supplied value through the driver', () => {
    const queries = code('deploy', 'freeradius', 'queries.conf')
    const sql = code('deploy', 'freeradius', 'sql.conf')
    // FreeRADIUS interpolates %{...} into the query text, so an unescaped
    // username is SQL injection with a customer-facing trigger.
    //
    // The escaping is NOT done with %{sql_escape:...}. That function does not
    // exist in FreeRADIUS 3: it is a FreeRADIUS 2 module function, and in 3 the
    // parser rejects the file with "Unknown module" before the server can start.
    // Escaping is the driver's job, selected with auto_escape, which routes
    // every expansion through the postgresql driver's own PQescapeString.
    expect(queries).not.toMatch(/sql_escape/)
    expect(sql).toMatch(/auto_escape\s*=\s*yes/)
  })

  it('drives rlm_sql the way this build actually resolves it', () => {
    const sql = code('deploy', 'freeradius', 'sql.conf')
    // `driver` is resolved to BOTH <libdir>/<driver>.so AND the exported symbol
    // <driver>, so both parts need the rlm_sql_ prefix that Ubuntu ships:
    //   driver = "postgresql" -> Could not link driver postgresql:
    //                          /usr/lib/freeradius/postgresql.so: cannot open
    // "pgsql", which most examples online use, fails the same way.
    expect(sql).toMatch(/driver\s*=\s*"rlm_sql_postgresql"/)
    expect(sql).not.toMatch(/driver\s*=\s*"pgsql"/)
    expect(sql).not.toMatch(/driver\s*=\s*"postgresql"/)
    // rlm_sql calls the database radius_db. `database` is silently ignored and
    // the server falls back to the compiled-in default "radius".
    expect(sql).toMatch(/radius_db\s*=\s*"postgres"/)
    expect(sql).not.toMatch(/^\s*database\s*=/m)
  })

  it('reads only tables and columns that exist in the schema', () => {
    const queries = read('deploy', 'freeradius', 'queries.conf')
    // Verified against the live schema: service_accounts has no `ips` column
    // and no rate_limit; simultaneous_use lives on radius_accounts.
    expect(queries).toMatch(/join\s+public\.service_accounts\s+sa/i)
    expect(queries).toMatch(/left\s+join\s+public\.plans\s+pl/i)
    // Simultaneous-use is enforced in SQL rather than returned as a
    // Mikrotik attribute: Mikrotik-Simultaneous-Limit does not exist in
    // FreeRADIUS 3.2.5, and an unknown attribute fails the whole reply
    // query rather than being ignored.
    expect(queries).not.toMatch(/Mikrotik-Simultaneous-Limit/)
    expect(queries).not.toMatch(/Mikrotik-Expires/)
    // These were the two real mistakes found while wiring this up.
    expect(queries).not.toMatch(/sa\.ips\b/i)
    expect(queries).not.toMatch(/pl\.speed_up\s*\|\|\s*'M'\//i)
  })

  it('normalises a unit-suffixed plan speed into MikroTik syntax', () => {
    const queries = read('deploy', 'freeradius', 'queries.conf')
    // plans.speed_up is TEXT and is usually entered as "2M". Concatenating it
    // raw produced "2MM/10MM", which the router rejects.
    expect(queries).toMatch(/regexp_replace\(pl\.speed_up::text/)
    expect(queries).toMatch(/regexp_replace\(pl\.speed_down::text/)
  })

  it('resolves the tenant from the NAS before touching any subscriber', () => {
    const queries = code('deploy', 'freeradius', 'queries.conf')
    // Username is unique per (isp_id, username), not globally, so a lookup by
    // username alone can return another tenant's customer. Every statement must
    // join radius_nas and scope the subscriber by the tenant that came back, so
    // no path reaches service_accounts without passing the NAS check.
    const joins =
      queries.match(/join\s+public\.service_accounts\s+sa\s+on\s+sa\.isp_id\s*=/gi) || []
    expect(joins.length).toBeGreaterThan(0)
    expect(queries).toMatch(/from\s+public\.radius_nas\s+nas/i)
    const nasFilters = queries.match(/nas\.nas_identifier\s*=\s*'%\{/gi) || []
    expect(nasFilters.length).toBeGreaterThan(0)
    // And there is still no bare "WHERE username = ..." lookup anywhere.
    expect(queries).not.toMatch(/where\s+sa\.username\s*=\s*'%\{[^}]*'\s+limit/i)
  })

  it('gates on account status and expiry before granting service', () => {
    const queries = code('deploy', 'freeradius', 'queries.conf')
    // A suspension has to take effect on the next login even if the router was
    // never told. The gate lives in the query, in the same WHERE clause as the
    // tenant resolution, so it is enforced against the row actually matched
    // rather than against a value carried back and possibly re-read.
    expect(queries).toMatch(/sa\.status\s*=\s*'active'/)
    expect(queries).toMatch(
      /sa\.expires_at\s+is\s+null\s+or\s+sa\.expires_at\s*>\s*now\(\)/i,
    )
  })

  it('casts the enumerated Acct-Terminate-Cause to a number, not a name', () => {
    const queries = code('deploy', 'freeradius', 'queries.conf')
    // dictionary.rfc2866 declares Acct-Terminate-Cause as an integer WITH VALUE
    // names, so a bare %{...} expands to the NAME ("User-Request"). Casting that
    // straight to integer is
    //     rlm_sql_postgresql: 22P02: invalid input syntax for type integer
    // and it sits inside the ON CONFLICT DO UPDATE, so the error aborts the
    // whole statement: a Stop changed no column at all, leaving a session that
    // is opened and updated but never closed. %{integer:...} is the cast that
    // yields the number, and it expands to empty - not 0 - for a value it
    // cannot convert, so an absent attribute still degrades to NULL through the
    // surrounding NULLIF.
    expect(queries).toMatch(
      /NULLIF\('%\{integer:Acct-Terminate-Cause\}',''\)::integer/,
    )
    expect(queries).not.toMatch(
      /NULLIF\('%\{Acct-Terminate-Cause\}',''\)::integer/,
    )
  })

  it('derives end_reason from a closed vocabulary, not from the raw cause', () => {
    const queries = code('deploy', 'freeradius', 'queries.conf')
    // end_reason carries its own CHECK (radius_sessions_end_reason_ck). The
    // router's name for the cause is not in that vocabulary, and a CHECK
    // violation fails the whole statement, so the name is mapped onto a value
    // the column allows rather than copied into it.
    const allowed = [
      'acct-stop', 'acct-interim', 'timeout', 'admin',
      'expired', 'superseded', 'radius-restart',
    ]
    const written = (queries.match(/THEN\s+'[a-z-]+'/g) || []).map((m) =>
      m.replace(/^THEN\s+'|'$/g, ''),
    )
    expect(written.length).toBeGreaterThan(0)
    for (const value of written) expect(allowed).toContain(value)
    // Total: an unrecognised cause still gets a valid reason instead of a
    // rejected row.
    expect(queries).toMatch(/ELSE\s+'acct-stop'/)
    // Both branches map, so a session first seen as a Start is closed the same
    // way as one that only ever arrives as a Stop.
    expect((queries.match(/WHEN 'Idle-Timeout'/g) || []).length).toBe(2)
  })

  it('rejects an implausible username before querying the database', () => {
    const authorize = code('deploy', 'freeradius', 'authorize')
    // HotSpot allows arbitrary characters in the login field. A permissive LIKE
    // would let a crafted username read another subscriber's rate limit, so the
    // allow-list filter runs before the sql module is ever invoked.
    //
    // The filter is a negated match against an allow-list, not a deny-list: a
    // deny-list only protects against the characters someone thought of.
    expect(authorize).toMatch(/!"%\{control:NETISP-LookupKey\}"\s*=~/)
    expect(authorize).toMatch(/\/\^\[A-Za-z0-9\._-\]\+\$\//)
    // Ordering is the security property, not the regex: the check must precede
    // the query or it is decorative.
    expect(authorize.indexOf('control:NETISP-LookupKey}" =~')).toBeLessThan(
      authorize.search(/^sql$/m),
    )
  })

  it('rejects a packet with no NAS identity at all', () => {
    const authorize = code('deploy', 'freeradius', 'authorize')
    // The tenant comes from Called-Station-Id. A packet without one has no
    // tenant, so it must never reach the query.
    expect(authorize).toMatch(/Called-Station-Id\}"\s*==\s*""/)
    expect(authorize.indexOf('Called-Station-Id}" == ""')).toBeLessThan(
      authorize.indexOf('sql'),
    )
  })

  it('calls no sql_query(), which FreeRADIUS 3 does not have', () => {
    for (const f of ['authorize', 'session-open', 'post-auth']) {
      const body = code('deploy', 'freeradius', f)
      // rlm_sql registers no policy functions at all, so a call to sql_query()
      // cannot parse: "Parse error after sql_query: unexpected token "(".
      // Invoking the module IS the call in FreeRADIUS 3.
      expect(body, `${f} still calls sql_query()`).not.toMatch(/sql_query\s*\(/)
      // and no reference to the undeclared NETISP:: namespace, which the parser
      // resolves as a module name and refuses: "Unknown module".
      expect(body, `${f} still uses NETISP::`).not.toMatch(/NETISP::/)
      // A control-list attribute must be read as %{control:...}. Bare
      // %{...} reads the REQUEST list, which never holds it, so the value
      // silently expands to empty.
      expect(body, `${f} reads a control attribute without control:`)
        .not.toMatch(/%\{(?!control:|control:)[A-Za-z-]*NETISP/)
    }
  })

  it('strips the HotSpot realm so PPPoE and HotSpot share one lookup', () => {
    const authorize = read('deploy', 'freeradius', 'authorize')
    // HotSpot sends "user@realm"; the realm identifies the router, not the
    // subscriber. PPPoE sends no realm, so both must resolve to one key.
    expect(authorize).toMatch(/~\s*\/\^\(\.\+\)@\[A-Za-z0-9\.\-\]\+\$\//)
  })

  it('does not close sessions from post-auth', () => {
    const postAuth = read('deploy', 'freeradius', 'post-auth')
    // A RADIUS restart that wrote acct_stop would disconnect every live
    // customer. Sessions are closed by the router or by the worker.
    expect(postAuth).not.toMatch(/delete\s+from/i)
    expect(postAuth).not.toMatch(/update\s+public\.radius_sessions/i)
  })

  it('keeps database credentials out of the world-readable config', () => {
    const sql = read('deploy', 'freeradius', 'sql.conf')
    // sql.conf IS the module configuration and is installed 0640 root:freerad,
    // because rlm_sql has no "sqlconf" directive: a separate file pointed at by
    // a module file is never read, and every value silently falls back to the
    // defaults compiled into rlm_sql (driver="rlm_sql_null", radius_db="radius").
    expect(sql).toMatch(/POOLER_PASSWORD/)
    expect(code('deploy', 'freeradius', 'radiusd.conf')).not.toMatch(/sqlconf\s*=/)
  })

  it('recommends a least-privilege role rather than the service key', () => {
    const sql = code('deploy', 'freeradius', 'sql.conf')
    const migration = code('supabase', 'migrations', '20260101100300_radius_auth.sql')
    // A RADIUS lookup has no JWT, so it bypasses RLS. Reusing the service_role
    // key there would hand out full cross-tenant read access. The role is created
    // and granted by the migration, not by the FreeRADIUS configuration: the
    // server must never be the thing that decides what it is allowed to read.
    expect(sql).toMatch(/login\s*=\s*"POOLER_USER"/)
    expect(sql).not.toMatch(/service_role|service-role|sb_secret_/)
    expect(migration).toMatch(/grant select on public\.radius_nas to radius_reader/)
    expect(migration).toMatch(
      /grant select on public\.service_accounts to radius_reader/,
    )
    // The role must not be able to read the encryption key, the router secrets
    // or the money.
    expect(migration).not.toMatch(
      /grant[^;]*netisp_internal_keys\s+to\s+radius_reader/,
    )
    expect(migration).not.toMatch(/grant[^;]*router_credentials\s+to\s+radius_reader/)
    expect(migration).not.toMatch(/grant[^;]*payments\s+to\s+radius_reader/)
  })
/**
 * Found by running the queue rather than reading it: claiming a job SETS its
 * status to 'processing', so a worker that died mid-job left a row that no claim
 * query could ever select again. The lease-expiry recovery the function
 * documents did not exist, and stranded work permanently.
 */
describe('the job queue recovers work stranded by a dead worker', () => {
  const CLAIM = 'supabase/migrations/20260101150000_claim_expired_processing_jobs.sql'

  it('ships the migration that fixes it', () => {
    expect(has(...CLAIM.split('/'))).toBe(true)
  })

  it('claims a job whose lease has expired even while it is processing', () => {
    const sql = code(...CLAIM.split('/'))
    expect(sql).toMatch(/j\.status\s*=\s*'processing'/)
    expect(sql).toMatch(/j\.locked_until\s*<\s*now\(\)/)
  })

  it('still refuses to steal a live lease', () => {
    const sql = code(...CLAIM.split('/'))
    expect(sql).toMatch(
      /and\s*\(\s*j\.locked_until\s+is\s+null\s+or\s+j\.locked_until\s*<\s*now\(\)\s*\)/i,
    )
  })

  it('keeps claiming pending and retrying work exactly as before', () => {
    const sql = code(...CLAIM.split('/'))
    expect(sql).toMatch(/j\.status\s+in\s*\(\s*'pending'\s*,\s*'retrying'\s*\)/)
  })

  it('does not cap reclaim attempts, which would strand the row again', () => {
    const sql = code(...CLAIM.split('/'))
    expect(sql).not.toMatch(
      /status\s*=\s*'processing'[\s\S]{0,400}attempt_count\s*<\s*j\.max_attempts/i,
    )
  })
})

/**
 * Both of these were found by running settlement against production and asserting
 * on the resulting rows.
 *
 * The first shipped 30 days of service for every payment, whatever was bought.
 * The second was a regression introduced WHILE fixing the first: replacing a
 * function body by hand silently dropped the duplicate guard, which turned every
 * redelivered webhook into a second activation, a second RADIUS job and a second
 * SMS. The live replay test caught it on the first run.
 */
describe('payment settlement grants what was paid and stays idempotent', () => {
  const GRANT = 'supabase/migrations/20260101170000_payment_grant_period.sql'

  it('no longer grants a fixed 30 days', () => {
    const sql = code(...GRANT.split('/'))
    // Asserted against the function BODY, not the whole file: the migration's
    // prose deliberately quotes the old expression to document the defect, and
    // matching that comment would pass the test for the wrong reason.
    const open = sql.indexOf('$$', sql.indexOf('create or replace function public.settle_hashback_payment'))
    const body = sql.slice(open, sql.indexOf('$$', open + 2))
    expect(body).not.toMatch(/v_from\s*\+\s*interval\s+'30 days'/)
    expect(body).toMatch(/make_interval\(hours\s*=>\s*coalesce\(v_hours,\s*720\)\)/)
  })

  it('resolves the period inside one tenant only', () => {
    const sql = code(...GRANT.split('/'))
    // Two ISPs may both sell "Monthly" with different durations. The grant must
    // follow the tenant that was actually paid.
    // The first `$$` after the name is the dollar-quote OPENER, so the body runs
    // to the second one.
    const open = sql.indexOf('$$', sql.indexOf('payment_grant_hours'))
    const fn = sql.slice(open, sql.indexOf('$$', open + 2))
    expect(fn).toMatch(/where\s+isp_id\s*=\s*p_isp_id/i)
  })

  it('returns NULL rather than guessing an unparseable label', () => {
    const sql = code(...GRANT.split('/'))
    // A label that looks parseable but is not must not abort a real settlement.
    expect(sql).toMatch(/exception\s+when\s+others\s+then[\s\S]{0,900}return\s+null/i)
  })

  it('keeps the duplicate guard in the replaced settlement function', () => {
    const sql = code(...GRANT.split('/'))
    // Dropping these two blocks is the regression that was nearly shipped.
    expect(sql).toMatch(
      /v_pay\.status\s*=\s*'success'\s*and[\s\S]{0,300}provider_transaction_id\s*<>\s*p_transaction_id\s*then/i,
    )
    expect(sql).toMatch(
      /v_pay\.status\s*=\s*'success'\s*then\s+v_duplicate\s*:=\s*true;\s*end\s+if;/i,
    )
  })

  it('guards every settlement write behind the duplicate flag', () => {
    const sql = code(...GRANT.split('/'))
    const body = sql.slice(sql.indexOf('create or replace function public.settle_hashback_payment'))
    // The status change, the activation, the completion and the audit record must
    // all be conditional, or one of them double-fires on a replay.
    const writes = [
      /set\s+status\s*=\s*'success'/i,
      /update\s+public\.invoices\s+set\s+status\s*=\s*'paid'/i,
      /update\s+public\.clients\s+set/i,
      /complete_hashback_settlement\s*\(/i,
      /insert\s+into\s+public\.audit_logs/i,
    ]
    for (const w of writes) {
      const at = body.search(w)
      expect(at, `missing write ${w}`).toBeGreaterThan(-1)
      const before = body.slice(Math.max(0, at - 1500), at)
      expect(before, `unguarded write ${w}`).toMatch(/if\s+not\s+v_duplicate/i)
    }
  })

  it('exposes no secret to the browser, by construction', () => {
    const config = code('src', 'lib', 'config.ts')
    // The browser bundle may carry the anon key and nothing else. Vite inlines
    // every VITE_* value verbatim, so a secret smuggled into one of these names
    // would be published to every visitor.
    const used = [...config.matchAll(/import\.meta\.env\.([A-Z_0-9]+)/g)]
      .map((m) => m[1])
    expect(used.length).toBeGreaterThan(0)
    for (const name of used) {
      expect(
        /^VITE_(SUPABASE_URL|SUPABASE_ANON_KEY|APP_NAME|APP_URL|SUPER_ADMIN_EMAILS)$/.test(name),
        `${name} is inlined into the public bundle and must not be a secret`,
      ).toBe(true)
    }
    // Explicitly: nothing server-only may be read from import.meta.env.
    for (const secret of [
      'SUPABASE_SERVICE_ROLE_KEY', 'ROUTER_CREDENTIALS_KEY',
      'APP_ENCRYPTION_KEY', 'HASHBACK',
    ]) {
      expect(config).not.toMatch(new RegExp(`import\\.meta\\.env\\.[A-Z_]*${secret}`))
    }
    // The only credentials the client ever holds are the anon key, and the
    // project decides what that may do through RLS.
    expect(config).toMatch(/VITE_SUPABASE_ANON_KEY/)
    expect(config).not.toMatch(/service[_-]?role/i)
  })

  it('never names a server-only secret in application code', () => {
    // These may appear in tests that assert they are ABSENT, never in the
    // application itself. A stray read in src/ would be a real leak.
    const appFiles = [...new Set(
      (code('src', 'lib', 'config.ts') ? ['src/lib/config.ts'] : []),
    )]
    expect(appFiles).toEqual(['src/lib/config.ts'])
    const client = read('src', 'lib', 'config.ts')
    expect(client).not.toMatch(/SERVICE_ROLE|ROUTER_CREDENTIALS_KEY|APP_ENCRYPTION_KEY/)
  })

  it('never leaves an Edge Function that bypasses the JWT gateway unauthenticated',
    async () => {
      const { readdirSync, readFileSync } = await import('node:fs')
      const { join } = await import('node:path')
      const dir = join(ROOT, 'supabase', 'functions')
      const offenders: string[] = []
      for (const name of readdirSync(dir, { withFileTypes: true })) {
        if (!name.isDirectory()) continue
        const entry = join(dir, name.name, 'index.ts')
        if (!existsSync(entry)) continue
        const src = readFileSync(entry, 'utf8')
        // --no-verify-jwt is legitimate for pg_cron (no user session) and for
        // the provider webhook (HMAC, not a session). The function must then
        // authenticate the caller ITSELF, in one of the shapes this codebase
        // actually uses: a bearer-token check, the HMAC verifier, or being a
        // retired stub that does no work at all.
        const noJwt = /deploy[^`]*--no-verify-jwt/.test(src)
        const guard = [
          /isAuthorised\(/,                                  // bearer vs secret
          /auth\.getUser\(/,                                // validate the JWT
          /verifyWebhookRequest\(|verifyWebhookSignature\(/,  // provider HMAC
          /410,/,                                            // inert cutover stub
          // Declared anonymous by design. The captive portal has no signed-in
          // user: the router redirects a device with no connectivity, so a
          // session cannot exist. Such a function must instead resolve the
          // tenant server-side and take no caller-supplied identity, and it has
          // to SAY so with this marker. Requiring the marker rather than
          // allow-listing a name means a new function cannot skip this check by
          // accident - it has to state the exemption, and the test below then
          // holds it to that claim.
          /AUTHENTICATION:\s*anonymous/,
        ].some((re) => re.test(src))
        if (noJwt && !guard) offenders.push(name.name)
      }
      expect(offenders, 'no-verify-jwt without an in-function auth check')
        .toEqual([])
    })

  it('the Kick button goes through the queue, not a direct router call', () => {
    const data = code('src', 'lib', 'data.ts')
    // Bounded to this function's own body: a fixed-length slice runs into the next
    // declaration, which has its own reasons to call invokeMikrotik.
    const start = data.indexOf('export async function kickSession')
    const rest = data.slice(start)
    const end = rest.indexOf('\nexport ')
    const fn = end > 0 ? rest.slice(0, end) : rest
    // It must not call the mikrotik Edge Function from the browser: that is a
    // direct router management call with no job, no retry and no audit trail.
    expect(fn).not.toMatch(/invokeMikrotik/)
    expect(fn).toMatch(/disconnectLiveSession/)
    // The tenant-scoped RPC is the only path.
    expect(fn).not.toMatch(/enqueue_router_job|from\('router_jobs'\)/)
  })

  it('the panel sends the RADIUS session id, not the row id', () => {
    const panel = code('src', 'components', 'AdminDashboard.tsx')
    // request_session_disconnect is keyed on acct_session_id. Passing radius_
    // sessions.id would never match a row.
    expect(panel).toMatch(/onKickSession\(s\.acctSessionId \?\? s\.id\)/)
  })

  it('keeps the queue path reachable in the built bundle', () => {
    // The previous disconnect implementation was correct but unreachable, so it
    // was tree-shaken out of the shipped JavaScript entirely. This asserts the
    // call is actually wired, not merely present in a file nothing imports.
    const data = code('src', 'lib', 'data.ts')
    expect(data).toMatch(/import\s*\{[^}]*disconnectLiveSession[^}]*\}\s*from\s*'\.\/network'/)
    const panel = code('src', 'components', 'AdminDashboard.tsx')
    expect(panel).toMatch(/onKickSession/)
  })

  it('commits no plaintext account password', () => {
    // The authenticated browser suite used to read the shared test password out
    // of this file, which put a platform super-admin's credential in the
    // repository - and therefore in every mirror, fork and CI cache of it.
    const guide = read('DEPLOYMENT.md')
    expect(guide).not.toMatch(/All use the password/i)
    // No long password-shaped literal in the guide at all.
    expect(guide).not.toMatch(/password[^.\n]{0,20}`[A-Za-z0-9!@#$%^&*]{8,}`/)

    // And the suite must take it from the environment instead.
    const spec = read('e2e', 'production-auth.spec.ts')
    expect(spec).toMatch(/PLAYWRIGHT_TEST_PASSWORD/)
    expect(spec).not.toMatch(/readFileSync/)

    // Across the whole tree, no committed password literal for these accounts.
    for (const f of ['DEPLOYMENT.md', 'e2e/production-auth.spec.ts', 'e2e/smoke.spec.ts']) {
      expect(read(...f.split('/')), `${f} contains a password literal`)
        .not.toMatch(/ISINDU\d+/i)
    }
  })

  it('fails loudly when the browser test password is missing', () => {
    // A silently skipped authenticated test is indistinguishable from a passing
    // one, so the suite must refuse to start rather than skip.
    const spec = read('e2e', 'production-auth.spec.ts')
    expect(spec).toMatch(/if\s*\(\s*!PASSWORD\s*\)\s*\{/)
    expect(spec).toMatch(/throw new Error/)
    // The error must name the variable, not the value. The only quoted literal it
    // may carry is the instructional placeholder, never a real password.
    expect(spec).toMatch(/PLAYWRIGHT_TEST_PASSWORD is not set/)
    expect(spec).not.toMatch(
      /PASSWORD\s*=\s*['"](?!<the shared test password>)[^'"]{4,}['"]/,
    )
  })

  it('resolves the customer portal from the database, not the demo store', () => {
    // The portal looked the tenant up in the local demo store, which only ever
    // contains sample ISPs. Every real tenant therefore resolved to "Portal not
    // found" in production while the backend was perfectly capable of serving
    // it - verified live: public_portal_settings returns all three real ISPs.
    const portal = read('src/pages/CaptivePortal.tsx')

    // The live branch must go to the public RPC, and must derive the ISP it
    // renders from that response. It used to call fetchPublicPortalSettings and
    // hand-build a PortalState; the storefront now reads the same RPC through
    // lib/portal and passes the response straight through.
    expect(portal).toMatch(/fetchPortalSettings\(slug!?\)/)
    expect(portal).toMatch(/fetchPortalPackages\(slug!?\)/)
    expect(portal).toMatch(/setState\(\{\s*settings,\s*packages\s*\}\)/)

    // The demo lookup must not be reachable on the live path, i.e. it may only
    // appear after an early `return` on the live branch.
    const liveIdx = portal.indexOf("config.mode === 'live'")
    const demoIdx = portal.indexOf('loadDb()')
    expect(liveIdx, 'no live branch found').toBeGreaterThan(-1)
    expect(demoIdx, 'demo lookup still present').toBeGreaterThan(-1)
    expect(demoIdx, 'demo lookup must not run before the live branch returns')
      .toBeGreaterThan(liveIdx)
    expect(portal.slice(liveIdx, demoIdx)).toMatch(/^\s*return\s*$/m)

    // A transport failure must not masquerade as "no such portal".
    expect(portal).toMatch(/setLoadError\(/)
    expect(portal).toMatch(/Portal unavailable/)
  })

  it('sells packages on the portal instead of only listing them', () => {
    // The reported problem: the portal rendered a voucher box with a read-only
    // price list. Packages were fetched and then never sold, because the only
    // STK entry point required a JWT and a captive-portal visitor cannot sign
    // in. These fail if the buy path is removed or reverted to display-only.
    const portal = read('src/pages/CaptivePortal.tsx')

    // The grid, and a per-package button that opens a payment flow.
    expect(portal).toMatch(/packages_heading/)
    expect(portal).toMatch(/onBuy=/)
    expect(portal).toMatch(/connect_button_text/)

    // The voucher section still exists. It must not have replaced the
    // marketplace, which is what the bug looked like.
    expect(portal).toMatch(/redeemPortalVoucher/)
    expect(portal).toMatch(/show_voucher/)

    // Reconnect and existing-customer login are still reachable.
    expect(portal).toMatch(/reconnectPortalCustomer/)
    expect(portal).toMatch(/loginPortalCustomer/)
    expect(portal).toMatch(/show_reconnect/)

    // Footer and contact details come from settings, not from literals.
    expect(portal).toMatch(/All rights reserved/)
    expect(portal).toMatch(/new Date\(\)\.getFullYear\(\)/)
  })

  it('never lets the browser decide where a portal payment goes', () => {
    // The portal is anonymous, so the only thing standing between a visitor and
    // a misdirected payment is that the request carries no amount, no ISP id and
    // no AccountID. Asserted at every layer that could have introduced one.
    const client = read('src/lib/portal.ts')
    const fn = read('supabase/functions/portal-stk/index.ts')
    const sql = read('supabase/migrations/20260101200000_portal_storefront.sql')

    // The browser helper takes a slug, a plan and a phone. Nothing else.
    // The parameter block is what matters; the return type is sliced off
    // deliberately, because a response may legitimately carry the amount back
    // for display. Only what the caller SENDS is constrained.
    const start = client.slice(client.indexOf('export async function startPortalPayment'))
    const sig = start.slice(0, start.indexOf('): Promise<'))
    expect(sig).toMatch(/slug: string/)
    expect(sig).toMatch(/planId: string/)
    expect(sig).toMatch(/phone: string/)
    // An amount or account id here would mean the browser picks where its money
    // goes.
    expect(sig).not.toMatch(/amount/i)
    expect(sig).not.toMatch(/account/i)
    expect(sig).not.toMatch(/ispId|isp_id/i)

    // The function forwards only those three.
    const at = start.indexOf('body: JSON.stringify')
    expect(start.slice(at, at + 200)).not.toMatch(/amount/i)
    expect(start.slice(at, at + 200)).not.toMatch(/account/i)

    // The Edge Function accepts only those three, and resolves the rest
    // server-side via a service-role RPC.
    expect(fn).toMatch(/admin\.rpc\('portal_create_payment'/)
    // The AccountID comes from the RPC result, never from the request body.
    expect(fn).not.toMatch(/body\.accountId/)
    expect(fn).not.toMatch(/body\.amount/)

    // That RPC is unreachable from a browser: service role only.
    const create = sql.slice(sql.indexOf('create or replace function public.portal_create_payment'))
    expect(create).toMatch(
      /revoke all on function public\.portal_create_payment[\s\S]*?from public, anon, authenticated/,
    )
    expect(create).toMatch(
      /grant execute on function public\.portal_create_payment\(text, uuid, text\) to service_role/,
    )

    // The amount is read from the plan row, scoped to the tenant the slug
    // resolved to.
    expect(create).toMatch(
      /select \* into v_plan from public\.plans[\s\S]*?where id = p_plan_id and isp_id = v_isp/,
    )
    expect(create).toMatch(/v_amount := v_plan\.price/)

    // And the signature carries no amount, tenant or account parameter, which
    // is the only way a caller could have supplied one.
    const params = create.slice(0, create.indexOf(') returns jsonb'))
    expect(params).not.toMatch(/p_amount|p_isp_id|p_account/i)
  })

  it('scopes every public portal function to the tenant its slug resolved to', () => {
    // ISP A's portal must never reach ISP B's packages, payment account,
    // vouchers or branding. Each public function filters on a slug-derived
    // isp_id, and none accepts a tenant id.
    const sql = read('supabase/migrations/20260101200000_portal_storefront.sql')

    const cases: Array<[string, RegExp]> = [
      ['public_portal_settings',
        /from public\.portal_settings s\s+join public\.isps i on i\.id = s\.isp_id\s+where i\.slug = lower\(trim\(p_slug\)\)/],
      ['public_portal_packages',
        /join public\.isps i on i\.id = pl\.isp_id[\s\S]*?where i\.slug = lower\(trim\(p_slug\)\)/],
      ['portal_redeem_voucher',
        /where lower\(code\) = lower\(btrim\(p_code\)\) and isp_id = v_isp/],
      ['portal_create_payment',
        /select id into v_isp from public\.isps where slug = lower\(trim\(p_slug\)\)/],
      ['portal_payment_status',
        /join public\.isps i on i\.id = pay\.isp_id[\s\S]*?where i\.slug = lower\(trim\(p_slug\)\)/],
      ['portal_customer_login',
        /where isp_id = v_isp and lower\(username\) = lower\(btrim\(p_username\)\)/],
      ['portal_reconnect',
        /where isp_id = v_isp[\s\S]*?and lower\(username\) = lower\(btrim\(p_username\)\)/],
    ]

    for (const [fn, pattern] of cases) {
      expect(sql, `${fn} not found`).toContain(fn)
      expect(sql, `${fn} does not scope by slug`).toMatch(pattern)
    }

    // No public portal function may take a tenant id from the caller. That is
    // the parameter through which a cross-tenant request would be expressed.
    expect(sql).not.toMatch(/p_isp_id/)
    expect(sql).not.toMatch(/p_tenant/)
  })

  it('does not let the portal reuse the cross-tenant voucher lookup', () => {
    // redeem_voucher(text) resolves a code across every tenant, so ISP A's
    // portal could redeem ISP B's voucher. It still exists for the staff HotSpot
    // preview; the public portal must not call it.
    const sql = read('supabase/migrations/20260101200000_portal_storefront.sql')
    const client = read('src/lib/portal.ts')

    expect(sql).toMatch(/create or replace function public\.portal_redeem_voucher/)
    expect(sql).toMatch(
      /grant execute on function public\.portal_redeem_voucher\(text, text, text\) to anon, authenticated/,
    )
    expect(client).not.toMatch(/rpc\('redeem_voucher'/)
  })

  it('settles a manual Till payment without aborting, for the period paid', () => {
    // Found by actually running confirm_manual_payment: it referenced `p_pay`,
    // which is not a variable in that function (the local is `v_pay`). The
    // UPDATE therefore raised "missing FROM-clause entry", the transaction
    // aborted, and staff could not settle ANY Till payment - and because the
    // statement threw, the invoice and the activation below it never ran either.
    // This had been latent because nothing could create a manual payment.
    const sql = code('supabase', 'migrations', '20260101000300_payment_modes.sql')
    const fn = sql.slice(sql.indexOf('create or replace function public.confirm_manual_payment'))

    expect(fn).toMatch(/where id = v_pay\.id;/)
    expect(fn).not.toMatch(/where id = p_pay\.id;/)

    // The same flat-30-days defect that was fixed for settle_hashback_payment
    // was missed here, so an hourly hotspot paid for by hand granted a month.
    expect(fn).not.toMatch(/expires_at = v_from \+ interval '30 days'/)
    expect(fn).toMatch(/payment_grant_hours\(v_pay\.isp_id, v_inv\.period_label, v_inv\.plan_name\)/)
    // Tenant-scoped, so a shared plan name cannot resolve to another ISP.
    expect(fn).toMatch(/payment_grant_hours\(v_pay\.isp_id/)
  })

  it('lets a Till-configured ISP sell, not just an automated one', () => {
    // `manual_till` is a supported collection mode: Daraja was retired, and an
    // automated provider is optional per tenant. Requiring a connected
    // automated channel meant the portal refused every sale for every ISP that
    // had configured the one thing it can actually collect.
    const sql = read('supabase/migrations/20260101300000_portal_payhero_route.sql')
    const fn = sql.slice(sql.indexOf('create or replace function public.portal_create_payment'))

    // One predicate decides "collects automatically", so the readiness check, the
    // payment method and the collection mode cannot drift apart.
    expect(fn).toMatch(/v_automated := v_cfg\.payment_provider::text in \('hashback', 'payhero'\)/)

    // An automated provider is still required to be complete before STK...
    expect(fn).toMatch(/if v_automated then/)
    expect(fn).toMatch(/connection_status::text <> 'connected'/)
    // ...and each names its own destination column, so a misconfigured tenant is
    // refused rather than prompted at an unknown Till.
    expect(fn).toMatch(/payment_provider::text = 'payhero' and v_cfg\.payhero_channel_id is null/)
    expect(fn).toMatch(/payment_provider::text = 'hashback' and v_cfg\.hashback_account_id is null/)

    // ...but a Till or Paybill is a legitimate alternative, not a refusal.
    expect(fn).toMatch(/elsif nullif\(btrim\(coalesce\(v_cfg\.till_number/)

    // The collection mode is decided server-side and told to the caller, so the
    // browser cannot request a path the ISP has not configured.
    expect(fn).toMatch(/'collection_mode', case when v_automated/)

    // The payment records HOW it will be settled, because the two modes settle
    // through different functions.
    expect(fn).toMatch(/case when v_automated then 'mpesa' else 'till_manual'/)

    // The provider is reported so the Edge Function prompts the right one, and the
    // browser can label the screen without deciding this itself.
    expect(fn).toMatch(/'provider', v_cfg\.payment_provider::text/)
  })

  it('prompts PayHero from the portal without a second provider implementation', () => {
    // The captive portal must be able to REACH PayHero. It does so through the
    // already-verified adapter, not a portal-specific copy of it.
    const edge = read('supabase/functions/portal-stk/index.ts')

    expect(edge).toMatch(/if \(charge\.provider === 'payhero'\)/)
    expect(edge).toMatch(/new PayHeroClient\(\{ apiToken: creds\.apiToken \}\)/)

    // The amount and the channel both come from the resolved charge, never from
    // the request, so a caller cannot redirect or re-price a payment.
    expect(edge).toMatch(/channelId: charge\.payhero_channel_id/)
    expect(edge).toMatch(/amount: Number\(charge\.amount\)/)

    // The callback is pointed at the existing verification endpoint rather than a
    // new one.
    expect(edge).toMatch(/functions\/v1\/payhero-callback/)

    // Initiation is explicitly not settlement.
    expect(edge).toMatch(/status: 'pending'/)

    // An absent reference means the prompt was NOT sent; saying otherwise would
    // send a customer to a phone with no prompt on it.
    expect(edge).toMatch(/if \(!result\.accepted \|\| !result\.reference\)/)

    // The manual path still works and is still reachable.
    expect(edge).toMatch(/if \(charge\.collection_mode === 'manual_till'\)/)
    expect(edge).toMatch(/mode: 'manual_till'/)
  })

  it('badges at most one package, and only the one the ISP chose', () => {
    // plans.is_popular is a catalogue-wide flag and the seeded catalogues flag
    // more than one plan per ISP. Falling back to it painted "MOST POPULAR" on
    // two cards at once, so the storefront advertised two most-popular packages.
    // featured_plan_id is the only source of the badge, and it is singular.
    const sql = read('supabase/migrations/20260101200000_portal_storefront.sql')

    const pkg = sql.slice(sql.indexOf('create or replace function public.public_portal_packages'))
    expect(pkg).toMatch(/\(pl\.id = ps\.featured_plan_id\) as is_featured/)

    // No plan-wide fallback anywhere in the projection.
    const badge = pkg.slice(pkg.indexOf('as is_featured') - 200, pkg.indexOf('as is_featured'))
    expect(badge).not.toMatch(/is_popular/)
  })

  it('holds a declared-anonymous function to that declaration', () => {
    // portal-stk runs with JWT verification off, which the suite normally
    // forbids. The exemption is a comment, and a comment is not a control, so
    // the claim it makes is asserted here instead: the function must take only
    // a slug, a package and a phone, and must resolve everything else
    // server-side. If someone later adds a caller-supplied amount or tenant, this
    // fails rather than the exemption quietly widening.
    const fn = read('supabase/functions/portal-stk/index.ts')

    // The declaration must actually be there, not assumed.
    expect(fn).toMatch(/AUTHENTICATION:\s*anonymous/)

    // Only the type declaration is inspected, not the whole function: the body
    // legitimately mentions an amount when displaying the charge, and must not
    // be mistaken for accepting one.
    const typed = fn.slice(fn.indexOf('let body:'), fn.indexOf('let body:') + 120)
    expect(typed).toMatch(/slug\?: string; planId\?: string; phone\?: string/)

    // Nothing that identifies a tenant, an account or an amount is accepted.
    expect(typed).not.toMatch(/ispId|isp_id|accountId|account_id|amount|email|userId/i)

    // And the tenant and price come from the service-role RPC, not the request.
    expect(fn).toMatch(/admin\.rpc\('portal_create_payment', \{\s*p_slug: slug,\s*p_plan_id: planId,\s*p_msisdn: msisdn/)
  })

it('never claims a RouterOS fetch wrote a file it discarded', () => {
    // `output=none` makes /tool fetch throw the bytes away, so the file check
    // after it could never pass and provisioning failed on every router while
    // reporting a network error. Regression guard on the real generated script.
    const caps = read('supabase/functions/_shared/capabilities.ts')
    // The source builds this command from concatenated template fragments.
    const fetchStart = caps.indexOf('`/tool fetch url=')
    const fetchEnd = caps.indexOf('`/import file-name=', fetchStart)
    const fetchCommand = fetchStart >= 0 && fetchEnd > fetchStart
      ? caps.slice(fetchStart, fetchEnd)
      : ''
    expect(fetchCommand).not.toMatch(/output=none/)
    expect(caps).toContain('mode=https check-certificate=yes output=file dst-path=ispflow-bootstrap.rsc;')

    // The connectivity probe in the worker legitimately wants output=none: it
    // must not be "fixed" along with the provisioning download.
    const handlers = read('worker/src/handlers.ts')
    expect(handlers).toMatch(/output=none keep-result=no/)
  })

it('exposes customer create and status changes, instead of discarding them', () => {
    // The Customers page destructured addClient/setClientStatus and then threw
    // them away with `void`, so an ISP could list customers but never create,
    // suspend or reactivate one - the backend was complete and unreachable.
    const panel = read('src/pages/isp/panel/index.tsx')
    const customers = /export function CustomersPage\(\) \{[\s\S]*?\n\}/.exec(panel)?.[0] ?? ''

    expect(customers, 'CustomersPage not found').not.toMatch(/void\s+setClientStatus/)
    expect(customers, 'CustomersPage not found').not.toMatch(/void\s+addClient/)

    // Both mutations must actually be invoked from this page.
    expect(customers).toMatch(/await addClient\(/)
    expect(customers).toMatch(/await setClientStatus\(/)

    // And the page must render the controls that trigger them.
    expect(customers).toMatch(/Add customer/)
    expect(customers).toMatch(/Reactivate/)
    expect(customers).toMatch(/Suspend/)

    // Success must come from the backend resolving, never an optimistic guess.
    expect(customers).toMatch(/catch\s*\(err\)/)
    expect(customers).not.toMatch(/formError.*success/i)
  })

  it('authenticates the telemetry poller, which was open to the internet', () => {
    const poll = code('supabase', 'functions', 'mikrotik-poll', 'index.ts')
    // Verified before the fix: an anonymous GET returned HTTP 200 and a summary
    // of every router in the platform, having decrypted each stored password.
    expect(poll).toMatch(/isAuthorised/)
    // The check must run inside the handler, before any read or write.
    const serve = poll.slice(poll.indexOf('Deno.serve'))
    const guardAt = serve.search(/if \(!\(await authorised\(req, admin\)\)\)/)
    const readsAt = serve.search(/from\('nodes'\)/)
    expect(guardAt, 'the poller must authenticate the caller').toBeGreaterThan(-1)
    expect(readsAt).toBeGreaterThan(-1)
    expect(guardAt, 'the guard must precede the first read')
      .toBeLessThan(readsAt)
    // 401, never a 200 with a sweep summary.
    expect(poll).toMatch(/status:\s*401/)
    // Compared in constant time, because it is a secret. The compare now lives
    // in the shared module so it can be unit tested under Node.
    expect(read('supabase', 'functions', '_shared', 'bearer-auth.ts'))
      .toMatch(/timingSafeEqual/)
    expect(code('supabase', 'functions', '_shared', 'bearer-auth.ts'))
      .not.toMatch(/\?\.find|indexOf|=== expected/i)
    // The scheduled caller must still be accepted. Comparing only against the
    // injected service key broke pg_cron silently: the poller returned 401
    // forever and every router slowly appeared offline.
    expect(poll).toMatch(/poller_config/)
  })

  it('never puts a server-only secret into the browser bundle', () => {
    const config = read('src', 'lib', 'config.ts')
    expect(config).not.toMatch(/SERVICE_ROLE|ROUTER_CREDENTIALS_KEY|APP_ENCRYPTION_KEY/)
    // The only credential the client holds is the anon key, and RLS decides what
    // that may do - which is why the RLS tests above are not optional.
    expect(config).toMatch(/VITE_SUPABASE_ANON_KEY/)
  })

  it('ships a working production build', () => {
    // Vercel builds `npm run build`, which is tsc --noEmit && vite build. A
    // broken build is a deployment failure, so the contract is asserted here.
    const pkg = JSON.parse(read('package.json'))
    expect(pkg.scripts.build).toBe('tsc --noEmit && vite build')
    // The framework is Vite, not Next: the Vercel output must match.
    const vercel = JSON.parse(read('vercel.json'))
    expect(vercel.outputDirectory).toBe('dist')
    expect(vercel.buildCommand).toBe('npm run build')
    // SPA rewrites, so a deep link like /app/settings/payments resolves.
    expect(JSON.stringify(vercel.rewrites)).toMatch(/index\.html/)
  })

  it('does not commit a filled-in environment file', () => {
    // .env.local holds the real anon key and must never be tracked.
    const ignored = read('.gitignore')
    expect(ignored).toMatch(/^\.env\.local/m)
    expect(ignored).toMatch(/^\.env\*?\.local/m)
  })

  it('still serialises concurrent deliveries of the same webhook', () => {
    const sql = code(...GRANT.split('/'))
    expect(sql).toMatch(/for\s+update/i)
  })
})

/**
 * The live-users panel used to read the `sessions` table, which is Supabase's
 * OAuth session store. It therefore rendered rows RADIUS never wrote, and a real
 * customer session could not appear at all. radius_sessions is the only store of
 * who is online; these assert the read model and the tenant boundary around it.
 */
describe('live network sessions come from radius_sessions', () => {
  const MODEL = 'supabase/migrations/20260101180000_my_radius_sessions.sql'
  const RLS = 'supabase/migrations/20260101190000_enable_rls_on_network_tables.sql'

  it('reads radius_sessions, never the OAuth sessions table', () => {
    const sql = code(...MODEL.split('/'))
    expect(sql).toMatch(/from\s+public\.radius_sessions\s+s/)
    // No second store, and no fallback to the OAuth table.
    expect(sql).not.toMatch(/from\s+public\.sessions\b/)
  })

  it('takes no isp_id a browser could supply to widen the query', () => {
    const sql = code(...MODEL.split('/'))
    // The ISP comes from auth.uid(). A parameter would be a tenant selector.
    // Asserted on the signature and the body, not the whole file: the comment on
    // the function deliberately says it "takes no isp_id".
    const sig = sql.slice(sql.indexOf('create or replace function public.my_radius_sessions'))
    const params = sig.slice(0, sig.indexOf('returns table'))
    expect(params).not.toMatch(/p_isp_id/)
    expect(sql).toMatch(/v_isp\s+uuid\s*:=\s*public\.current_isp_id\(\)/)
  })

  it('filters on the caller tenant', () => {
    const sql = code(...MODEL.split('/'))
    expect(sql).toMatch(/where\s+s\.isp_id\s*=\s*v_isp/)
  })

  it('reports a session active only when RADIUS says it has not ended', () => {
    const sql = code(...MODEL.split('/'))
    expect(sql).toMatch(/\(\s*s\.ended_at\s+is\s+null\s*\)\s+as\s+is_active/)
    // The row existing is not evidence of presence: a router that dies without
    // sending Acct-Stop leaves exactly such a row behind.
    expect(sql).not.toMatch(/as\s+is_active[\s\S]{0,80}started_at\s*>\s*now\(\)/i)
  })

  it('computes duration from the session clock, so a closed one stops growing', () => {
    const sql = code(...MODEL.split('/'))
    expect(sql).toMatch(/now\(\)\s*-\s*s\.started_at/i)
  })

  it('never exposes a router credential', () => {
    const sql = code(...MODEL.split('/'))
    // Asserted against the function body: the migration's own prose documents
    // that these columns exist and are deliberately not selected, so matching
    // the comment would fail the test for the wrong reason.
    const open = sql.indexOf('$$')
    const body = sql.slice(open, sql.indexOf('$$', open + 2))
    expect(body).not.toMatch(/password|secret|credential|api_key|encrypted/i)
    // The router name comes from a join, never from a credential column.
    expect(body).toMatch(/left join public\.nodes n on n\.id\s*=\s*s\.node_id/)
  })

  it('refuses rather than guessing when there is no ISP in scope', () => {
    const sql = code(...MODEL.split('/'))
    expect(sql).toMatch(/if\s+v_isp\s+is\s+null\s+then\s+raise\s+exception/)
  })

  it('is SECURITY DEFINER so the panel still reads it under RLS', () => {
    const sql = code(...MODEL.split('/'))
    expect(sql).toMatch(/security\s+definer/i)
    expect(sql).toMatch(/grant\s+execute[\s\S]{0,200}to\s+authenticated/i)
  })

  it('has RLS enabled on the tables that were readable by everyone', () => {
    const sql = code(...RLS.split('/'))
    for (const t of ['radius_sessions', 'radius_nas', 'platform_admins', 'platform_settings']) {
      expect(sql, `${t} not covered`).toContain(`alter table public.${t} enable row level security`)
    }
  })

  it('scopes session and router reads to the owning tenant', () => {
    const sql = code(...RLS.split('/'))
    expect(sql).toMatch(/using\s*\(\s*isp_id\s*=\s*public\.current_isp_id\(\)/)
  })

  it('reserves platform tables for super admins only', () => {
    const sql = code(...RLS.split('/'))
    const admins = sql.slice(sql.indexOf('platform_admins enable'))
    expect(admins).toMatch(/using\s*\(\s*public\.is_super_admin\(\)\s*\)/)
    const settings = sql.slice(sql.indexOf('platform_settings enable'))
    expect(settings).toMatch(/using\s*\(\s*public\.is_super_admin\(\)\s*\)/)
  })

  it('adds no browser write path to the session record', () => {
    const sql = code(...RLS.split('/'))
    // A policy for insert/update would let an ISP fabricate usage evidence.
    expect(sql).not.toMatch(/for\s+(insert|update|delete)/)
  })

  it('is reflected in the live database, not only in the migration', async () => {
    // The migration above proves the intent; this proves the posture is real.
    // Local and CI runs have no project to ask, so they skip rather than lie.
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_ANON_KEY) return
    const { createClient } = await import('@supabase/supabase-js')
    const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY,
      { auth: { persistSession: false } })
    const { data, error } = await sb.rpc('unprotected_selectable_tables')
    expect(error, error?.message).toBeNull()
    expect(data ?? []).toEqual([])
  })

  it('never reads network sessions from the OAuth sessions table', () => {
    // `sessions` is Supabase's browser-token store. Using it for ISP network
    // sessions is the defect this whole path existed to correct.
    expect(code('src', 'lib', 'data.ts')).not.toMatch(/tenantTable\('sessions'/)
    expect(code('src', 'lib', 'network.ts')).not.toMatch(/from\('sessions'\)/)
  })
})
})

describe('the live-users panel never invents session data', () => {
  it('takes live sessions from the RADIUS read model, not the OAuth table', () => {
    const data = code('src', 'lib', 'data.ts')
    expect(data).toMatch(/rpc\('my_radius_sessions'/)
    const block = data.slice(data.indexOf('export async function fetchSessions'))
    expect(block).not.toMatch(/tenantTable\('sessions'/)
  })

  it('reports no MAC address rather than fabricating one', () => {
    const data = code('src', 'lib', 'data.ts')
    const block = data.slice(data.indexOf('export async function fetchSessions'))
    expect(block).toMatch(/mac_address:\s*null/)
    expect(code('src', 'lib', 'adapters.ts')).toMatch(/Not reported by RADIUS/)
  })

  it('marks a session inactive only on ended_at, never on row existence', () => {
    expect(code('src', 'lib', 'adapters.ts'))
      .toMatch(/is_active\s*\?\?\s*s\.ended_at\s*===\s*null/)
  })

  it('disconnects through the tenant-scoped RPC, never a direct router call', () => {
    const network = code('src', 'lib', 'network.ts')
    // Sliced to the function's own body, up to the next top-level declaration.
    // etchRouterJobs legitimately reads router_jobs; this one must not.
    const start = network.indexOf('export async function disconnectLiveSession')
    const fn = network.slice(start, network.indexOf('/** Recent jobs', start))
    expect(fn).toMatch(/rpc\('request_session_disconnect'/)
    // The browser must not be able to name a router or a tenant.
    expect(fn).not.toMatch(/enqueue_router_job/)
    expect(fn).not.toMatch(/from\('router_jobs'\)/)
  })

  it('does not report a router-confirmed disconnect it was not told about', () => {
    const network = code('src', 'lib', 'network.ts')
    // Sliced to the function's own body, up to the next top-level declaration.
    // etchRouterJobs legitimately reads router_jobs; this one must not.
    const start = network.indexOf('export async function disconnectLiveSession')
    const fn = network.slice(start, network.indexOf('/** Recent jobs', start))
    // confirmed may only become true from the worker's own command row.
    expect(fn).toMatch(/confirmed:\s*row\.status\s*===\s*'confirmed'/)
    expect(fn).toMatch(/ROUTER CONFIRMATION UNAVAILABLE/)
  })

  it('disables the Kick action for an ended session', () => {
    const panel = code('src', 'components', 'AdminDashboard.tsx')
    expect(panel).toMatch(/disabled=\{!s\.canDisconnect\}/)
    expect(panel).toMatch(/s\.username/)
  })
})