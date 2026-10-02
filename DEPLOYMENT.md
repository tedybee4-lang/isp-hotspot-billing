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

## 3. M-Pesa (Safaricom Daraja)

> **Never** put Daraja credentials in a `VITE_*` variable. Vite inlines those
> into the public bundle. They belong in Postgres, read only by the Edge
> Function using the service role.

### Three payment modes

Not every ISP has Safaricom Daraja API access — most only hold a Till or
Paybill number. Each tenant picks one mode on its detail screen.

| Mode | ISP needs | API keys? | How it works |
| --- | --- | --- | --- |
| **Manual Till / Paybill** | Till or Paybill number | ❌ None | Customer pays via the M-Pesa app or `*334#`, staff confirm the payment. Works for every ISP, immediately. |
| **Platform Daraja** | Paybill shortcode | ❌ None per ISP | The operator owns one Daraja app. Configure it once under **Platform → Payments**, then any ISP only supplies their shortcode. |
| **Own Daraja** | Shortcode + consumer key + secret + passkey | ✅ Their own | Full automated STK Push using that ISP's credentials. |

**Manual Till** is the default because it needs nothing. The flow:

1. Staff pick an unpaid invoice in **Billing → Till / Paybill**
2. The system issues instructions: amount, unique reference, Till number, steps
3. The customer pays from their phone
4. Staff confirm once it appears on the Till statement (`confirm_manual_payment`)
5. The invoice is marked paid and the customer's expiry extends 30 days

### 3.1 Per-ISP credentials

In the Super Admin panel: **ISPs → open a tenant → Payment collection**.

Or directly in SQL:

```sql
update public.isp_payment_configs
set payment_mode    = 'manual_till',
    till_number     = '522533',
    paybill_number  = '174379',
    customer_notice = 'Pay the exact amount so your account is credited.'
where isp_id = (select id from public.isps where slug = 'your-slug');
```

The secret columns are **write-only from the browser's perspective**: the UI
never reads them back, and `payment_config_status` returns only booleans.

### 3.1b Shared platform credentials (optional)

Set these once under **Platform → Payments**, or:

```sql
update public.platform_payment_config
set mpesa_passkey = '<passkey>',
    mpesa_consumer_key = '<key>',
    mpesa_consumer_secret = '<secret>'
where id = true;
```

Tenants set to `platform_daraja` then use these automatically.

### 3.2 Deploy the Edge Functions

```bash
supabase functions deploy stk-push    --no-verify-jwt
supabase functions deploy stk-callback --no-verify-jwt
supabase functions deploy admin-invite --no-verify-jwt
```

`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are injected automatically.

### 3.3 Callback URL

Safaricom requires a public HTTPS URL:

```
https://<project-ref>.supabase.co/functions/v1/stk-callback
```

Enter it in the Daraja portal (Initiator URL & Confirmation URL) **and** in
`isp_payment_configs.callback_url`.

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
| STK push returns *M-Pesa is not configured* | Tenant has no Daraja credentials | Populate `isp_payment_configs` §3.1 |
| Callback never arrives | Safaricom cannot reach the URL | Confirm the URL is public HTTPS and set in the Daraja portal |
| Direct URL load gives 404 | SPA rewrite missing | `vercel.json` handles Vercel; `nginx.conf` handles Docker |
| Tenant cannot see their data | Profile has no `isp_id` | Re-run `signup_isp`, or set `profiles.isp_id` manually |