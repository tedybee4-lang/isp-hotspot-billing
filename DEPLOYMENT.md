# Live deployment

    https://isp-hotspot-billing-mhapfxdsa-malariachrome-7756s-projects.vercel.app

- Project id: `prj_Ze350DIlVGCyAVw1M9ZeBhezLSai`
- Supabase: `https://dcqcunmdhyonaewwuama.supabase.co`

`isp-hotspot-billing.vercel.app` is a **different project** in the same account
and does not serve this app. Use the URL above, or attach a custom domain in
the Vercel dashboard under Settings -> Domains.

## Test accounts

All use the password `ISINDU316711`.

| Email | Role | Scope |
|---|---|---|
| `ops@ultrafaiba.net` | super_admin | platform-wide, all 3 ISPs |
| `alpha@isp.test` | isp_owner | alpha-nets |
| `beta@isp.test` | isp_owner | beta-broadband |
| `gamma@isp.test` | isp_owner | gamma-fibre |

---
# Deployment Guide

Everything below assumes you are in the project root.

---

## 1. Run it on localhost (no backend needed)

```bash
npm install
npm run dev
```

Open <http://localhost:5173>.

With no `.env.local`, the app boots in **demo mode**: a localStorage-backed
simulation of the whole platform with four seeded tenants. Every screen works —
super admin dashboard, ISP panel, captive portal, billing, M-Pesa settlement —
without a server.

| Role        | Email                    | Password     |
| ----------- | ------------------------ | ------------ |
| Super admin | `superadmin@ispflow.dev` | `Super@1234` |
| ISP owner   | `owner@ultrafaiba.co.ke` | `Owner@1234` |
| ISP owner   | `owner@riftvalley.co.ke` | `Owner@1234` |

Use the one-click buttons on the login screen to fill these in.

To wipe and re-seed demo data, clear the `localStorage` key
`ispflow.demo.v1` or call `resetDb()` from the console.

---

## 2. Connect Supabase

### 2.1 Create a project

1. <https://supabase.com/dashboard> → **New project**
2. Save the database password somewhere safe.
3. Wait for provisioning (~2 min).

### 2.2 Grab your API keys

**Project Settings → API**:

| Value               | Put in                   |
| ------------------- | ------------------------ |
| Project URL         | `VITE_SUPABASE_URL`      |
| `anon` public key   | `VITE_SUPABASE_ANON_KEY` |

> The anon key is *meant* to be public — Vite inlines it into the bundle.
> Your data is protected by Row Level Security, not by hiding this key.
> Never use the `service_role` key in the browser.

### 2.3 Apply the schema

```bash
supabase login
supabase link --project-ref <your-project-ref>
supabase db push
```

Or paste these into **SQL Editor → New query**, in order:

1. `supabase/migrations/20260101000000_init_schema.sql`
2. `supabase/migrations/20260101000100_rls_policies.sql`
3. `supabase/migrations/20260101000200_functions.sql`

### 2.4 Bootstrap a super admin

Super admins are promoted by email on signup. Add yourself:

```sql
insert into public.platform_admins (email, full_name)
values ('you@yourcompany.com', 'Platform Operator');
```

Then sign up at `/register` with that email — the `handle_new_user` trigger
grants `super_admin` on creation.

### 2.5 Configure the frontend

Create `.env.local`:

```bash
VITE_SUPABASE_URL=https://<project-ref>.supabase.co
VITE_SUPABASE_ANON_KEY=<your-anon-key>
VITE_APP_URL=https://your-domain.com
VITE_SUPER_ADMIN_EMAILS=you@yourcompany.com
```

Restart `npm run dev`. The sidebar badge switches from **Demo mode** to
**Supabase connected**.

---

## 3. M-Pesa (HashBack)

> **Never** put a HashBack credential in a `VITE_*` variable. Vite inlines those
> into the public bundle. The API key and webhook secret belong in the Edge
> Function environment and in the encrypted store, read only with the service role.

HashBack is the only M-Pesa provider. The Safaricom Daraja integration (consumer
key, consumer secret, passkey, `stk-push`, `stk-callback`) has been removed; the
credential forms and the STK implementation are gone from the codebase.

### Payment modes

| Mode | ISP needs | API keys? | How it works |
| --- | --- | --- | --- |
| **Manual Till / Paybill** | Till or Paybill number | None | Customer pays via the M-Pesa app or `*334#`, staff confirm. Works for every ISP, immediately. |
| **HashBack** | Merchant name, channel type, Till/PayBill shortcode | Platform key only | Automated STK Push, webhook settlement and reconciliation. The ISP links its own HashBack channel. |

**Manual Till** needs nothing and remains the default. Its flow:

1. Staff pick an unpaid invoice in **Billing -> Till / Paybill**
2. The system issues instructions: amount, unique reference, Till number, steps
3. The customer pays from their phone
4. Staff confirm once it appears on the Till statement (`confirm_manual_payment`)
5. The invoice is marked paid and the customer's expiry extends 30 days

### 3.1 Platform HashBack credential

In the Super Admin panel: **Platform -> Payment gateway -> HashBack**. Enter the
API key and webhook secret there; they are encrypted with the same AES-GCM store
used for router credentials and are never returned by any API. The screen shows
only *configured / not configured*, connection status and webhook status.

### 3.2 Per-ISP HashBack channel

Each ISP registers its own channel under **Settings -> Payments** with:

- Merchant / company name
- Channel type (`CustomerBuyGoodsOnline`, `CustomerPayBillOnline`)
- Till / shortcode / PayBill number

The Edge Function calls the HashBack Partner API (`/linkaccount`) and stores the
returned **AccountID** against that tenant. The tenant is resolved from the
authenticated caller's profile server-side; there is no `ispId` parameter, so a
browser cannot ask for another ISP's channel.

`/linkaccount` mints a *fresh* AccountID for an already-linked shortcode, so the
service refuses to call it twice for the same channel and an ISP never ends up
with two live accounts.

### 3.3 Deploy the Edge Functions

```bash
supabase functions deploy hashback-stk     # authenticated: starts a payment
supabase functions deploy hashback-webhook --no-verify-jwt
supabase functions deploy hashback-admin   # authenticated: super admin only
supabase functions deploy admin-invite     --no-verify-jwt
```

`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are injected automatically.

`hashback-webhook` is the only one deployed `--no-verify-jwt`: it is called by
HashBack, not by a browser. It reads the raw request body, verifies the
`X-Hashpay-Signature` HMAC-SHA256 over those exact bytes, and only then parses
the JSON. An invalid signature is a 401 and nothing is applied.

`stk-push` is retained solely as an unconditional `410 Gone`.

### 3.4 Callback URL

Register the public HTTPS URL with HashBack (`/registerwebhook`):

```
https://<project-ref>.supabase.co/functions/v1/hashback-webhook
```

### 3.5 What settlement actually does

A successful `/initiatestk` means **pending**, never paid. Nothing is activated
on initiation. The payment is settled when the webhook (or `/v1/pullapi`
reconciliation) proves the money moved, and only then does
`complete_hashback_settlement` activate the subscription, queue the RADIUS sync
job and queue the payment SMS. A duplicate webhook is a no-op.

**Local sandbox testing** needs a tunnel:

```bash
npx localtunnel --port 5173     # or: cloudflared tunnel --url http://localhost:5173
```

---

## 4. Deploy to Vercel

```bash
npm i -g vercel
vercel          # preview
vercel --prod   # production
```

Or import the repo at <https://vercel.com/new> (framework auto-detected: Vite)
and add the environment variables from §2.5.

`vercel.json` already configures the SPA rewrite, immutable asset caching and
security headers.

> These are **build-time** values — redeploy after changing them.

## 5. Deploy to a VPS

### 5.1 Requirements

- Ubuntu 22.04+ (or any Docker host)
- 1 GB RAM for the SPA alone; **4 GB** if self-hosting Supabase
- A domain with an A record to the server

### 5.2 Build and run

```bash
cp .env.example .env       # fill in VITE_SUPABASE_*
docker compose up -d --build
docker compose ps
```

The app is on <http://server-ip:8080>. Add TLS with Caddy:

```bash
sudo apt install -y caddy
cat > /etc/caddy/Caddyfile <<'EOF'
your-domain.com {
    reverse_proxy localhost:8080
}
EOF
sudo systemctl reload caddy
```

### 5.3 Update

```bash
git pull
docker compose up -d --build
```

### 5.4 Self-hosted Supabase (optional)

For full data sovereignty run the Supabase stack on the same host: uncomment
the `supabase` service in `docker-compose.yml`, then add Studio, Kong, GoTrue,
PostgREST, Realtime, Storage and Supavisor per the official self-hosting guide.
It needs at least 4 GB RAM.

---

## 6. Verify the deployment

```bash
npm run typecheck    # TypeScript, strict
npm test             # 23 behavioural tests
npm run build        # typecheck + production build
```

Then confirm in a browser:

- [ ] `https://<your-domain>/` loads the platform page
- [ ] `https://<your-domain>/login` renders (SPA rewrite works)
- [ ] `https://<your-domain>/admin` redirects to `/login` when signed out
- [ ] Signing in as super admin shows the tenant list
- [ ] `https://<your-domain>/portal/<slug>` shows that ISP's captive portal
- [ ] Badge reads **Supabase connected**, not **Demo mode**

---

## 7. Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| Badge says *Demo mode* after setting env vars | `.env.local` missing or not reloaded | Restart the dev server; confirm it is `.env.local`, not `.env` |
| `Invalid or expired session` | Anon key wrong, or RLS policies missing | Re-apply migrations §2.3 |
| Super admin sees nothing | Email not in `platform_admins` | Insert it (§2.4) and sign up again |
| STK push returns *M-Pesa is not configured* | Tenant has no HashBack channel | The ISP links one under Settings -> Payments |
| Callback never arrives | HashBack cannot reach the URL | Confirm the URL is public HTTPS and registered with HashBack |
| Direct URL load gives 404 | SPA rewrite missing | `vercel.json` handles Vercel; `nginx.conf` handles Docker |
| Tenant cannot see their data | Profile has no `isp_id` | Re-run `signup_isp`, or set `profiles.isp_id` manually |
## MikroTik routers

The panel talks to real MikroTik hardware over the RouterOS REST API.

### Adding a router

1. **Routers -> Add router**
2. Enter the router's LAN address (not the WAN address) and the REST port.
   The default is `8728`; RouterOS v7 deployments often use `8729`.
3. Enter a RouterOS username and password.
4. Press **Test connection**. You should see the router identity, model and
   RouterOS version. If it fails, the error says which of the common causes
   applies - wrong credentials, REST API disabled, or unreachable host.
5. Save. The credentials are encrypted before they are stored.

On the router itself:

```
/ip service enable www
/ip service set www port=8728
```

Give the panel its own restricted account rather than the `admin` account:

```
/user group add name=isp-panel policy=read,write,api,test,policy=read
/user add name=isp-panel group=isp-panel password="<strong password>"
```

### Credentials

RouterOS passwords are encrypted with AES-256-GCM using
`ROUTER_CREDENTIALS_KEY`, which lives only in the Edge Function environment.
The database stores ciphertext. `router_credentials` has RLS enabled with no
policy for `authenticated`, so tenant staff cannot read it even with a valid
session - only the service role, inside the Edge Function, can decrypt.

Rotating the key invalidates every stored credential and every router must be
re-saved.

### Telemetry

`mikrotik-poll` reads identity, resources and live HotSpot users from every
enabled router and writes the result to `nodes` and `sessions`. Values it could
not read stay `null` and the UI shows **No data** rather than a placeholder.

A router that fails to answer is marked `offline` with the reason in
`last_error`, and each attempt is recorded in `router_poll_runs`. One
unreachable router never aborts the sweep.

### Automatic polling

Run this once to schedule the poller every two minutes:

```sql
insert into public.poller_config (project_url, service_key, enabled)
values (
  'https://<project-ref>.supabase.co',
  '<service-role key>',
  true
);

select cron.schedule(
  'mikrotik-poll',
  '*/2 * * * *',
  $$
  select net.http_post(
    url := (select project_url || '/functions/v1/mikrotik-poll' from public.poller_config where id),
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select service_key from public.poller_config where id)
    )
  );
  $$
);
```

Verify with `select * from cron.job_run_details order by start_time desc limit 5;`.

### Sessions

Disconnecting a session asks the router to drop the user, then closes the row.
If the router cannot be reached the panel says so explicitly - it never claims
a customer is offline when only the database record changed.

### Firewall

RouterOS must be reachable from Supabase's edge network. The panel cannot reach
a router sitting behind NAT with no inbound rule. Open the REST port to
Supabase's outbound addresses, or run a poller inside your own network instead
and point it at the same Edge Function.
