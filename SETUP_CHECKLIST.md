# Setup Checklist — what to provide, and where to get it

This is the complete list of things only **you** can obtain, and where each one
goes. Everything else the system does by itself.

Legend: 🔴 required for the system to work · 🟡 required for M-Pesa · ⬜ optional

---

## 🔴 1. Supabase project (required — this is the database + auth)

Go to **<https://supabase.com/dashboard> → New project**. Takes ~2 minutes.

You will be asked for a **database password** — save it somewhere safe, you may
need it later.

Then open **Project Settings → API** and copy:

| # | What to copy | Where it goes |
| --- | --- | --- |
| 1 | **Project URL** — `https://xxxx.supabase.co` | `.env.local` → `VITE_SUPABASE_URL` |
| 2 | **`anon` public key** — starts `eyJhbGci…` | `.env.local` → `VITE_SUPABASE_ANON_KEY` |
| 3 | **Database password** (you chose it) | Only needed if you want me to run `supabase db push` for you |

> ⚠️ **Never send me the `service_role` key.** It bypasses all Row Level
> Security. It lives in Supabase's own Edge Function environment and never
> touches the frontend.

---

## 🔴 2. Your super admin email

The first account you sign up with becomes the platform operator.

You can either give me the email and I'll add it for you, or run this yourself
in **Supabase → SQL Editor → New query**:

```sql
insert into public.platform_admins (email, full_name)
values ('YOUR-EMAIL@yourcompany.com', 'Platform Operator');
```

| # | What | Where it goes |
| --- | --- | --- |
| 4 | Your operator email | The SQL above, or `VITE_SUPER_ADMIN_EMAILS` in `.env.local` |

---

## 3. HashBack (required for automated M-Pesa)

HashBack is the only M-Pesa provider. The former Safaricom Daraja setup is gone.

| # | Credential | Where it goes |
| --- | --- | --- |
| 5 | HashBack **API key** | Super admin -> **Platform -> Payment gateway -> HashBack** |
| 6 | HashBack **webhook secret** | Super admin -> **Platform -> Payment gateway -> HashBack** |
| 7 | HashBack **webhook URL** | Registered with HashBack via `/registerwebhook` |

**This is platform-wide, not per ISP.** The key and secret are encrypted at rest
and never returned to the browser; the screen shows only configured / not
configured plus connection and webhook status.

Each ISP then links its **own** HashBack channel (merchant name, channel type and
Till/PayBill shortcode) under **Settings -> Payments**. The service calls the
HashBack Partner API and stores the returned AccountID for that tenant. There is
no per-ISP API credential and there is nothing to paste into a tenant form.

---

## 🔴 4. Where to host it (required to go live)

Pick one:

### Option A — Vercel (easiest, free tier)

| # | What | Notes |
| --- | --- | --- |
| 9 | A Vercel account | <https://vercel.com/signup> |

Then I run `vercel --prod` and add the env vars. No server to maintain.

### Option B — Your own VPS

| # | What | Notes |
| --- | --- | --- |
| 10 | Server IP / hostname | |
| 11 | SSH access (user + key) | For `docker compose up -d --build` |
| 12 | A domain with an A record pointing at it | For HTTPS (needed by the HashBack webhook) |

**If you choose M-Pesa you need HTTPS.** HashBack will not POST to a plain-HTTP
address, so a domain + TLS is effectively mandatory.

---

## 🟡 5. Your first ISP accounts (optional)

ISPs register themselves at `/register` — no help needed from you. But if you
want them pre-provisioned, give me per ISP:

| # | What | Example |
| --- | --- | --- |
| 13 | ISP name | `Rift Valley Broadband` |
| 14 | Subdomain | `riftvalley` → `riftvalley.portal` |
| 15 | Owner email + name + phone | `owner@riftvalley.co.ke` |
| 16 | County / city | `Nakuru / Nakuru` |
| 17 | Plan tier | starter (100 customers) · growth (500) · enterprise (5,000) |
| 18 | Their HashBack channel (if they automate M-Pesa) | see §3 |

---

## 🔴 6. The callback URL (required for M-Pesa to settle payments)

This depends on your Supabase project. Once the project exists it is:

```
https://<your-project-ref>.supabase.co/functions/v1/hashback-webhook
```

You must enter this in **two** places:

1. Super admin → tenant → **M-Pesa config** → *Callback URL*
2. The **HashBack dashboard** -> registered callback URL

If it is not configured in HashBack, the customer's money moves but the
invoice never gets marked paid.

---

## Not needed from you

These are handled by the system:

- The database schema — 3 SQL migrations are already written
- Row Level Security policies — already written
- Edge Functions — already written, just need deploying
- Tenant onboarding — ISPs self-register at `/register`
- Staff accounts — the super admin adds them from the tenant screen
- Voucher codes, invoices, nodes — generated inside each ISP's workspace
- Hosting config — `vercel.json`, `Dockerfile`, `docker-compose.yml` all exist

---

## Order of operations

```
1. Create the Supabase project            → §1
2. Give me the Project URL + anon key     → §1
3. I run the migrations (schema + RLS)
4. Give me your email, I make you super admin  → §2
5. Deploy the 3 Edge Functions
6. Test the whole platform with your email  ← you can log in now
7. Add your first ISP from /admin/isps    → §5
8. Link its HashBack channel               → §3
9. Deploy to Vercel or the VPS            → §4
10. Move M-Pesa from sandbox to production once tested
```

**You only need items 1, 2 and 4 to get a working system.** Items 3 and 5 are
for collecting real money.

---

## Copy-paste summary

Paste this back to me with the values filled in:

```
Supabase Project URL:      https://________________.supabase.co
Supabase anon key:         eyJhbGci________________
Super admin email:         ________________@__________

M-Pesa (optional, start with sandbox):
  Consumer key:            ________________
  Consumer secret:         ________________
  Lipa na M-Pesa passkey:  ________________
  Paybill shortcode:       ________

Deploy to:                 [ ] Vercel   [ ] VPS (IP: ____________)
```
