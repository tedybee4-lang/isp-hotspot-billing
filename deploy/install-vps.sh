#!/usr/bin/env bash
# =============================================================================
#  NETISP Network Worker — VPS installation.
#
#  Installs the worker, FreeRADIUS and the systemd unit on a Debian/Ubuntu LTS
#  host. Safe to re-run: every step is idempotent.
#
#  Usage:
#      sudo ./install-vps.sh                  # install worker + RADIUS
#      sudo ./install-vps.sh --with-wireguard # also prepare WireGuard
#      sudo ./install-vps.sh --uninstall      # remove the service
#
#  What it deliberately does NOT do:
#    * write a service-role key anywhere (you supply it)
#    * open a port to the whole internet
#    * touch a router
#
#  Ports, and why each is needed:
#
#    UDP 1812  RADIUS authentication. Routers send Access-Request here.
#    UDP 1813  RADIUS accounting.   Routers send Acct-Start/Stop/Interim here.
#
#  Both are opened only for private source ranges, never from 0.0.0.0. An
#  internet-exposed RADIUS server is a credential oracle: the shared secret
#  protects the packets, not the server, and anyone who can send it a packet can
#  try passwords.
#
#  The worker's health port (9090) stays bound to 127.0.0.1. Nothing about the
#  worker needs public ingress.
# =============================================================================

set -euo pipefail

APP_USER=netisp-worker
APP_DIR=/opt/netisp-worker
CONF_DIR=/etc/netisp-worker
UNIT_PATH=/etc/systemd/system/netisp-worker.service
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
WORKER_SRC="$REPO_ROOT/worker"

log()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!!\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31mxx\033[0m %s\n' "$*" >&2; exit 1; }

require_root() { [[ "${EUID}" -eq 0 ]] || die "Run as root: sudo $0"; }

check_os() {
  [[ -r /etc/os-release ]] || die "Cannot identify the OS."
  # shellcheck disable=SC1091
  . /etc/os-release
  case "${ID:-}" in
    ubuntu|debian) log "Detected ${PRETTY_NAME:-Debian/Ubuntu}" ;;
    *) warn "This script targets Debian/Ubuntu. Continuing on ${ID:-unknown}." ;;
  esac
  command -v apt-get >/dev/null || die "apt-get is required."
}

check_node() {
  # The worker uses modern ESM and top-level await. An old runtime fails later
  # and more confusingly than it does here.
  local major
  major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  [[ "$major" -ge 20 ]] || die "Node 20 or newer is required. Found: ${major:-none}"
  log "Node $(node -v)"
}

install_node() {
  if command -v node >/dev/null; then check_node; return; fi
  log "Installing Node.js 22 from NodeSource"
  install -d -m 0755 /etc/apt/keyrings
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
    | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg
  echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main" \
    > /etc/apt/sources.list.d/nodesource.list
  apt-get update -qq
  apt-get install -y --no-install-recommends nodejs
  check_node
}

install_packages() {
  log "Installing system packages"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y --no-install-recommends \
    ca-certificates curl gnupg \
    freeradius freeradius-common \
    freeradius-postgresql \
    wireguard-tools iproute2 logrotate
  # freeradius-postgresql is NOT optional and NOT included in `freeradius`.
  # It ships rlm_sql_pgsql.so, the driver this deployment uses. Without it
  # `driver = "pgsql"` cannot be loaded, the sql module silently fails to
  # instantiate, and NONE of its functions are registered -- so every
  # sql_query()/sql_load_accounts() in the policy becomes an unknown symbol and
  # FreeRADIUS refuses to start with, misleadingly:
  #   Parse error after "sql_query": unexpected token "("
  # which reads like a policy syntax error and is not one.
  log "FreeRADIUS $(dpkg-query -W -f='${Version}' freeradius 2>/dev/null || echo unknown)"
}

create_service_user() {
  if id -u "$APP_USER" >/dev/null 2>&1; then
    log "Service account $APP_USER already exists"
  else
    log "Creating unprivileged service account $APP_USER"
    useradd --system --no-create-home --shell /usr/sbin/nologin "$APP_USER"
  fi
}

install_worker() {
  [[ -d "$WORKER_SRC" ]] || die "Worker source not found at $WORKER_SRC"

  log "Installing worker to $APP_DIR"
  install -d -m 0755 -o "$APP_USER" -g "$APP_USER" "$APP_DIR"

  # Build in a staging directory and swap the result into place only on success.
  # Installing over a running worker leaves it reading files being rewritten
  # underneath it, which produces failures that look like network problems.
  local stage
  stage="$(mktemp -d)"

  log "Installing build dependencies (this takes a minute)"
  cp -r "$WORKER_SRC"/package*.json "$stage"/
  cp "$WORKER_SRC"/build.mjs "$stage"/
  mkdir -p "$stage"/public
  cp -r "$REPO_ROOT"/public/hotspot "$stage"/public/
  # Dev dependencies ARE installed here, deliberately. The type-check below needs
  # @types/node, and a prod-only install makes it fail with dozens of
  # "Cannot find name 'process'" / "Cannot find module 'node:os'" errors that
  # look like source defects but are really a missing dev dependency. The tree
  # is pruned back to production-only before anything is copied into place.
  ( cd "$stage" && npm ci --no-audit --no-fund )

  log "Type-checking against the shared library"
  # The layout below is not cosmetic. worker/src/session.ts imports
  # '../../supabase/functions/_shared/session.ts', and `..` twice from
  # <root>/worker/src lands on <root> — the directory that holds `supabase/`.
  # Copying src to the stage root instead puts it one level too shallow, so `..`
  # twice escapes the stage entirely and esbuild reports
  # "Could not resolve ../../supabase/functions/_shared/session.ts".
  # Preserving the worker/ segment is what makes the relative import land.
  mkdir -p "$stage"/worker "$stage"/supabase/functions
  cp -r "$WORKER_SRC"/src "$stage"/worker/
  cp -r "$REPO_ROOT"/supabase/functions/_shared "$stage"/supabase/functions/
  # The worker typechecks against _shared and its own tsconfig excludes the
  # Deno-only Edge Function entry points.
  #
  # `npx -p typescript@5.9.3 tsc`, not `npx typescript@5.9.3`: the typescript
  # package installs its binary as `tsc`, so npx given the bare package name
  # cannot determine an executable to run and aborts the install with
  # "could not determine executable to run".
  ( cd "$stage" && npx --yes -p typescript@5.9.3 tsc \
      --module esnext --moduleResolution bundler --target es2022 \
      --strict --skipLibCheck --noEmit --allowImportingTsExtensions \
      --lib es2023,dom worker/src/assets.d.ts worker/src/index.ts )

  # The worker bundle embeds the portal files as raw text. Keep the scoped
  # esbuild plugin in build.mjs; a global .js text loader would break dependencies.
  #
  # Output is CommonJS on a `.cjs` extension. Two traps, both of which produce a
  # bundle that builds cleanly and then dies at startup:
  #
  #   1. worker/package.json declares "type": "module", so a `.js` CommonJS
  #      bundle is loaded as ESM and fails with "require is not defined in ES
  #      module scope". Naming the file `.cjs` makes the extension authoritative.
  #   2. The previous ESM build needed a `--banner:js` shim to define `require`.
  #      That is a quoted shell argument; when the quotes are lost the build still
  #      succeeds and the process dies with "Unexpected identifier 'fromnode'".
  #      Nothing in worker/src uses import.meta or require, so the shim is gone.
  log "Building"
  ( cd "$stage" && node build.mjs )

  # Drop the build-only tree before it reaches the server. The worker runs as an
  # unprivileged service account and has no reason to carry a compiler or type
  # declarations on a 1 GB VPS.
  log "Pruning build dependencies"
  ( cd "$stage" && npm prune --omit=dev --no-audit --no-fund )

  rm -rf "${APP_DIR:?}/dist" "${APP_DIR:?}/node_modules"
  cp -r "$stage/dist" "$APP_DIR"/
  cp -r "$stage/node_modules" "$APP_DIR"/
  chown -R "$APP_USER:$APP_USER" "$APP_DIR"
  rm -rf "$stage"

  log "Worker installed: $(du -sh "$APP_DIR" | cut -f1)"
}

install_config() {
  install -d -m 0750 -o root -g "$APP_USER" "$CONF_DIR"

  if [[ -f "$CONF_DIR/environment" ]]; then
    log "Keeping the existing $CONF_DIR/environment"
    return
  fi

  [[ -f "$WORKER_SRC/.env.example" ]] || die "worker/.env.example is missing."
  install -m 0640 -o root -g "$APP_USER" "$WORKER_SRC/.env.example" \
    "$CONF_DIR/environment"
  warn "Edit $CONF_DIR/environment and fill in SUPABASE_URL,"
  warn "SUPABASE_SERVICE_ROLE_KEY and ROUTER_CREDENTIALS_KEY before starting."
}

install_unit() {
  local unit_src="$SCRIPT_DIR/netisp-worker.service"
  [[ -f "$unit_src" ]] || die "netisp-worker.service not found next to this script."
  log "Installing systemd unit"
  install -m 0644 "$unit_src" "$UNIT_PATH"
  systemctl daemon-reload
}

install_freeradius() {
  local dir=/etc/freeradius/3.0

  log "Installing FreeRADIUS configuration"
  install -d -m 0755 "$dir/mods-available/netisp"

  # The prepared statements the policy calls.
  install -m 0644 "$SCRIPT_DIR/freeradius/queries.conf" \
    "$dir/mods-available/netisp/queries.conf"

  if [[ -f "$dir/clients.conf" ]] && grep -Fq 'ISPFlow - FreeRADIUS clients.' "$dir/clients.conf"; then
    log "Keeping the existing FreeRADIUS clients (router definitions)"
  else
    install -m 0644 "$SCRIPT_DIR/freeradius/clients.conf" "$dir/clients.conf"
  fi
  if [[ -f "$dir/sql.conf" ]] && grep -Fq 'ISPFlow - FreeRADIUS sql module configuration.' "$dir/sql.conf"; then
    log "Keeping the existing FreeRADIUS SQL credentials"
  else
    install -m 0640 "$SCRIPT_DIR/freeradius/sql.conf" "$dir/sql.conf"
  fi

  # The dictionary goes in the confdir itself, NOT /usr/share/freeradius.
  # `$INCLUDE dictionary.netisp` in $dir/dictionary resolves relative to $dir, so
  # a copy under /usr/share is never found and FreeRADIUS aborts at startup with
  #   Couldn't open dictionary ".../3.0/dictionary.netisp": No such file
  install -m 0644 -o root -g freerad "$SCRIPT_DIR/freeradius/dictionary.netisp" \
    "$dir/dictionary.netisp"

  # radiusd.conf is NOT replaced.
  #
  # An earlier version installed the repository's radiusd.conf over the
  # packaged one. That file is a partial config: it has no `modules { }`
  # section, no `$INCLUDE sites-enabled/`, and it references modules as
  # ${modconfdir}/name, which FreeRADIUS 3.2.5 does not expand ("Parse error
  # after modconfdir"). The result was a server that started, bound UDP 1812,
  # and looked healthy while running no authorize section, no accounting
  # listener and no modules at all.
  #
  # The packaged radiusd.conf is correct and complete. Only targeted edits are
  # applied, and only the ones that matter for an ISP deployment. Anything the
  # repo genuinely needs to change goes in a drop-in, not in a wholesale
  # replacement.
  log "Applying ISPFlow settings to the packaged radiusd.conf"
  if [[ ! -f "$dir/radiusd.conf" ]]; then
    die "radiusd.conf missing; is the freeradius package installed?"
  fi
  # Passwords must never be logged, whatever the default is.
  sed -i 's/^\([[:space:]]*\)auth_goodpass[[:space:]]*=.*/\1auth_goodpass = no/' \
    "$dir/radiusd.conf"
  sed -i 's/^\([[:space:]]*\)auth_badpass[[:space:]]*=.*/\1auth_badpass = no/' \
    "$dir/radiusd.conf"
  # RouterOS 6 on some hardware advertises IPv6 without a usable WAN address,
  # which produces accepts that silently drop their replies.
  sed -i 's/^\([[:space:]]*\)ipv6[[:space:]]*=.*/\1ipv6 = no/' "$dir/radiusd.conf"

  # The dictionaries must be referenced or the attributes are silently dropped.
  #
  # On a stock install both files exist on disk and NOTHING references them, so
  # every Mikrotik-* attribute is treated as unknown and never appears in an
  # Access-Accept -- the usual reason "Mikrotik-Rate-Limit works in the lab but
  # not in production".
  #
  # dictionary.mikrotik is FreeRADIUS's own, shipped in /usr/share/freeradius.
  # `$INCLUDE` resolves relative to the file that contains it, so the bare name
  # is looked for in /etc/freeradius/3.0/ where it does not exist. The absolute
  # path is required. It must not be copied or extended: redeclaring
  # Mikrotik-Rate-Limit aborts startup with "Duplicate attribute name".
  # Normalise the dictionary's INCLUDE lines with Python rather than chained
  # `sed`. Chained sed with nested quoting is how a stray line containing just
  # `d` ended up in this file, which FreeRADIUS then rejected with
  # "dictionary[2]: invalid entry".
  log "Referencing dictionary.mikrotik and dictionary.netisp"
  install -m 0644 -o root -g freerad /usr/share/freeradius/dictionary.mikrotik \
    "$dir/dictionary.mikrotik"
  python3 - "$dir" <<'PYEOF'
import os, re, sys
confdir = sys.argv[1]
p = os.path.join(confdir, 'dictionary')
lines = open(p, encoding='utf-8', errors='replace').read().split('\n')

wanted = ['$INCLUDE dictionary.mikrotik', '$INCLUDE dictionary.netisp']
out = []
for line in lines:
    st = line.strip()
    # Drop any previous attempt at these includes, in any form, plus debris
    # from an earlier failed edit.
    if st in wanted:
        continue
    if 'dictionary.mikrotik' in st or 'dictionary.netisp' in st:
        continue
    if st == 'd':
        continue
    out.append(line)

out = wanted + out
open(p, 'w', encoding='utf-8').write('\n'.join(out))
print('  dictionary includes normalised')
PYEOF
  if ! grep -q 'dictionary.netisp' "$dir/dictionary"; then
    log "Referencing dictionary.netisp"
    sed -i '1i $INCLUDE dictionary.netisp' "$dir/dictionary"
  fi

  # ── Inline the policy ───────────────────────────────────────────────────────
  #
  # The netisp policy is spliced INTO the site's own sections, not loaded as a
  # module. FreeRADIUS 3.2.5 rejects a top-level `if` in every other context,
  # each verified on the host:
  #
  #     mods-enabled/netisp-authorize -> "Invalid location for 'if'"
  #     policy.d/netisp-authorize     -> "Invalid location for 'if'"
  #     $INCLUDE sites-available/...  -> "Invalid location for 'if'"
  #
  # A module file is instantiated, and a policy.d or $INCLUDEd file is parsed as
  # a standalone unit; none of them is a site section, and `if` is only valid
  # inside one.
  log "Inlining ISPFlow policy into the site"
  python3 - "$dir" "$SCRIPT_DIR" <<'PYEOF'
import os, re, sys
confdir, srcdir = sys.argv[1], sys.argv[2]
site = os.path.join(confdir, 'sites-available', 'default')

BEGIN = '# >>> netisp inline policy'
END = '# <<< netisp inline policy'

def strip_blocks(text):
    """Remove every previously-inserted block, whole, before inserting again.

    Stripping only the BEGIN marker is not enough: the body survives and the next
    insert duplicates it. On a re-run that produced a dozen copies of the same
    policy in one section and every subsequent statement failed to parse.
    """
    while BEGIN in text:
        i = text.index(BEGIN)
        j = text.index(END, i) + len(END)
        text = (text[:i] + text[j:]).strip('\n')
    # Debris from earlier failed edits.
    text = '\n'.join(l for l in text.split('\n') if l.strip() != 'd')
    return text

def insert(text, section, policy):
    marker = '\n%s {' % section
    idx = text.find(marker)
    if idx < 0:
        raise SystemExit('site has no %s section' % section)
    brace = text.find('{', idx) + 1
    block = '\n\t%s\n%s\n\t%s\n' % (BEGIN, policy.rstrip(), END)
    return text[:brace] + block + text[brace:]

text = strip_blocks(open(site, encoding='utf-8', errors='replace').read())

for section, fname in (('authorize', 'authorize'),
                       ('post-auth', 'session-open'),
                       ('accounting', 'post-auth')):
    policy = open(os.path.join(srcdir, 'freeradius', fname),
                  encoding='utf-8', errors='replace').read()
    text = insert(text, section, policy)

open(site, 'w', encoding='utf-8').write(text)
n = text.count(BEGIN)
print('  netisp policy inlined into %d sections (authorize, post-auth, accounting)'
      % n)
if n != 3:
    raise SystemExit('expected exactly 3 inlined blocks, found %d' % n)
PYEOF

  # Link every module radiusd.conf references.
  #
  # A name present in mods-available but missing from mods-enabled is a dangling
  # reference, and FreeRADIUS treats that as a hard parse error that stops the
  # service starting. Ubuntu enables most by default but NOT cache.
  log "Linking RADIUS modules"
  local m
  for m in cache pap chap mschap sql files; do
    if [[ -e "$dir/mods-available/$m" ]]; then
      ln -sfn "../mods-available/$m" "$dir/mods-enabled/$m"
    else
      warn "mods-available/$m not found; radiusd.conf references it"
    fi
  done

  # The sql module config is REPLACED with the minimal form that defers to
  # sql.conf.
  #
  # The packaged mods-available/sql is a fully populated sample carrying
  #   driver = "rlm_sql_null"
  #   sqlite { ... }
  # and it never reads sql.conf at all. The database credentials therefore never
  # reach the module: it runs on the null driver, and the sql functions the
  # authorize policy calls are not registered, which is what produced
  #   Parse error after "sql_load_accounts": unexpected token "("
  # The two-line form below is the documented way to point the module at the
  # real configuration.
  log "Pointing the sql module at sql.conf"
  # Written with python rather than a heredoc so this function contains no line
  # beginning with `}`, which breaks tools that extract it by brace matching.
  #
  # The path is LITERAL. FreeRADIUS 3.2.5 does not expand ${confdir} in a module
  # reference -- the same limitation that makes ${modconfdir}/name unusable in
  # radiusd.conf -- and an unexpanded variable silently leaves the module with no
  # configuration, so it never instantiates and none of its functions are
  # registered.
  python3 - "$dir" <<'PYEOF'
import os, sys
confdir = sys.argv[1]
body = """# NETPID: minimal sql module configuration.
#
# Everything real lives in sql.conf, installed mode 0640 because it holds the
# database password and the RADIUS host key. This file itself carries no
# credentials and can stay world-readable.
#
# The path below is deliberately literal rather than ${confdir}/sql.conf.
# FreeRADIUS 3.2.5 does not expand variables in a module reference; an
# unexpanded path leaves the module unconfigured, it never instantiates, and
# every sql function the policy calls becomes an unknown symbol.
sql {
    sqlconf = %s/sql.conf
}
""" % confdir
d = os.path.join(confdir, 'mods-available', 'netisp')
os.makedirs(d, exist_ok=True)
open(os.path.join(d, 'sql-module'), 'w', encoding='utf-8').write(body)
PYEOF
  # Replace the symlink with this file so `$INCLUDE mods-enabled/` picks it up.
  rm -f "$dir/mods-enabled/sql"
  install -m 0644 -o root -g freerad "$dir/mods-available/netisp/sql-module" \
    "$dir/mods-enabled/sql"

  warn "Edit $dir/sql.conf: set the database connection and the RADIUS host key."
}

configure_firewall() {
  if ! command -v ufw >/dev/null; then
    warn "ufw is not installed; the firewall was left untouched."
    warn "With another firewall, allow UDP 1812/1813 from your routers only."
    return
  fi

  log "Opening RADIUS for private source ranges only"
  # Deliberately never 'ufw allow 1812/udp' with no source. See the header.
  for cidr in 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16; do
    ufw allow from "$cidr" to any port 1812 proto udp comment 'NETISP RADIUS auth'
    ufw allow from "$cidr" to any port 1813 proto udp comment 'NETISP RADIUS acct'
  done

  # Health is loopback-only, so there is genuinely nothing to open.
  ufw allow from 127.0.0.1 to any port 9090 proto tcp comment 'NETISP worker health'
  log "Worker health (9090) is reachable from localhost only."
}

install_wireguard() {
  log "Preparing WireGuard for routers behind CGNAT"
  install -d -m 0700 /etc/wireguard

  if [[ ! -f /etc/wireguard/netisp.key ]]; then
    log "Generating the server key pair"
    umask 077
    wg genkey | tee /etc/wireguard/netisp.key > /dev/null
    wg pubkey < /etc/wireguard/netisp.key > /etc/wireguard/netisp.pub
    chmod 0600 /etc/wireguard/netisp.key
  fi

  # The interface config is left for a human to fill in: an unattended install
  # must not invent a listen port or a subnet that collides with the ISP's own.
  if [[ ! -f /etc/wireguard/netisp.conf ]]; then
    install -m 0600 "$SCRIPT_DIR/wireguard/netisp.conf.template" /etc/wireguard/netisp.conf
    warn "Edit /etc/wireguard/netisp.conf: set ListenPort and the Address line."
  fi

  warn "Then: systemctl enable --now wg-quick@netisp"
  warn "Server public key: $(cat /etc/wireguard/netisp.pub)"
  warn "router-provision writes the router side automatically."
}

start_services() {
  log "Enabling and starting the worker"
  systemctl enable --now netisp-worker

  if systemctl is-active --quiet freeradius; then
    log "FreeRADIUS already running"
  else
    systemctl enable --now freeradius \
      || warn "FreeRADIUS failed to start; see journalctl -u freeradius"
  fi
}

verify() {
  log "Verifying the installation"

  if ! systemctl is-active --quiet netisp-worker; then
    warn "The worker is not running. Diagnostics:"
    warn "  journalctl -u netisp-worker -n 50 --no-pager"
    return 1
  fi
  log "netisp-worker: running"

  # The health endpoint is loopback-bound. Probing it locally is the only
  # correct check; there is no public endpoint to hit.
  local port="${WORKER_HEALTH_PORT:-9090}"
  sleep 3
  if curl -fsS --max-time 5 "http://127.0.0.1:${port}/health" > /dev/null; then
    log "health endpoint: responding on 127.0.0.1:${port}"
  else
    warn "health endpoint did not answer on 127.0.0.1:${port}"
  fi

  # RADIUS is UDP. curl or nc over TCP would prove nothing, so the check here is
  # only that the sockets exist.
  if ss -lun | grep -qE ':(1812|1813)\b'; then
    log "RADIUS listening on UDP 1812/1813"
  else
    warn "RADIUS sockets not found. Check: journalctl -u freeradius"
  fi
  return 0
}

uninstall() {
  log "Stopping and removing the worker"
  systemctl disable --now netisp-worker 2>/dev/null || true
  rm -f "$UNIT_PATH"
  systemctl daemon-reload
  # This directory holds the service-role key, so it is removed explicitly
  # rather than left for the next person to find.
  warn "Removing $CONF_DIR (contains the service-role key)"
  rm -rf "$CONF_DIR"
  log "Worker removed. FreeRADIUS, WireGuard and the application were left alone."
}

main() {
  require_root
  local with_wg=false do_uninstall=false
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --with-wireguard) with_wg=true ;;
      --uninstall)     do_uninstall=true ;;
      -h|--help)
        sed -n '2,28p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
        exit 0 ;;
      *) die "Unknown option: $1" ;;
    esac
    shift
  done

  if $do_uninstall; then uninstall; exit 0; fi

  check_os
  install_node
  install_packages
  create_service_user
  install_worker
  install_config
  install_unit
  install_freeradius
  configure_firewall
  $with_wg && install_wireguard

  start_services
  verify

  cat <<'EOF'

Next steps
----------
1. Edit /etc/netisp-worker/environment — SUPABASE_URL,
   SUPABASE_SERVICE_ROLE_KEY and ROUTER_CREDENTIALS_KEY.

   ROUTER_CREDENTIALS_KEY must match the value on the Supabase Edge Functions,
   or the worker cannot decrypt any router password:

       supabase secrets set ROUTER_CREDENTIALS_KEY=<same value>

2. Edit /etc/freeradius/3.0/sql.conf with the database connection.

3. systemctl restart netisp-worker

4. Confirm the worker appears under Network → Network Status in ISPFlow.

Verify RADIUS from this host. It is UDP, so use radtest — not curl:

    radtest <router-ip> <username> <password>

EOF
}

main "$@"
