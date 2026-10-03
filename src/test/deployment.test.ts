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
    const installer = read('deploy', 'install-vps.sh')
    const unit = read('deploy', 'netisp-worker.service')

    // package.json declares "type": "module", so a CommonJS bundle written to
    // dist/index.js is loaded as ESM and throws "require is not defined in ES
    // module scope". The extension has to be .cjs.
    expect(pkg).toMatch(/--outfile=dist\/index\.cjs/)
    expect(installer).toMatch(/--outfile=dist\/index\.cjs/)
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
})