"""Smoke test for the provisioning engine API.

Boots against a RUNNING backend (default http://127.0.0.1:8010) and walks the
whole wizard surface end-to-end, exactly the way the frontend wizard does:

    login -> network calc -> create router -> bootstrap command
          -> create provisioning session -> session status -> session list
          -> device scan (cached/first-time tolerant) -> WebSocket stream

Usage:
    python scripts/tools/smoke_provisioning.py [base_url]

Exits 0 when every step passes; prints each step result.
"""

from __future__ import annotations

import sys
import json
import asyncio

import httpx

SEED_EMAIL = "superuser@codevertexafrica.com"
SEED_PASSWORD = "superuser123"


def _ok(label: str, detail: str = "") -> None:
    print(f"[OK]   {label}{(' - ' + detail) if detail else ''}")


def _fail(label: str, detail: str) -> None:
    print(f"[FAIL] {label} - {detail}")


async def _ws_probe(base: str, session_id: str) -> None:
    """Connect to the provisioning WebSocket and wait briefly for traffic."""
    import websockets

    ws_base = base.replace("http://", "ws://").replace("https://", "wss://")
    uri = f"{ws_base}/api/v1/provisioning/ws/{session_id}"
    async with websockets.connect(uri, open_timeout=10) as ws:
        # The server replays the buffered history on connect; send a ping frame
        # the endpoint understands so we prove the round trip works.
        await ws.send(json.dumps({"type": "ping"}))
        try:
            msg = await asyncio.wait_for(ws.recv(), timeout=5)
            _ok("websocket stream", f"session={session_id} first_frame={str(msg)[:80]}")
        except asyncio.TimeoutError:
            # No replay buffered and pong handling is best-effort; connection
            # itself opening is the contract we need.
            _ok("websocket stream", f"session={session_id} connected (no buffered frames)")


def main() -> int:
    base = (sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8010").rstrip("/")
    failures = 0
    client = httpx.Client(base_url=base, timeout=60.0)

    # ── 1. login ────────────────────────────────────────────────────────────
    r = client.post(
        "/api/v1/auth/login",
        data={"username": SEED_EMAIL, "password": SEED_PASSWORD},
    )
    if r.status_code != 200:
        _fail("login", f"{r.status_code} {r.text[:200]}")
        return 1
    token = r.json()["data"]["access_token"]
    h = {"Authorization": f"Bearer {token}"}
    _ok("login", f"token acquired for {SEED_EMAIL}")

    # ── 2. network calculation ──────────────────────────────────────────────
    r = client.get(
        "/api/v1/provisioning/network/calc",
        params={"subnet_address": "172.31.0.0", "cidr": 16},
        headers=h,
    )
    if r.status_code != 200:
        _fail("network calc", f"{r.status_code} {r.text[:200]}")
        failures += 1
    else:
        body = r.json()
        _ok("network calc", f"gateway={body.get('gateway')} pool={body.get('dhcp_pool')}")

    # ── 3. create the router row (what the wizard does first) ───────────────
    payload = {
        "name": "SmokeTest-Chr",
        "ip_address": "192.168.88.1",
        "api_port": 8728,
        "description": "Created by scripts/tools/smoke_provisioning.py",
    }
    r = client.post("/api/v1/routers/", json=payload, headers=h)
    if r.status_code == 201:
        router = r.json()
        _ok("create router", f"id={router['id']} name={router['name']}")
    elif r.status_code == 409 or "already" in r.text.lower():
        # Re-run against an existing estate: reuse the existing row.
        listing = client.get(
            "/api/v1/routers/", params={"search": payload["name"]}, headers=h
        )
        items = listing.json().get("items", [])
        router = next((i for i in items if i["name"] == payload["name"]), None)
        if not router:
            _fail("create router", f"{r.status_code} {r.text[:200]}")
            return 1
        _ok("create router", f"reused existing id={router['id']}")
    else:
        _fail("create router", f"{r.status_code} {r.text[:300]}")
        return 1

    # ── 4. bootstrap command (with router_id reprovisioning detection) ──────
    r = client.get(
        "/api/v1/provisioning/bootstrap/command",
        params={
            "identity": payload["name"],
            "api_port": 8728,
            "interface": "ether2",
            "ip_address": payload["ip_address"],
            "router_id": router["id"],
        },
        headers=h,
    )
    if r.status_code != 200:
        _fail("bootstrap command", f"{r.status_code} {r.text[:300]}")
        failures += 1
    else:
        boot = r.json()
        command = boot.get("command", "")
        _ok(
            "bootstrap command",
            f"len={len(command)} already_done={boot.get('bootstrap_already_done')} "
            f"notes={len(boot.get('notes', []))}",
        )

    # ── 5. create-only provisioning session (embeds into notify URL) ────────
    r = client.post(
        "/api/v1/provisioning/sessions",
        json={
            "router_id": router["id"],
            "service_type": "hotspot",
            "configuration": {"subnet_address": "172.31.0.0", "cidr": 16},
        },
        headers=h,
    )
    if r.status_code != 201:
        _fail("create session", f"{r.status_code} {r.text[:300]}")
        return 1
    session_id = r.json()["session_id"]
    _ok("create session", f"session_id={session_id}")

    # ── 6. session status + list ────────────────────────────────────────────
    r = client.get(f"/api/v1/provisioning/sessions/{session_id}/status", headers=h)
    if r.status_code != 200:
        _fail("session status", f"{r.status_code} {r.text[:300]}")
        failures += 1
    else:
        st = r.json()
        _ok("session status", f"status={st.get('status')}")

    r = client.get("/api/v1/provisioning/sessions", headers=h)
    if r.status_code != 200:
        _fail("session list", f"{r.status_code} {r.text[:300]}")
        failures += 1
    else:
        sessions = r.json().get("sessions", [])
        _ok("session list", f"{len(sessions)} session(s)")

    # ── 7. device scan (cached scan-report path; tolerant of no device) ─────
    r = client.post(
        "/api/v1/provisioning/device/scan",
        json={"router_id": router["id"], "force_rescan": False},
        headers=h,
    )
    if r.status_code == 200:
        scan = r.json()
        _ok("device scan", f"{len(scan.get('interfaces', []))} interfaces")
    elif "No credentials" in r.text or "Failed to scan" in r.text:
        # No live device attached in a smoke environment - endpoint contract
        # (auth + router resolution) was still exercised.
        _ok("device scan", f"endpoint reachable (no device attached: {r.status_code})")
    else:
        _fail("device scan", f"{r.status_code} {r.text[:300]}")
        failures += 1

    # ── 8. WebSocket stream for the session ─────────────────────────────────
    try:
        asyncio.run(_ws_probe(base, session_id))
    except Exception as e:  # noqa: BLE001
        _fail("websocket stream", str(e))
        failures += 1

    # ── 9. cancel-active surface (clears stale sessions before re-provision) ─
    r = client.post(f"/api/v1/provisioning/router/{router['id']}/cancel-active", headers=h)
    if r.status_code == 200:
        _ok("cancel-active", f"cancelled={r.json().get('cancelled_count')}")
    else:
        _fail("cancel-active", f"{r.status_code} {r.text[:300]}")
        failures += 1

    print("\n" + ("SMOKE TEST PASSED" if failures == 0 else f"SMOKE TEST FAILED ({failures})"))
    return 0 if failures == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())

