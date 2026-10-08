# Provisioning wizard authentication

## Decision

The MikroTik provisioning wizard (`/app/provision` in the frontend,
`backend/app/api/v1/provisioning/*` in the engine) runs **without a
sign-in step**. The operator asked for this explicitly: adding a router
must not require authenticating to the engine first.

## How it works

`backend/app/api/deps.py::get_optional_current_user` replaces
`require_technician_or_admin()` on every provisioning endpoint:

- **Authenticated request** (valid `Authorization: Bearer <JWT>`): the real
  user is resolved and used — organization scoping and audit fields
  (`user_id`, `tenant_id`) are preserved exactly as before. The user object
  is `expunge`d from the session so a later `db.commit()` in the endpoint
  cannot expire it and force a mid-request async lazy-refresh (which trips
  SQLAlchemy's *"greenlet_spawn has not been called"*).
- **Anonymous request** (no/invalid token): a synthetic system user
  (`id=0`, `username="provisioning-wizard"`, `role=platform_owner`,
  `organization_id=None`) is returned, so every `current_user.*` access in
  the endpoints keeps working unchanged.

The frontend (`src/lib/provisionApi.ts`) mirrors this: `ensureAuth()` no
longer gates on a token. If `VITE_API_EMAIL` / `VITE_API_PASSWORD` are set
it signs in silently (best effort — the token is then used for org scoping);
otherwise requests go out unauthenticated.

## Why this is acceptable

- The engine is the **operator's own service**: the deployed frontend reaches
  it via `VITE_API_URL` (the ISP runs the engine locally / on-prem). It is
  operator tooling, not a public multi-tenant API.
- The router-facing callbacks (`/bootstrap/scan-report`, `/bootstrap/notify`,
  `/bootstrap/wg-register`, `/bootstrap/script`) were **already public** —
  the router itself calls them with a short-lived, signed bootstrap token.
  This change only removes the extra human sign-in in front of the wizard.
- The bootstrap one-liner carries a signed, 1-hour provisioning token minted
  per request; that token — not the caller's identity — authorizes the
  router-side steps.

## If you need to lock it down again

Restore `Depends(require_technician_or_admin())` on the affected endpoints
(bootstrap, device_scan, workflow, network, token) and set
`VITE_API_EMAIL` / `VITE_API_PASSWORD` so the frontend signs in silently.
The `get_optional_current_user` dependency can stay in place; it is a strict
superset of the old behaviour.
