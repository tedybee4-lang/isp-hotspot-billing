# Provisioning authentication status

## Identity bridge

The frontend uses Supabase Auth. The provisioning client sends the current
Supabase access token as a bearer token to the VPS API. The provisioning API
validates it through the configured Supabase Auth `/auth/v1/user` endpoint;
it does not trust unverified JWT claims, Supabase profile metadata, or
browser-supplied roles or tenant IDs.

The verified Supabase subject is looked up in `users.supabase_user_id`. The
matched VPS `User` row is authoritative for active state, role, and
organization. Its mapping is deliberately separate from
`auth_service_user_id`, which belongs to Codevertex SSO. Missing mappings are
denied; there is no automatic link by email and no synthetic platform-owner
fallback.

To enable the bridge on a VPS:

1. Configure `SUPABASE_AUTH_URL=https://<project-ref>.supabase.co` and
   `SUPABASE_ANON_KEY=<project-anon-key>` in the backend environment. The anon
   key is public; never configure or expose a service-role key here.
2. Apply Alembic revision `f7a8b9c0d1e2`, which adds the nullable unique
   `users.supabase_user_id` mapping field.
3. Have an authorized administrator map each permitted Supabase Auth UUID to
   the intended existing VPS user. The VPS user's organization and role must
   already be correct.

No live backend configuration, migration, or account mapping has been applied
from this workspace. Until configured, app users without a mapping cannot
provision routers.

## Authorization and progress

Provisioning HTTP endpoints require an active technician/admin/platform-owner
identity. Router and session access is checked against the backend
organization. Cross-tenant sessions are hidden as not found. Session status
polling uses the same authenticated API dependency and ownership check.

WebSocket connections remain rejected until session-scoped authenticated
tickets are implemented. The frontend uses authenticated status polling;
ordinary Vercel HTTP rewrites do not proxy WebSocket upgrades.

RouterOS bootstrap callbacks use distinct, ten-minute credentials for script
retrieval, scan reporting, bootstrap notification, WireGuard enrollment, and
script completion. Each credential is bound to one router, session, initiating
VPS user, and one operation; it cannot be used as an API bearer token. The
backend rechecks the active user, current router authorization, session status,
and router identity, and records each credential ID under a database row lock
before accepting the operation. Replays are rejected.

RouterOS fetch implementations that support only URL authentication still
carry these short-lived, single-operation credentials in query strings. This
means the credential can be visible in router-side fetch history and reverse
proxy/access logs. Use HTTPS, avoid logging query strings for these paths, and
do not copy generated commands into shared logs or tickets. The design limits
the exposure but cannot remove it while using this RouterOS protocol.

Completion accepts only `completed` or `failed`, rejects conflicting terminal
states, and persists success, progress, completion time, and failure details.

## Deployment and verification

The Vercel project currently deployed on the production alias does not contain
the API proxy rules. The repository's current `main` branch `vercel.json`
contains only the SPA fallback, which explains why production API paths return
frontend HTML. The local configuration now routes `/api/*` and `/health` to
the VPS before the SPA fallback; this must be pushed and deployed before it
can affect production.

The VPS `/health` endpoint has returned healthy production JSON. Direct
unauthenticated provisioning requests return a JSON 401, which is expected.
The production Vercel alias still returns frontend HTML for `/health` and the
provisioning API path. No authorized session creation, worker execution,
MikroTik configuration, WebSocket delivery, or RADIUS UDP port operation has
been verified.
