-- =============================================================================
--  Domain expansion — tenant-isolated tables for every ISP subsystem.
--
--  Every table here carries isp_id and gets RLS in the next migration.
--  Nothing is dropped or renamed: this only ADDS what was missing.
-- =============================================================================

-- ── HotSpot / PPPoE accounts ────────────────────────────────────────────────
-- `clients` is the billing customer. This is the *service* record: the login
-- credential, which service type it is, and its RADIUS/MikroTik linkage.
create table if not exists public.service_accounts (
  id             uuid primary key default gen_random_uuid(),
  isp_id         uuid not null references public.isps(id) on delete cascade,
  client_id      uuid references public.clients(id) on delete cascade,
  username       text not null,
  service_type   text not null default 'hotspot'
                 check (service_type in ('hotspot','pppoe','fiber')),
  password_hash  text,                       -- never returned to clients
  plan_id        uuid references public.plans(id) on delete set null,
  status         text not null default 'active'
                 check (status in ('active','expired','suspended','pending')),
  ip_address     text,
  mac_address    text,
  router_id      uuid references public.nodes(id) on delete set null,
  radius_user_id text,
  last_seen_at   timestamptz,
  expires_at     timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (isp_id, username)
);
create index if not exists service_accounts_isp_idx  on public.service_accounts(isp_id);
create index if not exists service_accounts_type_idx on public.service_accounts(isp_id, service_type, status);
create index if not exists service_accounts_client_idx on public.service_accounts(client_id);

-- ── Routers: extend `nodes` with real hardware detail ───────────────────────
alter table public.nodes
  add column if not exists model         text,
  add column if not exists serial_number text,
  add column if not exists os_version    text,
  add column if not exists cpu_load      integer,
  add column if not exists ram_used_mb   integer,
  add column if not exists ram_total_mb  integer,
  add column if not exists uptime_seconds bigint,
  add column if not exists notes         text;

comment on column public.nodes.cpu_load is
  'NULL when the router has not reported. Never fabricate a value.';

-- ── Renewals ────────────────────────────────────────────────────────────────
create table if not exists public.renewals (
  id            uuid primary key default gen_random_uuid(),
  isp_id        uuid not null references public.isps(id) on delete cascade,
  client_id     uuid references public.clients(id) on delete cascade,
  plan_id       uuid references public.plans(id) on delete set null,
  previous_expiry timestamptz,
  new_expiry      timestamptz not null,
  amount        numeric(12,2) not null default 0,
  payment_id    uuid references public.payments(id) on delete set null,
  renewed_by    uuid references auth.users(id) on delete set null,
  note          text,
  created_at    timestamptz not null default now()
);
create index if not exists renewals_isp_idx on public.renewals(isp_id, created_at desc);

-- ── Transactions (ledger) ───────────────────────────────────────────────────
create table if not exists public.transactions (
  id         uuid primary key default gen_random_uuid(),
  isp_id     uuid not null references public.isps(id) on delete cascade,
  client_id  uuid references public.clients(id) on delete set null,
  kind       text not null
             check (kind in ('payment','renewal','expense','commission','adjustment','refund')),
  direction  text not null default 'credit' check (direction in ('credit','debit')),
  amount     numeric(12,2) not null,
  reference  text,
  memo       text,
  payment_id uuid references public.payments(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists transactions_isp_idx on public.transactions(isp_id, created_at desc);

-- ── SMS ─────────────────────────────────────────────────────────────────────
create table if not exists public.sms_templates (
  id         uuid primary key default gen_random_uuid(),
  isp_id     uuid not null references public.isps(id) on delete cascade,
  key        text not null,           -- welcome, payment_ok, expired, ...
  name       text not null,
  body       text not null,
  variables  text[] not null default '{}',
  is_active  boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (isp_id, key)
);
create index if not exists sms_templates_isp_idx on public.sms_templates(isp_id);

create table if not exists public.sms_messages (
  id           uuid primary key default gen_random_uuid(),
  isp_id       uuid not null references public.isps(id) on delete cascade,
  client_id    uuid references public.clients(id) on delete set null,
  template_key text,
  to_number    text not null,
  body         text not null,
  status       text not null default 'queued'
               check (status in ('queued','sent','delivered','failed')),
  provider     text,
  provider_id  text,
  error        text,
  segments     integer default 1,
  cost         numeric(12,2),
  sent_by      uuid references auth.users(id) on delete set null,
  sent_at      timestamptz,
  created_at   timestamptz not null default now()
);
create index if not exists sms_messages_isp_idx on public.sms_messages(isp_id, created_at desc);
create index if not exists sms_messages_status_idx on public.sms_messages(isp_id, status);

-- __SPLIT__
-- ── Resellers / agents / commissions ───────────────────────────────────────
create table if not exists public.resellers (
  id              uuid primary key default gen_random_uuid(),
  isp_id          uuid not null references public.isps(id) on delete cascade,
  user_id         uuid references auth.users(id) on delete set null,
  code            text not null,
  full_name       text not null,
  phone           text,
  email           text,
  address         text,
  commission_rate numeric(5,2) not null default 10.00,  -- percent
  credit_limit    numeric(12,2) not null default 0,
  balance         numeric(12,2) not null default 0,
  status          text not null default 'active'
                  check (status in ('active','suspended')),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (isp_id, code)
);
create index if not exists resellers_isp_idx on public.resellers(isp_id, status);

alter table public.clients
  add column if not exists reseller_id uuid references public.resellers(id) on delete set null;
create index if not exists clients_reseller_idx on public.clients(reseller_id);

create table if not exists public.commissions (
  id          uuid primary key default gen_random_uuid(),
  isp_id      uuid not null references public.isps(id) on delete cascade,
  reseller_id uuid not null references public.resellers(id) on delete cascade,
  payment_id  uuid references public.payments(id) on delete set null,
  sale_amount numeric(12,2) not null,
  rate        numeric(5,2) not null,
  amount      numeric(12,2) not null,
  period      text not null,          -- 'YYYY-MM'
  status      text not null default 'pending'
              check (status in ('pending','approved','paid','cancelled')),
  paid_at     timestamptz,
  created_at  timestamptz not null default now()
);
create index if not exists commissions_isp_idx on public.commissions(isp_id, period);
create unique index if not exists commissions_payment_uniq
  on public.commissions(isp_id, payment_id) where payment_id is not null;

-- ── Expenses ────────────────────────────────────────────────────────────────
create table if not exists public.expenses (
  id              uuid primary key default gen_random_uuid(),
  isp_id          uuid not null references public.isps(id) on delete cascade,
  category        text not null default 'other',
  amount          numeric(12,2) not null check (amount >= 0),
  date            date not null default current_date,
  supplier        text,
  description     text,
  is_recurring    boolean not null default false,
  recurrence      text check (recurrence in ('daily','weekly','monthly','quarterly','yearly')),
  recurring_until date,
  created_by      uuid references auth.users(id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index if not exists expenses_isp_idx on public.expenses(isp_id, date desc);

-- ── Inventory ───────────────────────────────────────────────────────────────
create table if not exists public.inventory_items (
  id            uuid primary key default gen_random_uuid(),
  isp_id        uuid not null references public.isps(id) on delete cascade,
  sku           text not null,
  name          text not null,
  category      text not null default 'other',
  unit          text not null default 'pcs',
  quantity      integer not null default 0 check (quantity >= 0),
  unit_cost     numeric(12,2) not null default 0,
  reorder_level integer not null default 0,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (isp_id, sku)
);
create index if not exists inventory_items_isp_idx on public.inventory_items(isp_id, category);

create table if not exists public.inventory_movements (
  id         uuid primary key default gen_random_uuid(),
  isp_id     uuid not null references public.isps(id) on delete cascade,
  item_id    uuid not null references public.inventory_items(id) on delete cascade,
  kind       text not null check (kind in ('purchase','issue','assign','return','damage','adjust')),
  quantity   integer not null,
  client_id  uuid references public.clients(id) on delete set null,
  note       text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists inventory_movements_isp_idx
  on public.inventory_movements(isp_id, created_at desc);

-- __SPLIT__
-- ── API keys & webhooks (ISP-scoped only) ──────────────────────────────────
create table if not exists public.isp_api_keys (
  id           uuid primary key default gen_random_uuid(),
  isp_id       uuid not null references public.isps(id) on delete cascade,
  name         text not null,
  key_prefix   text not null,               -- shown in the UI, e.g. 'isp_live_9f2a…'
  key_hash     text not null,               -- sha256; raw key shown once
  scopes       text[] not null default '{}',
  last_used_at timestamptz,
  expires_at   timestamptz,
  revoked_at   timestamptz,
  created_by   uuid references auth.users(id) on delete set null,
  created_at   timestamptz not null default now()
);
create index if not exists isp_api_keys_isp_idx on public.isp_api_keys(isp_id);

create table if not exists public.isp_webhooks (
  id           uuid primary key default gen_random_uuid(),
  isp_id       uuid not null references public.isps(id) on delete cascade,
  url          text not null,
  secret_encrypted text,                   -- encrypted at rest, never returned
  events       text[] not null default '{}',
  is_active    boolean not null default true,
  failure_count integer not null default 0,
  last_delivery_at timestamptz,
  last_status  integer,
  created_at   timestamptz not null default now()
);
create index if not exists isp_webhooks_isp_idx on public.isp_webhooks(isp_id);

create table if not exists public.webhook_deliveries (
  id          uuid primary key default gen_random_uuid(),
  isp_id      uuid not null references public.isps(id) on delete cascade,
  webhook_id  uuid not null references public.isp_webhooks(id) on delete cascade,
  event       text not null,
  payload     jsonb not null default '{}'::jsonb,
  status_code integer,
  ok          boolean not null default false,
  error       text,
  attempts    integer not null default 1,
  created_at  timestamptz not null default now()
);
create index if not exists webhook_deliveries_isp_idx
  on public.webhook_deliveries(isp_id, created_at desc);

-- ── Notifications (in-app inbox) ───────────────────────────────────────────
create table if not exists public.notifications (
  id         uuid primary key default gen_random_uuid(),
  isp_id     uuid not null references public.isps(id) on delete cascade,
  user_id    uuid references auth.users(id) on delete cascade,
  severity   text not null default 'info' check (severity in ('info','warning','critical')),
  title      text not null,
  body       text,
  link       text,
  read_at    timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists notifications_user_idx on public.notifications(user_id, created_at desc);

-- ── Staff roles & permissions (per-ISP) ────────────────────────────────────
create table if not exists public.isp_roles (
  id          uuid primary key default gen_random_uuid(),
  isp_id      uuid not null references public.isps(id) on delete cascade,
  key         text not null,
  name        text not null,
  description text,
  permissions text[] not null default '{}',
  is_system   boolean not null default false,
  unique (isp_id, key)
);
create index if not exists isp_roles_isp_idx on public.isp_roles(isp_id);

-- ── Permission catalog (single source of truth for the UI) ─────────────────
create table if not exists public.permission_definitions (
  key         text primary key,
  label       text not null,
  category    text not null,
  description text
);

insert into public.permission_definitions (key, label, category) values
  ('customers.view',     'View customers',        'Customers'),
  ('customers.create',   'Create customers',      'Customers'),
  ('customers.edit',     'Edit customers',        'Customers'),
  ('customers.delete',   'Delete customers',      'Customers'),
  ('packages.view',      'View packages',         'Services'),
  ('packages.manage',    'Manage packages',       'Services'),
  ('vouchers.view',      'View vouchers',         'Services'),
  ('vouchers.manage',    'Manage vouchers',       'Services'),
  ('routers.view',       'View routers',          'Network'),
  ('routers.manage',     'Manage routers',        'Network'),
  ('sessions.view',      'View sessions',         'Network'),
  ('sessions.disconnect','Disconnect sessions',   'Network'),
  ('payments.view',      'View payments',         'Billing'),
  ('payments.manage',    'Manage payments',       'Billing'),
  ('invoices.view',      'View invoices',         'Billing'),
  ('invoices.manage',    'Manage invoices',       'Billing'),
  ('sms.send',           'Send SMS',              'Communication'),
  ('sms.bulk',           'Send bulk SMS',         'Communication'),
  ('sms.manage',         'Manage SMS templates',  'Communication'),
  ('resellers.view',     'View resellers',        'Sales'),
  ('resellers.manage',   'Manage resellers',      'Sales'),
  ('commissions.view',   'View commissions',      'Sales'),
  ('commissions.manage', 'Manage commissions',    'Sales'),
  ('expenses.view',      'View expenses',         'Business'),
  ('expenses.manage',    'Manage expenses',       'Business'),
  ('inventory.view',     'View inventory',        'Business'),
  ('inventory.manage',   'Manage inventory',      'Business'),
  ('reports.view',       'View reports',          'Business'),
  ('staff.manage',       'Manage staff',          'Team'),
  ('settings.manage',    'Manage settings',       'Settings'),
  ('api.manage',         'Manage API & webhooks', 'Settings')
on conflict (key) do nothing;

-- ── Seed the default ISP roles when a tenant is created ────────────────────
create or replace function public.seed_default_roles(p_isp_id uuid)
  returns void language plpgsql security definer set search_path = public as $$
begin
  insert into public.isp_roles (isp_id, key, name, description, permissions, is_system) values
    (p_isp_id, 'administrator', 'ISP Administrator', 'Full access to everything in this ISP', ARRAY[
      'customers.view','customers.create','customers.edit','customers.delete',
      'packages.view','packages.manage','vouchers.view','vouchers.manage',
      'routers.view','routers.manage','sessions.view','sessions.disconnect',
      'payments.view','payments.manage','invoices.view','invoices.manage',
      'sms.send','sms.bulk','sms.manage',
      'resellers.view','resellers.manage','commissions.view','commissions.manage',
      'expenses.view','expenses.manage','inventory.view','inventory.manage','reports.view',
      'staff.manage','settings.manage','api.manage'
    ], true),
    (p_isp_id, 'billing_officer', 'Billing Officer', 'Customers, invoices and payments',
      ARRAY['customers.view','customers.edit','invoices.view','invoices.manage',
            'payments.view','payments.manage','sms.send','reports.view'], true),
    (p_isp_id, 'technician', 'Network Technician', 'Routers, sessions and diagnostics',
      ARRAY['routers.view','routers.manage','sessions.view','sessions.disconnect',
            'customers.view'], true),
    (p_isp_id, 'support', 'Customer Support', 'Customer care and SMS',
      ARRAY['customers.view','invoices.view','payments.view','sms.send','sms.bulk'], true),
    (p_isp_id, 'sales_agent', 'Sales Agent', 'Sales and reseller performance',
      ARRAY['customers.view','customers.create','payments.view','resellers.view',
            'commissions.view'], true),
    (p_isp_id, 'reseller_manager', 'Reseller Manager', 'Resellers and commissions',
      ARRAY['resellers.view','resellers.manage','commissions.view','commissions.manage',
            'customers.view'], true)
  on conflict (isp_id, key) do nothing;
end;
$$;

grant execute on function public.seed_default_roles(uuid) to authenticated;

-- Someone can be an agent at ISP A and an admin at ISP B.
create table if not exists public.profile_assignments (
  profile_id uuid not null references public.profiles(id) on delete cascade,
  isp_id     uuid not null references public.isps(id) on delete cascade,
  role_id    uuid references public.isp_roles(id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (profile_id, isp_id)
);

-- __SPLIT__
