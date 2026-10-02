-- =============================================================================
--  ISP Hotspot Billing — Platform Schema (multi-tenant)
--  Run with:  supabase db push     (or paste into the Supabase SQL editor)
-- =============================================================================

create extension if not exists "pgcrypto";

-- ── Enums ────────────────────────────────────────────────────────────────────
do $$ begin create type platform_role as enum ('super_admin','isp_owner','isp_admin','isp_agent','client');
exception when duplicate_object then null; end $$;

do $$ begin create type isp_status   as enum ('trial','active','suspended','churned');
exception when duplicate_object then null; end $$;

do $$ begin create type isp_plan     as enum ('starter','growth','enterprise');
exception when duplicate_object then null; end $$;

do $$ begin create type sub_status   as enum ('pending','active','suspended','expired');
exception when duplicate_object then null; end $$;

do $$ begin create type voucher_state as enum ('unused','active','expired','disabled');
exception when duplicate_object then null; end $$;

do $$ begin create type invoice_state as enum ('unpaid','paid','overdue','cancelled');
exception when duplicate_object then null; end $$;

-- These four are referenced by the table definitions further down, so they have
-- to exist before any `create table` runs.
do $$ begin create type node_state   as enum ('online','offline','maintenance');
exception when duplicate_object then null; end $$;

do $$ begin create type ticket_state  as enum ('open','in_progress','resolved','closed');
exception when duplicate_object then null; end $$;

do $$ begin create type ticket_prio   as enum ('low','medium','high','urgent');
exception when duplicate_object then null; end $$;

do $$ begin create type pay_state     as enum ('pending','success','failed','reversed');
exception when duplicate_object then null; end $$;

-- ── Tenants (root of every multi-tenant row) ─────────────────────────────────
create table if not exists public.isps (
  id              uuid primary key default gen_random_uuid(),
  name            text        not null,
  slug            text        not null unique,
  status          isp_status  not null default 'trial',
  plan            isp_plan    not null default 'starter',
  contact_email   text        not null,
  contact_phone   text,
  country         text        not null default 'KE',
  county          text,
  city            text,
  address         text,
  brand_color     text        not null default '#7c3aed',
  logo_url        text,
  portal_domain   text,
  max_clients     integer     not null default 100,
  max_plans       integer     not null default 10,
  max_nodes       integer     not null default 5,
  trial_ends_at   timestamptz,
  onboarded_at    timestamptz,
  suspended_at    timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

comment on table public.isps is 'Tenant root. Every business table carries isp_id referencing this.';

-- ── Users / profiles ─────────────────────────────────────────────────────────
create table if not exists public.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  isp_id      uuid references public.isps(id) on delete cascade,
  role        platform_role not null default 'client',
  full_name   text,
  phone       text,
  avatar_url  text,
  is_active   boolean     not null default true,
  last_login  timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists profiles_isp_idx  on public.profiles(isp_id);
create index if not exists profiles_role_idx on public.profiles(role);

-- ── Per-ISP M-Pesa credentials ───────────────────────────────────────────────
-- Intentionally has NO client SELECT policy: only the service role (used by the
-- stk-push Edge Function) can read these. Secrets never reach the browser.
-- ── Business tables (all tenant-scoped) ──────────────────────────────────────
create table if not exists public.plans (
  id             uuid primary key default gen_random_uuid(),
  isp_id         uuid not null references public.isps(id) on delete cascade,
  name           text not null,
  kind           text not null default 'hotspot' check (kind in ('hotspot','fiber','pppoe')),
  duration_label text not null default '24 Hours',
  duration_hours integer not null default 24,
  price          numeric(12,2) not null default 0,
  speed_down     text not null default '1 Mbps',
  speed_up       text not null default '1 Mbps',
  shared_users   integer not null default 1,
  data_limit     text not null default 'Unlimited',
  is_popular     boolean not null default false,
  is_active      boolean not null default true,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index if not exists plans_isp_idx on public.plans(isp_id);

create table if not exists public.vouchers (
  id           uuid primary key default gen_random_uuid(),
  isp_id       uuid not null references public.isps(id) on delete cascade,
  plan_id      uuid references public.plans(id) on delete set null,
  code         text not null,
  batch_prefix text,
  status       voucher_state not null default 'unused',
  activated_by text,
  activated_at timestamptz,
  expires_at   timestamptz,
  created_at   timestamptz not null default now()
);
create unique index if not exists vouchers_code_idx on public.vouchers(lower(code));
create index if not exists vouchers_isp_idx   on public.vouchers(isp_id, status);

create table if not exists public.clients (
  id         uuid primary key default gen_random_uuid(),
  isp_id     uuid not null references public.isps(id) on delete cascade,
  account_no text not null,
  full_name  text not null,
  phone      text not null,
  email      text,
  plan_name  text,
  status     sub_status not null default 'active',
  balance    numeric(12,2) not null default 0,
  bandwidth  text default '1 Mbps Symmetrical',
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (isp_id, account_no)
);
create index if not exists clients_isp_idx on public.clients(isp_id, status);

create table if not exists public.invoices (
  id           uuid primary key default gen_random_uuid(),
  isp_id       uuid not null references public.isps(id) on delete cascade,
  client_id    uuid references public.clients(id) on delete cascade,
  invoice_no   text not null,
  period_label text not null,
  plan_name    text,
  amount       numeric(12,2) not null default 0,
  due_date     date not null default current_date,
  status       invoice_state not null default 'unpaid',
  paid_at      timestamptz,
  created_at   timestamptz not null default now(),
  unique (isp_id, invoice_no)
);
create index if not exists invoices_isp_idx on public.invoices(isp_id, status);

create table if not exists public.payments (
  id             uuid primary key default gen_random_uuid(),
  isp_id         uuid not null references public.isps(id) on delete cascade,
  client_id      uuid references public.clients(id) on delete set null,
  invoice_id     uuid references public.invoices(id) on delete set null,
  phone          text,
  amount         numeric(12,2) not null default 0,
  method         text not null default 'mpesa',
  status         pay_state not null default 'pending',
  checkout_request_id text,
  mpesa_receipt  text,
  created_at     timestamptz not null default now()
);
create index if not exists payments_isp_idx on public.payments(isp_id, created_at desc);

-- Daraja credentials per tenant. The secret columns are readable only by the
-- service role (the stk-push Edge Function); the browser sees booleans from
-- payment_config_status() instead.
create table if not exists public.isp_payment_configs (
  isp_id                uuid primary key references public.isps(id) on delete cascade,
  mpesa_env             text not null default 'sandbox' check (mpesa_env in ('sandbox','production')),
  mpesa_shortcode       text,
  mpesa_passkey         text,
  mpesa_consumer_key    text,
  mpesa_consumer_secret text,
  callback_url          text
);

create table if not exists public.nodes (
  id            uuid primary key default gen_random_uuid(),
  isp_id        uuid not null references public.isps(id) on delete cascade,
  name          text not null,
  host          text,
  routeros_version text,
  status        node_state not null default 'online',
  active_users  integer not null default 0,
  load_percent  integer not null default 0,
  capacity      text default '1 Gbps',
  last_seen     timestamptz default now(),
  created_at    timestamptz not null default now()
);
create index if not exists nodes_isp_idx on public.nodes(isp_id);

create table if not exists public.sessions (
  id            uuid primary key default gen_random_uuid(),
  isp_id        uuid not null references public.isps(id) on delete cascade,
  node_id       uuid references public.nodes(id) on delete cascade,
  voucher_code  text,
  mac_address   text,
  ip_address    text,
  device_type   text,
  downloaded_mb bigint not null default 0,
  uploaded_mb   bigint not null default 0,
  started_at    timestamptz not null default now(),
  ended_at      timestamptz
);
create index if not exists sessions_isp_idx on public.sessions(isp_id, started_at desc);

create table if not exists public.tickets (
  id         uuid primary key default gen_random_uuid(),
  isp_id     uuid not null references public.isps(id) on delete cascade,
  client_id  uuid references public.clients(id) on delete cascade,
  subject    text not null,
  category   text not null default 'Other',
  status     ticket_state not null default 'open',
  priority   ticket_prio  not null default 'medium',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists tickets_isp_idx on public.tickets(isp_id, status);

create table if not exists public.ticket_messages (
  id         uuid primary key default gen_random_uuid(),
  ticket_id  uuid not null references public.tickets(id) on delete cascade,
  -- Denormalised so row-level security can scope messages without a join back
  -- through tickets; RLS policies cannot rely on a subquery on another table
  -- when the referencing row is what must be protected.
  isp_id     uuid not null references public.isps(id) on delete cascade,
  sender     text not null check (sender in ('client','staff','system')),
  body       text not null,
  created_at timestamptz not null default now()
);
create index if not exists ticket_messages_ticket_idx on public.ticket_messages(ticket_id);
create index if not exists ticket_messages_isp_idx on public.ticket_messages(isp_id);

create table if not exists public.usage_events (
  id          uuid primary key default gen_random_uuid(),
  isp_id      uuid not null references public.isps(id) on delete cascade,
  client_id   uuid references public.clients(id) on delete cascade,
  kind        text not null,
  quantity_mb bigint not null default 0,
  amount      numeric(12,2) not null default 0,
  created_at  timestamptz not null default now()
);
create index if not exists usage_events_isp_idx on public.usage_events(isp_id, created_at desc);

-- ── Platform-wide audit trail (super admin readable) ─────────────────────────
create table if not exists public.audit_logs (
  id          uuid primary key default gen_random_uuid(),
  actor_id    uuid references auth.users(id) on delete set null,
  actor_email text,
  actor_role  platform_role,
  isp_id      uuid references public.isps(id) on delete set null,
  isp_name    text,
  action      text not null,
  target_type text,
  target_id   text,
  metadata    jsonb default '{}'::jsonb,
  created_at  timestamptz not null default now()
);
create index if not exists audit_logs_created_idx on public.audit_logs(created_at desc);