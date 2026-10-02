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
    wireguard-tools iproute2 logrotate
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

  log "Installing production dependencies (this takes a minute)"
  cp -r "$WORKER_SRC"/package*.json "$stage"/
  ( cd "$stage" && npm ci --omit=dev --no-audit --no-fund )

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
  ( cd "$stage" && npx --yes typescript@5.9.3 \
      --module esnext --moduleResolution bundler --target es2022 \
      --strict --skipLibCheck --noEmit --allowImportingTsExtensions \
      --lib es2023,dom worker/src/index.ts )

  # The repo's tsconfig is noEmit, so the worker is transpiled with esbuild.
  # esbuild is installed explicitly because it is only a dev dependency today
  # and the runtime install omits dev dependencies.
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
  ( cd "$stage" && npm i --no-save --no-audit --no-fund esbuild@0.25.0 \
      && npx esbuild worker/src/index.ts --bundle --platform=node --format=cjs \
        --target=node20 --outfile=dist/index.cjs )

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

  # Two small modules rather than a rewrite of FreeRADIUS: authorize answers
  # "may this subscriber in, and at what speed", post-auth closes the accounting
  # loop back to the platform. Both read the platform's own tables.
  install -m 0644 "$SCRIPT_DIR/freeradius/authorize" "$dir/mods-available/netisp/authorize"
  install -m 0644 "$SCRIPT_DIR/freeradius/post-auth"   "$dir/mods-available/netisp/post-auth"
  # The prepared statements the modules call. Installed under modconfdir rather
  # than next to sql.conf, because sql.conf references it by that path.
  install -m 0644 "$SCRIPT_DIR/freeradius/queries.conf" "$dir/mods-available/netisp/queries.conf"

  # symlink -f so a re-run replaces a stale copy rather than failing.
  ln -sfn ../mods-available/netisp/authorize "$dir/mods-enabled/netisp-authorize"
  ln -sfn ../mods-available/netisp/post-auth   "$dir/mods-enabled/netisp-post-auth"

  install -m 0644 "$SCRIPT_DIR/freeradius/clients.conf" "$dir/clients.conf"
  install -m 0640 "$SCRIPT_DIR/freeradius/sql.conf"    "$dir/sql.conf"
  install -m 0644 "$SCRIPT_DIR/freeradius/radiusd.conf" "$dir/radiusd.conf"
  install -m 0644 "$SCRIPT_DIR/freeradius/dictionary.netisp" \
    /usr/share/freeradius/dictionary.netisp

  # Enable both in the default virtual server, once. grep guards the re-run.
  if ! grep -q 'netisp-authorize' "$dir/sites-available/default"; then
    sed -i '1i netisp-authorize\nnetisp-post-auth' "$dir/sites-available/default"
  fi

  warn "Edit $dir/sql.conf: set readall_group_file and the database"
  warn "connection to match your Supabase Postgres instance."
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
