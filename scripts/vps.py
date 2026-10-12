"""Minimal, secret-safe SSH command runner for the ISP billing VPS.

Credentials are read from environment variables ONLY (never hardcoded, never
written to disk, never committed):

    VPS_HOST  (default 87.76.137.72)
    VPS_USER  (default root)
    VPS_PASS  (required)

Usage:
    python scripts/vps.py "<remote shell command>"

Stdout is streamed to this process's stdout; the remote command's exit code is
propagated. The password is never printed.
"""

import io
import os
import sys

import paramiko

# Force UTF-8 on stdout/stderr so box-drawing / status glyphs from the remote
# shell never crash on a cp1252 Windows console.
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", errors="replace")


def main() -> int:
    host = os.environ.get("VPS_HOST", "87.76.137.72")
    user = os.environ.get("VPS_USER", "root")
    password = os.environ.get("VPS_PASS")
    if not password:
        print("VPS_PASS env var is required", file=sys.stderr)
        return 2

    # The remote command may be passed inline, or via a file (--file <path>)
    # whose contents are executed as a single bash script. The file form avoids
    # PowerShell/cmd quoting problems for anything non-trivial.
    args = sys.argv[1:]
    if args and args[0] == "--file":
        if len(args) < 2:
            print("--file requires a path", file=sys.stderr)
            return 2
        with open(args[1], "r", encoding="utf-8") as fh:
            remote_cmd = fh.read()
    else:
        remote_cmd = args[0] if args else "true"

    client = paramiko.SSHClient()
    # The host is a single operator-controlled server; accept its host key on
    # first contact. This avoids a manual known_hosts prompt in automation.
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    try:
        client.connect(
            host,
            username=user,
            password=password,
            timeout=30,
            look_for_keys=False,
            allow_agent=False,
        )
        _stdin, stdout, stderr = client.exec_command(remote_cmd, timeout=600)
        out = stdout.read().decode("utf-8", "replace")
        err = stderr.read().decode("utf-8", "replace")
        rc = stdout.channel.recv_exit_status()
        if out:
            sys.stdout.write(out)
        if err:
            sys.stderr.write(err)
        return rc
    finally:
        client.close()


if __name__ == "__main__":
    raise SystemExit(main())
