#!/usr/bin/env bash
# =============================================================================
#  run-vps-check.sh - run a bundled check on the VPS without stranding a service.
#
#  Live checks stop services: FreeRADIUS to get a debug log, the worker to get
#  exclusive use of the job queue. Every one of those stops used to be undone
#  only on the happy path, and an exception in between left production
#  authentication - or the worker - down. This script makes the restore the
#  shell's job instead of the check's:
#
#    * the ORIGINAL state of each named service is recorded first, and that is
#      what gets restored, so a deliberately stopped service stays stopped
#    * the restore runs from an EXIT trap, so it happens on success, on error,
#      and on SIGINT/SIGTERM/SIGHUP
#    * the restore is verified, and a failure is loud
#    * secrets are sourced from the env file and never echoed
#
#  Usage:
#    run-vps-check.sh <service>[,<service>...] <node-script> [args...]
#
#  Example:
#    run-vps-check.sh netisp-worker /tmp/check-network-job.cjs
# =============================================================================
set -uo pipefail

if [ "$#" -lt 2 ]; then
  echo "usage: $0 <service>[,<service>...] <node-script> [args...]" >&2
  exit 2
fi

SERVICES="${1%%,*}"
SCRIPT="$2"
shift 2

# -- record the baseline BEFORE anything is changed ----------------------------
declare -a BASELINE=()
IFS=',' read -r -a UNITS <<< "$SERVICES"
for unit in "${UNITS[@]}"; do
  state="$(systemctl is-active "$unit" 2>/dev/null || true)"
  case "$state" in
    active|inactive|failed|activating) BASELINE+=("$unit=$state") ;;
    *) BASELINE+=("$unit=inactive") ;;
  esac
done

restore() {
  local rc=$?
  local failed=0
  for entry in "${BASELINE[@]}"; do
    unit="${entry%%=*}"
    want="${entry#*=}"
    if [ "$want" = "active" ]; then
      systemctl start "$unit" || failed=1
    else
      systemctl stop "$unit" || failed=1
    fi
  done
  sleep 3
  for entry in "${BASELINE[@]}"; do
    unit="${entry%%=*}"
    want="${entry#*=}"
    now="$(systemctl is-active "$unit" 2>/dev/null || true)"
    if [ "$now" != "$want" ]; then
      echo "GUARD: $unit is $now but baseline was $want; run 'systemctl ${want/active/start} $unit'" >&2
      failed=1
    fi
  done
  [ "$failed" -eq 0 ] && echo "GUARD: all services restored to baseline"
  return $rc
}
trap restore EXIT INT TERM HUP

# -- stop the services the check needs exclusive use of -----------------------
for entry in "${BASELINE[@]}"; do
  unit="${entry%%=*}"
  if [ "${entry#*=}" = "active" ]; then
    echo "GUARD: stopping $unit (was active)"
    systemctl stop "$unit"
  fi
done

# -- run ---------------------------------------------------------------------
# The env file is sourced, never echoed: it holds the service role key and the
# router credential key. set -a exports them to the child only.
ENV_FILE="${NETISP_ENV_FILE:-/etc/netisp-worker/environment}"
if [ -r "$ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
  echo "GUARD: environment sourced from $ENV_FILE (values not printed)"
else
  echo "GUARD: no readable env file at $ENV_FILE" >&2
  exit 2
fi

node "$SCRIPT" "$@"