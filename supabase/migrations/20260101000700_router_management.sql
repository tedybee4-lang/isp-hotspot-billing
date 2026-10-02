-- =============================================================================
--  MikroTik router management
--
--  Adds the missing pieces for real router integration:
--    * per-router connection settings (port, poll interval, enabled flag)
--    * a credentials table that holds ONLY ciphertext
--    * a poll log so a failing router is visible rather than silently "offline"
--
--  Credential model
--  ----------------
--  RouterOS passwords are encrypted in the Edge Function with a key held in the
--  function's own environment (ROUTER_CREDENTIALS_KEY). The database never
--  receives that key, so a leaked service-role key does not yield plaintext
--  router passwords.
--
--  router_credentials has RLS enabled with NO policy for `authenticated`, which
--  means tenant staff cannot read it at all. Only the service role (used by the
--  Edge Function) can.
-- =============================================================================

-- ── Router connection settings ───────────────────────────────────────────────
alter table public.nodes
  add column if not exists api_port          integer not null default 8728,
  add column if not exists enabled            boolean not null default true,
  add column if not exists poll_interval_secs integer not null default 120,
  add column if not exists last_poll_at       timestamptz,
  add column if not exists last_error         text,
  add column if not exists last_latency_ms    integer;

create index if not exists nodes_enabled_idx
  on public.nodes (isp_id, enabled) where enabled;

comment on column public.nodes.last_error is
  'Last poll failure reason. NULL means the last poll succeeded.';

-- ── Encrypted credentials ────────────────────────────────────────────────────
create table if not exists public.router_credentials (
  node_id             uuid primary key references public.nodes(id) on delete cascade,
  isp_id              uuid not null references public.isps(id) on delete cascade,
  username_ciphertext text not null,
  password_ciphertext text not null,
  algorithm           text not null default 'aes-256-gcm',
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create index if not exists router_credentials_isp_idx
  on public.router_credentials (isp_id);

alter table public.router_credentials enable row level security;

-- Deliberately no policies for `authenticated`. The service role bypasses RLS,
-- which is how the Edge Function reads these rows; a tenant ISP owner cannot
-- SELECT from this table even with a valid session.

-- ── Poll history ─────────────────────────────────────────────────────────────
-- Lets the UI show "last checked / failed / unreachable" instead of presenting
-- an empty or invented health reading.
create table if not exists public.router_poll_runs (
  id           uuid primary key default gen_random_uuid(),
  isp_id       uuid not null references public.isps(id) on delete cascade,
  node_id      uuid not null references public.nodes(id) on delete cascade,
  ok           boolean not null,
  error        text,
  latency_ms   integer,
  users_seen   integer,
  started_at   timestamptz not null default now()
);

create index if not exists router_poll_runs_node_idx
  on public.router_poll_runs (node_id, started_at desc);

alter table public.router_poll_runs enable row level security;

do $$
declare
  t text;
begin
  foreach t in array array['router_poll_runs'] loop
    execute format($f$
      drop policy if exists %I_read on public.%I;
      create policy %I_read on public.%I for select
        using (public.is_super_admin() or isp_id = public.current_isp_id());
    $f$, t || '_tenant', t, t || '_tenant', t);
  end loop;
end $$;

-- =============================================================================
--  Automatic polling
--
--  pg_cron calls the mikrotik-poll Edge Function every two minutes. Without
--  this the Routers screen only ever shows values the moment a user pressed
--  "Refresh", and a router that dies is not noticed until someone looks.
--
--  Set the project URL and service key before enabling:
--    update vault-like config below, then run the commented enable statement.
-- =============================================================================

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Store the two values pg_net needs. Read back with:
--   select * from cron.job_run_details order by start_time desc limit 5;
create table if not exists public.poller_config (
  id            boolean primary key default true,
  project_url   text not null,
  service_key   text not null,
  enabled       boolean not null default false,
  check (id)
);

comment on table public.poller_config is
  'Configuration for the pg_cron -> mikrotik-poll Edge Function job.';

alter table public.poller_config enable row level security;
-- Intentionally no policies: only the service role (Edge Function) reads this,
-- and it contains a service key. A super admin configures it over SQL.
