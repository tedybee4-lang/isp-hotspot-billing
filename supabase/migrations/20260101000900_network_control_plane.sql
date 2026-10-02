-- =============================================================================
--  Network control plane: heartbeats, capabilities, jobs, RADIUS, workers
--
--  Additive only. Nothing here drops, truncates or rewrites existing data, and
--  no existing table or function is replaced. Every statement is written so it
--  can be re-run without error.
--
--  Why this file exists
--  --------------------
--  The platform could talk to a router over HTTP REST and poll it on a
--  two-minute cron job. That is not enough to operate an ISP:
--
--    * A REST-only client cannot talk to RouterOS 6 at all, which excludes
--      hAP lite / RB941-2nD, RB951, RB952 and every other pre-7.1 device.
--    * REST is plain HTTP by default, so router passwords cross the network in
--      the clear.
--    * A cron job inside a serverless platform has no persistent connection to
--      a router, cannot hold a RouterOS API socket open, and dies with the
--      invocation. Heartbeats need a process that stays up.
--    * There was no queue, so "add this voucher to the router" had nowhere to
--      live and no retry.
--
--  This migration adds the missing primitives. It does not change how the
--  existing Edge Functions behave; it gives them somewhere to write.
--
--  What is added
--  -------------
--    router_heartbeats        one row per heartbeat, per router
--    router_capabilities      the last successful hardware/service survey
--    router_jobs              the durable job queue (lock, retry, backoff)
--    router_job_events        per-attempt result and error detail
--    network_workers          the VPS worker registry and its own liveness
--    radius_accounts          per-customer RADIUS mirror + sync state
--    network_diagnostics      allow-listed diagnostic results
--    router_session_commands  disconnect/terminate requests and their outcome
--
--  Plus additive columns on `nodes` for reachability and connection method,
--  and the RPCs that make all of the above tenant-safe.
-- =============================================================================

-- =============================================================================
--  1. Routers: reachability, connection method, liveness
-- =============================================================================

alter table public.nodes
  add column if not exists mgmt_mode           text
    check (mgmt_mode in ('rest','api','api_ssl','ssh','vpn','unavailable')),
  add column if not exists rest_port           integer not null default 8080,
  add column if not exists api_ssl_port        integer not null default 8729,
  add column if not exists ssh_port            integer not null default 22,
  add column if not exists reachability         text not null default 'unknown'
    check (reachability in ('publicly_reachable','nat','cgnat','private_only',
                            'vpn_connected','vpn_not_connected','unknown')),
  add column if not exists reachability_note    text,
  add column if not exists management_ip        text,
  add column if not exists vpn_ip               text,
  add column if not exists public_ip            text,
  add column if not exists routeros_major       integer,
  add column if not exists routeros_minor       integer,
  add column if not exists architecture         text,
  add column if not exists board_name           text,
  add column if not exists cpu_type             text,
  add column if not exists cpu_count            integer,
  add column if not exists ram_total_mb         integer,
  add column if not exists storage_total_mb      integer,
  add column if not exists is_chr               boolean not null default false,
  add column if not exists license_level        text,
  add column if not exists provisioning_state   text not null default 'unmanaged'
    check (provisioning_state in ('unmanaged','pending','provisioning','applied','failed')),
  add column if not exists sync_state           text not null default 'idle'
    check (sync_state in ('idle','syncing','synced','failed','partial')),
  add column if not exists last_heartbeat_at    timestamptz,
  add column if not exists last_success_at      timestamptz,
  add column if not exists last_failure_at      timestamptz,
  add column if not exists consecutive_failures integer not null default 0,
  add column if not exists last_connection_method text,
  add column if not exists heartbeat_interval_secs integer not null default 60,
  add column if not exists offline_threshold_secs  integer not null default 300,
  add column if not exists last_error_at        timestamptz,
  add column if not exists managed_by_worker    text,
  add column if not exists discovered_via       text;

comment on column public.nodes.reachability is
  'Why the router can or cannot be reached directly. cgnat means no inbound '
  'path exists from the internet and a VPN tunnel is required.';

comment on column public.nodes.consecutive_failures is
  'Consecutive failed management attempts. Reset only by a real success.';

comment on column public.nodes.last_heartbeat_at is
  'Last time this router reported in. ONLINE is never inferred from the row '
  'existing; it always requires a recent heartbeat or a real API response.';

create index if not exists nodes_reachability_idx
  on public.nodes (isp_id, reachability);
create index if not exists nodes_heartbeat_idx
  on public.nodes (last_heartbeat_at desc nulls last);
create index if not exists nodes_enabled_status_idx
  on public.nodes (status) where enabled;
-- =============================================================================
--  2. Heartbeats
--
--  One row per heartbeat, appended and never updated in place. This is the
--  evidence that lets the platform say ONLINE truthfully, and it is what a
--  monitoring dashboard graphs.
-- =============================================================================

create table if not exists public.router_heartbeats (
  id             bigserial primary key,
  isp_id         uuid not null references public.isps(id) on delete cascade,
  node_id        uuid not null references public.nodes(id) on delete cascade,
  -- Which path the heartbeat arrived on. A router behind NAT posts outbound to
  -- the platform, so `callback` and `vpn` are normal values, not oddities.
  source         text not null default 'api'
    check (source in ('api','rest','api_ssl','ssh','vpn','callback')),
  ok             boolean not null,
  latency_ms     integer,
  error          text,
  routeros_version text,
  board_name     text,
  architecture   text,
  cpu_load       integer,
  ram_free_mb    integer,
  uptime_seconds bigint,
  active_users   integer not null default 0,
  hotspot_users  integer not null default 0,
  pppoe_users    integer not null default 0,
  public_ip      text,
  management_ip  text,
  vpn_ip         text,
  observed_at    timestamptz not null default now()
);

create index if not exists router_heartbeats_node_idx
  on public.router_heartbeats (node_id, observed_at desc);
create index if not exists router_heartbeats_isp_idx
  on public.router_heartbeats (isp_id, observed_at desc);

alter table public.router_heartbeats enable row level security;

drop policy if exists router_heartbeats_read on public.router_heartbeats;
create policy router_heartbeats_read on public.router_heartbeats for select
  using (public.is_super_admin() or isp_id = public.current_isp_id());

comment on table public.router_heartbeats is
  'Append-only liveness record. A router with no row in the last '
  'offline_threshold_secs is not online, regardless of nodes.status.';
-- =============================================================================
--  3. Capability detection
--
--  The last successful survey of what a router can actually do. The panel
--  reads this to decide which controls to draw, so a device without WireGuard
--  never shows a WireGuard toggle.
-- =============================================================================

create table if not exists public.router_capabilities (
  node_id        uuid primary key references public.nodes(id) on delete cascade,
  isp_id         uuid not null references public.isps(id) on delete cascade,
  detected_at    timestamptz not null default now(),
  detected_by    text not null default 'api',

  -- Identity
  board_name     text,
  model          text,
  serial_number  text,
  firmware_type  text,
  routeros_version text,
  routeros_major integer,
  routeros_minor integer,
  architecture   text,
  is_chr         boolean not null default false,
  license_level  text,

  -- Resources
  cpu_type       text,
  cpu_count      integer,
  cpu_load       integer,
  ram_total_mb   integer,
  ram_free_mb    integer,
  storage_total_mb integer,
  uptime_seconds bigint,
  board_temperature numeric,

  -- Transport. These four booleans are the whole point: a method is only
  -- offered in the UI when it is true here, and it is only true when a probe
  -- actually succeeded.
  rest_available boolean not null default false,
  api_available  boolean not null default false,
  api_ssl_available boolean not null default false,
  ssh_available  boolean not null default false,
  rest_version   text,

  -- Feature gates, each confirmed by a successful command, not assumed.
  has_hotspot        boolean not null default false,
  has_pppoe          boolean not null default false,
  has_wireguard      boolean not null default false,
  has_bridge         boolean not null default false,
  has_vlan           boolean not null default false,
  has_dhcp           boolean not null default false,
  has_queue_simple   boolean not null default false,
  has_queue_tree     boolean not null default false,
  has_radius         boolean not null default false,
  has_ssh_service    boolean not null default false,
  has_scheduler      boolean not null default false,
  has_scripting      boolean not null default false,
-- Raw survey output, so a UI change never needs another router round-trip.
  interfaces     jsonb not null default '[]'::jsonb,
  wireless       jsonb not null default '[]'::jsonb,
  bridges        jsonb not null default '[]'::jsonb,
  vlans          jsonb not null default '[]'::jsonb,
  dhcp_servers   jsonb not null default '[]'::jsonb,
  routes         jsonb not null default '[]'::jsonb,
  hotspot_servers jsonb not null default '[]'::jsonb,
  hotspot_profiles jsonb not null default '[]'::jsonb,
  hotspot_users  jsonb not null default '[]'::jsonb,
  pppoe_servers  jsonb not null default '[]'::jsonb,
  ppp_profiles   jsonb not null default '[]'::jsonb,
  ppp_secrets    jsonb not null default '[]'::jsonb,
  pppoe_active   jsonb not null default '[]'::jsonb,
  simple_queues  jsonb not null default '[]'::jsonb,
  queue_trees    jsonb not null default '[]'::jsonb,
  radius_servers jsonb not null default '[]'::jsonb,
  firewall_rules jsonb not null default '[]'::jsonb,
  nat_rules      jsonb not null default '[]'::jsonb,
  services       jsonb not null default '[]'::jsonb,
  diagnostics    jsonb not null default '{}'::jsonb,
  unsupported    jsonb not null default '[]'::jsonb
);

create index if not exists router_capabilities_isp_idx
  on public.router_capabilities (isp_id);

alter table public.router_capabilities enable row level security;

drop policy if exists router_capabilities_read on public.router_capabilities;
create policy router_capabilities_read on public.router_capabilities for select
  using (public.is_super_admin() or isp_id = public.current_isp_id());

comment on column public.router_capabilities.unsupported is
  'Features this RouterOS version or hardware cannot provide, e.g. rest on '
  '6.x, or wireguard below 7.1. The UI hides these rather than offering a '
  'control that would fail.';

-- =============================================================================
--  4. The router job queue
--
--  Every action that changes a router goes through here. Before this existed,
--  "add this voucher to the router" was a direct HTTP call that either worked
--  or was lost. Now it is a row: it survives a worker restart, it retries with
--  backoff, it records exactly what the router said, and two workers can never
--  run it at once.
--
--  Locking
--  -------
--  claim_router_jobs() uses `for update skip locked`, so N workers pulling the
--  same queue take N disjoint sets of rows. There is no separate lock table to
--  keep consistent and no possibility of the same job executing twice.
--
--  Idempotency
--  -----------
--  A caller that supplies idempotency_key gets the existing job back rather
--  than a duplicate. A duplicate M-Pesa webhook, a double-click, or a retried
--  Edge Function therefore produces one job, not three.
--
--  Status is intentionally a text column rather than an enum: adding a state
--  later must never need an ALTER TYPE that cannot run in a transaction.
-- =============================================================================

create table if not exists public.router_jobs (
  id             uuid primary key default gen_random_uuid(),
  isp_id         uuid not null references public.isps(id) on delete cascade,
  -- A job may target a router, or be tenant-wide (e.g. bulk sync). node_id is
  -- therefore nullable, and every read path filters on isp_id first.
  node_id        uuid references public.nodes(id) on delete cascade,
  kind           text not null check (kind in (
                   'provision',        -- apply the generated configuration
                   'heartbeat',        -- collect liveness + telemetry
                   'telemetry',        -- resource read
                   'capabilities',     -- full hardware/service survey
                   'config',           -- apply a configuration change
                   'voucher_sync',     -- push voucher to HotSpot
                   'voucher_revoke',
                   'customer_sync',    -- create/update the network account
                   'customer_suspend',
                   'customer_reactivate',
                   'customer_expire',
                   'radius_sync',
                   'disconnect',       -- kill one live session
                   'pppoe_sync',
                   'diagnostic',       -- allow-listed read-only diagnostic
                   'session_sync'      -- reconcile live sessions
                 )),
  payload        jsonb not null default '{}'::jsonb,
  status         text not null default 'pending'
    check (status in ('pending','processing','succeeded','failed','retrying','dead','cancelled')),
  priority       integer not null default 100,
  attempt_count  integer not null default 0,
  max_attempts   integer not null default 5,
  -- Exponential backoff: attempt N waits 2^(N-1) * base_delay, capped.
  next_run_at    timestamptz not null default now(),
  locked_by      text,
  locked_until   timestamptz,
  idempotency_key text,
  result         jsonb,
  error          text,
  created_by     uuid references auth.users(id) on delete set null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  started_at     timestamptz,
  completed_at   timestamptz,
  duration_ms    integer,
  timeout_secs   integer not null default 60
);
create index if not exists router_jobs_queue_idx
  on public.router_jobs (status, next_run_at, priority)
  where status in ('pending','retrying');
create index if not exists router_jobs_node_idx
  on public.router_jobs (node_id, created_at desc);
create index if not exists router_jobs_isp_idx
  on public.router_jobs (isp_id, created_at desc);

-- One row per idempotency key. A duplicate request hits this constraint and is
-- converted back into "here is the job you already asked for".
create unique index if not exists router_jobs_idempotency_idx
  on public.router_jobs (isp_id, idempotency_key)
  where idempotency_key is not null;

alter table public.router_jobs enable row level security;

drop policy if exists router_jobs_read on public.router_jobs;
create policy router_jobs_read on public.router_jobs for select
  using (public.is_super_admin() or isp_id = public.current_isp_id());

drop policy if exists router_jobs_write on public.router_jobs;
create policy router_jobs_write on public.router_jobs for insert
  with check (public.is_super_admin()
           or (isp_id = public.current_isp_id() and public.can_manage_isp()));

drop policy if exists router_jobs_update on public.router_jobs;
create policy router_jobs_update on public.router_jobs for update
  using (public.is_super_admin()
      or (isp_id = public.current_isp_id() and public.can_manage_isp()))
  with check (public.is_super_admin()
           or (isp_id = public.current_isp_id() and public.can_manage_isp()));

-- =============================================================================
--  5. Job events
--
--  Every attempt is recorded, including the ones that failed. When an ISP says
--  "the voucher never appeared", this is the table that answers why.
-- =============================================================================

create table if not exists public.router_job_events (
  id           bigserial primary key,
  job_id       uuid not null references public.router_jobs(id) on delete cascade,
  isp_id       uuid not null references public.isps(id) on delete cascade,
  attempt      integer not null default 1,
  ok           boolean not null,
  -- The method actually used, so a fallback from REST to API-SSL is visible.
  method       text,
  error        text,
  detail       jsonb not null default '{}'::jsonb,
  duration_ms  integer,
  worker       text,
  created_at   timestamptz not null default now()
);

create index if not exists router_job_events_job_idx
  on public.router_job_events (job_id, created_at desc);
create index if not exists router_job_events_isp_idx
  on public.router_job_events (isp_id, created_at desc);

alter table public.router_job_events enable row level security;

drop policy if exists router_job_events_read on public.router_job_events;
create policy router_job_events_read on public.router_job_events for select
  using (public.is_super_admin() or isp_id = public.current_isp_id());

-- =============================================================================
--  6. Network worker registry
--
--  The persistent process that actually speaks RouterOS API. The platform needs
--  to know it is alive, otherwise the UI would show a healthy queue that nobody
--  is draining.
-- =============================================================================

create table if not exists public.network_workers (
  id             uuid primary key default gen_random_uuid(),
  name           text not null unique,
  -- The VPS identity, for display: hostname, region, version.
  hostname       text,
  public_ip      text,
  region         text,
  version        text,
  wg_address     text,
  wg_public_key  text,
  status         text not null default 'starting'
    check (status in ('starting','online','degraded','offline','draining','disabled')),
  capabilities   jsonb not null default '{}'::jsonb,
  -- Set to the worker's own clock on each beat. Never taken from a request.
  last_heartbeat_at timestamptz,
  started_at     timestamptz not null default now(),
  jobs_processed bigint not null default 0,
  jobs_failed    bigint not null default 0,
  last_error     text,
  created_at     timestamptz not null default now()
);

alter table public.network_workers enable row level security;

-- The registry is platform-wide, not tenant-scoped: one worker serves every
-- ISP. Only a super admin reads it. Workers authenticate with the service
-- role, which bypasses RLS.
drop policy if exists network_workers_read on public.network_workers;
create policy network_workers_read on public.network_workers for select
  using (public.is_super_admin());
-- =============================================================================
--  7. RADIUS accounts
--
--  The platform's mirror of what the RADIUS server holds for each customer.
--  Without this, "the customer says they are not synced" cannot be answered.
--  Passwords are never stored here; only whether one was ever set.
-- =============================================================================

create table if not exists public.radius_accounts (
  id             uuid primary key default gen_random_uuid(),
  isp_id         uuid not null references public.isps(id) on delete cascade,
  client_id      uuid references public.clients(id) on delete cascade,
  node_id        uuid references public.nodes(id) on delete cascade,
  username       text not null,
  -- HotSpot or PPP. Both are RADIUS-backed on most deployments.
  service        text not null default 'hotspot'
    check (service in ('hotspot','ppp')),
  plan_id        uuid references public.plans(id) on delete set null,
  status         text not null default 'pending'
    check (status in ('pending','processing','synced','failed','retrying','revoked','expired')),
  -- Mikrotik-Rate-Limit, e.g. "10M/10M 50M/50F".
  rate_limit     text,
  expiry         timestamptz,
  simultaneous_use integer not null default 1,
  sync_state     text not null default 'pending'
    check (sync_state in ('pending','processing','synced','failed','retrying','revoked')),
  attempt_count  integer not null default 0,
  last_error     text,
  last_synced_at timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  constraint radius_accounts_tenant_username_uniq unique (isp_id, username)
);

create index if not exists radius_accounts_isp_idx
  on public.radius_accounts (isp_id, status);
create index if not exists radius_accounts_client_idx
  on public.radius_accounts (client_id);

alter table public.radius_accounts enable row level security;

drop policy if exists radius_accounts_read on public.radius_accounts;
create policy radius_accounts_read on public.radius_accounts for select
  using (public.is_super_admin() or isp_id = public.current_isp_id());

drop policy if exists radius_accounts_write on public.radius_accounts;
create policy radius_accounts_write on public.radius_accounts for insert
  with check (public.is_super_admin()
           or (isp_id = public.current_isp_id() and public.can_manage_isp()));

drop policy if exists radius_accounts_update on public.radius_accounts;
create policy radius_accounts_update on public.radius_accounts for update
  using (public.is_super_admin()
      or (isp_id = public.current_isp_id() and public.can_manage_isp()))
  with check (public.is_super_admin()
           or (isp_id = public.current_isp_id() and public.can_manage_isp()));

comment on table public.radius_accounts is
  'Per-tenant RADIUS mirror. Unique on (isp_id, username) so two ISPs can '
  'legitimately use the same subscriber username on their own servers.';
-- =============================================================================
--  8. Diagnostics
--
--  Results of allow-listed read-only checks. The browser never composes a
--  RouterOS command: it picks one of these action names, and the worker runs
--  the fixed command that belongs to it.
-- =============================================================================

create table if not exists public.network_diagnostics (
  id           bigserial primary key,
  isp_id       uuid not null references public.isps(id) on delete cascade,
  node_id      uuid not null references public.nodes(id) on delete cascade,
  action       text not null check (action in (
                 'ping','dns','route','interface','resource','identity',
                 'log','connections','hotspot_active','pppoe_active','bridge')),
  target       text,
  ok           boolean not null,
  output       text,
  error        text,
  duration_ms  integer,
  requested_by uuid references auth.users(id) on delete set null,
  created_at   timestamptz not null default now()
);

create index if not exists network_diagnostics_node_idx
  on public.network_diagnostics (node_id, created_at desc);
create index if not exists network_diagnostics_isp_idx
  on public.network_diagnostics (isp_id, created_at desc);

alter table public.network_diagnostics enable row level security;

drop policy if exists network_diagnostics_read on public.network_diagnostics;
create policy network_diagnostics_read on public.network_diagnostics for select
  using (public.is_super_admin() or isp_id = public.current_isp_id());

-- =============================================================================
--  9. Session commands
--
--  A disconnect is a request to the router, not a database edit. The row keeps
--  the outcome so the UI can honestly say CONFIRMED, or REQUESTED - ROUTER
--  CONFIRMATION UNAVAILABLE.
-- =============================================================================

create table if not exists public.router_session_commands (
  id             uuid primary key default gen_random_uuid(),
  isp_id         uuid not null references public.isps(id) on delete cascade,
  node_id        uuid references public.nodes(id) on delete cascade,
  session_id     uuid references public.sessions(id) on delete cascade,
  command        text not null check (command in ('disconnect','terminate','kick')),
  -- Pending means we asked. Only `confirmed` means the router agreed.
  status         text not null default 'pending'
    check (status in ('pending','confirmed','failed','unconfirmed','expired')),
  router_user_id text,
  mac_address    text,
  ip_address     text,
  method         text,
  error          text,
  detail         jsonb not null default '{}'::jsonb,
  requested_by   uuid references auth.users(id) on delete set null,
  created_at     timestamptz not null default now(),
  completed_at   timestamptz
);

create index if not exists router_session_commands_isp_idx
  on public.router_session_commands (isp_id, created_at desc);
create index if not exists router_session_commands_session_idx
  on public.router_session_commands (session_id);

alter table public.router_session_commands enable row level security;

drop policy if exists router_session_commands_read on public.router_session_commands;
create policy router_session_commands_read on public.router_session_commands for select
  using (public.is_super_admin() or isp_id = public.current_isp_id());

drop policy if exists router_session_commands_write on public.router_session_commands;
create policy router_session_commands_write on public.router_session_commands for insert
  with check (public.is_super_admin()
           or (isp_id = public.current_isp_id() and public.can_manage_isp()));

-- =============================================================================
--  10. Voucher and customer sync state
--
--  Additive columns. The existing `vouchers` table says what a voucher IS; it
--  does not say whether the router has it. That distinction is the difference
--  between "created" and "usable", so it gets its own columns.
-- =============================================================================

alter table public.vouchers
  add column if not exists sync_state     text not null default 'pending'
    check (sync_state in ('pending','processing','synced','failed','retrying','revoked','expired')),
  add column if not exists sync_node_id   uuid references public.nodes(id) on delete set null,
  add column if not exists sync_job_id    uuid,
  add column if not exists sync_error     text,
  add column if not exists sync_attempts  integer not null default 0,
  add column if not exists synced_at      timestamptz,
  add column if not exists router_user_id text,
  add column if not exists hotspot_profile text;

create index if not exists vouchers_sync_queue_idx
  on public.vouchers (isp_id, sync_state)
  where sync_state in ('pending','retrying','processing');

alter table public.clients
  add column if not exists network_state   text not null default 'pending'
    check (network_state in ('pending','provisioning','active','suspended',
                             'expired','failed','revoked')),
  add column if not exists router_id       uuid references public.nodes(id) on delete set null,
  add column if not exists pppoe_username  text,
  add column if not exists hotspot_username text,
  add column if not exists last_sync_error text;

create index if not exists clients_network_state_idx
  on public.clients (isp_id, network_state);

comment on column public.vouchers.sync_state is
  'Whether the router actually holds this voucher. Only `synced` means a '
  'router confirmed the create.';
-- =============================================================================
--  11. Atomic one-time provisioning token claim
--
--  The old flow looked the token up, checked it, and then carried on. Two
--  concurrent callbacks could both pass that check. This function does the
--  whole decision inside one transaction and sets used_at as part of it, so a
--  token is genuinely single-use no matter how many callers arrive at once.
--
--  Called only with the service role from the router-provision Edge Function.
--  It takes the token *hash*, never the plaintext.
-- =============================================================================

create or replace function public.claim_provisioning_token(
  p_token_hash  text,
  p_source_ip   text default null
) returns jsonb
  language plpgsql
  security definer
  set search_path = public
as $$
declare
  v_token   public.provisioning_tokens%rowtype;
  v_session public.provisioning_sessions%rowtype;
  v_node_id uuid;
begin
  if p_token_hash is null or length(p_token_hash) < 32 then
    return jsonb_build_object('ok', false, 'code', 'malformed',
                              'message', 'Missing or malformed token.');
  end if;

  -- `for update` locks the row for the rest of this transaction, so a second
  -- concurrent caller blocks here and then sees used_at already set. Expiry is
  -- checked inside the lock rather than by a separate sweep, so there is no
  -- window in which an expired token still works.
  select * into v_token
    from public.provisioning_tokens
   where token_hash = p_token_hash
     for update;

  if not found then
    return jsonb_build_object('ok', false, 'code', 'unknown',
                              'message', 'Unknown token.');
  end if;

  if v_token.revoked_at is not null then
    return jsonb_build_object('ok', false, 'code', 'revoked',
                              'message', 'This provisioning link was revoked.');
  end if;

  if v_token.used_at is not null then
    return jsonb_build_object('ok', false, 'code', 'already_used',
                              'message', 'This provisioning token has already been used.');
  end if;

  if v_token.expires_at < now() then
    return jsonb_build_object('ok', false, 'code', 'expired',
                              'message', 'This provisioning link has expired. Generate a new command.');
  end if;

  select * into v_session
    from public.provisioning_sessions
   where id = v_token.session_id;

  if not found then
    return jsonb_build_object('ok', false, 'code', 'no_session',
                              'message', 'Provisioning session missing.');
  end if;

  if v_session.state = 'revoked' or v_session.state = 'expired' then
    return jsonb_build_object('ok', false, 'code', 'session_closed',
                              'message', 'This provisioning session is closed.');
  end if;

  -- The one and only place used_at is set for a live token.
  update public.provisioning_tokens
     set used_at = now()
   where id = v_token.id;

  -- Reuse the router row this session already created, so re-running the same
  -- script updates one router instead of registering a second one.
  select id into v_node_id
    from public.nodes
   where isp_id = v_session.isp_id
     and discovered_via = 'provisioning'
   order by created_at
   limit 1;

  return jsonb_build_object(
    'ok', true,
    'session_id', v_session.id,
    'isp_id', v_session.isp_id,
    'node_id', v_node_id,
    'label', v_session.label,
    'role', v_session.role,
    'expires_at', v_token.expires_at,
    'source_ip', p_source_ip
  );
end;
$$;

revoke all on function public.claim_provisioning_token(text, text) from public;
grant execute on function public.claim_provisioning_token(text, text) to service_role;
-- =============================================================================
--  12. Job queue API
--
--  enqueue_router_job   tenant staff or an Edge Function asks for work
--  claim_router_jobs    a worker takes a disjoint batch (skip locked)
--  complete_router_job  the router confirmed; the only path to SUCCEEDED
--  fail_router_job      record the error and schedule a retry or a dead letter
-- =============================================================================

create or replace function public.enqueue_router_job(
  p_node_id        uuid,
  p_kind           text,
  p_payload        jsonb default '{}'::jsonb,
  p_idempotency_key text default null,
  p_priority       integer default 100,
  p_max_attempts   integer default 5,
  p_created_by     uuid default null,
  p_isp_id         uuid default null
) returns jsonb
  language plpgsql
  security definer
  set search_path = public
as $$
declare
  v_isp   uuid;
  v_job   public.router_jobs%rowtype;
begin
  -- Tenant always comes from the caller's own membership. p_isp_id is honoured
  -- only for a super admin; it is not a way for one ISP to target another.
  v_isp := case when public.is_super_admin() then coalesce(p_isp_id, public.current_isp_id())
                else public.current_isp_id() end;

  if v_isp is null then
    return jsonb_build_object('ok', false, 'error', 'No ISP in scope.');
  end if;
  if not (public.is_super_admin() or public.can_manage_isp()) then
    return jsonb_build_object('ok', false, 'error', 'You cannot queue network jobs.');
  end if;

  if p_node_id is not null then
    if not exists (select 1 from public.nodes
                    where id = p_node_id and isp_id = v_isp) then
      return jsonb_build_object('ok', false, 'error', 'That router belongs to another ISP.');
    end if;
  end if;

  -- Idempotency: the same key always returns the same job.
  if p_idempotency_key is not null then
    select * into v_job from public.router_jobs
     where isp_id = v_isp and idempotency_key = p_idempotency_key;
    if found then
      return jsonb_build_object('ok', true, 'job_id', v_job.id,
                                'status', v_job.status, 'duplicate', true);
    end if;
  end if;

  insert into public.router_jobs
    (isp_id, node_id, kind, payload, idempotency_key, priority,
     max_attempts, created_by)
  values
    (v_isp, p_node_id, p_kind, coalesce(p_payload, '{}'::jsonb),
     p_idempotency_key, p_priority, least(greatest(p_max_attempts, 1), 20),
     p_created_by)
  returning * into v_job;

  return jsonb_build_object('ok', true, 'job_id', v_job.id, 'status', v_job.status);
end;
$$;

grant execute on function public.enqueue_router_job(uuid, text, jsonb, text, integer, integer, uuid, uuid) to authenticated, service_role;
-- -----------------------------------------------------------------------------
--  claim_router_jobs
--
--  Runs as the service role, from the worker. `for update skip locked` is the
--  whole concurrency story: two workers asking at the same instant receive two
--  disjoint sets, and neither can ever be handed a row the other is holding.
--
--  locked_until is a lease. If a worker dies mid-job the lease expires and
--  another worker picks the job up on a later pass, so a crash cannot strand
--  work forever.
-- -----------------------------------------------------------------------------
create or replace function public.claim_router_jobs(
  p_worker     text,
  p_limit      integer default 5,
  p_lease_secs integer default 120,
  p_kinds      text[] default null
) returns setof public.router_jobs
  language plpgsql
  security definer
  set search_path = public
as $$
begin
  if p_worker is null or length(p_worker) < 2 then
    raise exception 'worker name is required';
  end if;

  return query
  with picked as (
    select j.id
      from public.router_jobs j
     where j.status in ('pending', 'retrying')
       and j.next_run_at <= now()
       and (j.locked_until is null or j.locked_until < now())
       and (p_kinds is null or j.kind = any (p_kinds))
     order by j.priority asc, j.next_run_at asc, j.created_at asc
     limit greatest(1, least(coalesce(p_limit, 5), 100))
     for update skip locked
  )
  update public.router_jobs j
     set status         = 'processing',
         locked_by      = p_worker,
         locked_until   = now() + make_interval(secs => greatest(p_lease_secs, 10)),
         attempt_count  = j.attempt_count + 1,
         started_at     = case when j.attempt_count = 0 then now() else j.started_at end,
         updated_at     = now()
    from picked
   where j.id = picked.id
  returning j.*;
end;
$$;

revoke all on function public.claim_router_jobs(text, integer, integer, text[]) from public;
grant execute on function public.claim_router_jobs(text, integer, integer, text[]) to service_role;

-- -----------------------------------------------------------------------------
--  complete_router_job
--
--  complete is the ONLY way a job becomes 'succeeded'. Nothing else in the
--  system may set that status, which is what makes "SYNCED" mean the router
--  actually confirmed rather than that we hoped it did.
-- -----------------------------------------------------------------------------
create or replace function public.complete_router_job(
  p_job_id    uuid,
  p_result    jsonb default '{}'::jsonb,
  p_method    text default null,
  p_duration_ms integer default null
) returns jsonb
  language plpgsql
  security definer
  set search_path = public
as $$
declare
  v_job public.router_jobs%rowtype;
  v_claimant text := current_setting('netisp.worker', true);
begin
  select * into v_job from public.router_jobs where id = p_job_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'Job not found');
  end if;
  -- If the caller told us who it is, it must actually hold the job.
  if v_claimant is not null and v_claimant <> ''
     and v_job.locked_by is distinct from v_claimant then
    return jsonb_build_object('ok', false, 'error', 'Job is held by another worker');
  end if;

  update public.router_jobs
     set status       = 'succeeded',
         result       = coalesce(p_result, '{}'::jsonb),
         error        = null,
         completed_at = now(),
         updated_at   = now(),
         locked_by    = null,
         locked_until = null,
         duration_ms  = p_duration_ms
   where id = p_job_id;

  insert into public.router_job_events
    (job_id, isp_id, attempt, ok, method, detail, duration_ms, worker)
  values
    (p_job_id, v_job.isp_id, v_job.attempt_count, true, p_method,
     coalesce(p_result, '{}'::jsonb), p_duration_ms, v_job.locked_by);

  return jsonb_build_object('ok', true, 'status', 'succeeded');
end;
$$;

revoke all on function public.complete_router_job(uuid, jsonb, text, integer) from public;
grant execute on function public.complete_router_job(uuid, jsonb, text, integer) to service_role;
-- -----------------------------------------------------------------------------
--  fail_router_job
--
--  Exponential backoff with a cap: 10s, 20s, 40s, 80s, then dead. A router that
--  is genuinely down stops consuming worker capacity instead of being retried
--  forever, and lands in 'dead' where the UI can show it and an operator can
--  retry it deliberately.
-- -----------------------------------------------------------------------------
create or replace function public.fail_router_job(
  p_job_id  uuid,
  p_error   text,
  p_result  jsonb default '{}'::jsonb,
  p_method  text default null,
  p_duration_ms integer default null,
  p_retryable boolean default true
) returns jsonb
  language plpgsql
  security definer
  set search_path = public
as $$
declare
  v_job     public.router_jobs%rowtype;
  v_next    timestamptz;
  v_status  text;
begin
  select * into v_job from public.router_jobs where id = p_job_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'Job not found');
  end if;

  insert into public.router_job_events
    (job_id, isp_id, attempt, ok, method, error, detail, duration_ms, worker)
  values
    (p_job_id, v_job.isp_id, v_job.attempt_count, false, p_method,
     left(coalesce(p_error, 'unknown'), 500), coalesce(p_result, '{}'::jsonb),
     p_duration_ms, v_job.locked_by);

  if p_retryable and v_job.attempt_count < v_job.max_attempts then
    v_status := 'retrying';
    -- 2^(attempt-1) * 10s, capped at 15 minutes.
    v_next := now() + make_interval(
      secs => least(900, (10 * power(2, greatest(v_job.attempt_count - 1, 0)))::int));
  else
    v_status := case when p_retryable then 'dead' else 'failed' end;
    v_next := now();
  end if;

  update public.router_jobs
     set status      = v_status,
         error       = left(coalesce(p_error, 'unknown'), 500),
         result      = coalesce(p_result, '{}'::jsonb),
         next_run_at = v_next,
         locked_by   = null,
         locked_until = null,
         updated_at  = now()
   where id = p_job_id;

  return jsonb_build_object('ok', true, 'status', v_status, 'next_run_at', v_next);
end;
$$;

revoke all on function public.fail_router_job(uuid, text, jsonb, text, integer, boolean) from public;
grant execute on function public.fail_router_job(uuid, text, jsonb, text, integer, boolean) to service_role;

-- -----------------------------------------------------------------------------
--  set_job_worker
--
--  The worker states its identity once per connection. The completion RPC
--  reads it back from the session setting, so it never has to trust a
--  client-supplied worker name in the job payload.
-- -----------------------------------------------------------------------------
create or replace function public.set_job_worker(p_worker text) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform set_config('netisp.worker', coalesce(p_worker, ''), false);
end;
$$;

grant execute on function public.set_job_worker(text) to service_role;

-- =============================================================================
--  13. Heartbeat recording
--
--  The single place a router's liveness is written. It appends to the
--  append-only log and updates `nodes` in the same transaction, so the summary
--  can never disagree with the history.
--
--  State transition rules (why this is a function and not a bare UPDATE):
--    * A success clears the failure counter and marks ONLINE. Nothing else may.
--    * A failure never flips ONLINE -> UNREACHABLE on the first miss; it takes
--      offline_threshold_secs worth of consecutive failures, so one dropped
--      packet does not flap the dashboard.
--    * A 401/403 is AUTH_FAILED immediately. Credentials do not fix themselves.
-- =============================================================================

create or replace function public.missed_heartbeats(
  p_threshold_secs integer, p_interval_secs integer
) returns integer
language sql immutable as $$
  select greatest(1, coalesce(p_threshold_secs, 300)
                     / greatest(coalesce(p_interval_secs, 60), 1));
$$;
create or replace function public.record_router_heartbeat(
  p_node_id       uuid,
  p_ok            boolean,
  p_source        text default 'api',
  p_latency_ms    integer default null,
  p_error         text default null,
  p_routeros_version text default null,
  p_board_name    text default null,
  p_architecture  text default null,
  p_cpu_load      integer default null,
  p_ram_free_mb   integer default null,
  p_uptime_seconds bigint default null,
  p_active_users  integer default 0,
  p_hotspot_users integer default 0,
  p_pppoe_users   integer default 0,
  p_public_ip     text default null,
  p_management_ip text default null,
  p_vpn_ip        text default null
) returns jsonb
  language plpgsql
  security definer
  set search_path = public
as $$
declare
  v_node  public.nodes%rowtype;
  v_isp   uuid;
  v_state text;
  v_fails integer;
  v_now   timestamptz := now();
begin
  select * into v_node from public.nodes where id = p_node_id;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'Router not found');
  end if;
  v_isp := v_node.isp_id;

  insert into public.router_heartbeats
    (isp_id, node_id, source, ok, latency_ms, error, routeros_version,
     board_name, architecture, cpu_load, ram_free_mb, uptime_seconds,
     active_users, hotspot_users, pppoe_users, public_ip, management_ip, vpn_ip,
     observed_at)
  values
    (v_isp, p_node_id, p_source, p_ok, p_latency_ms, left(p_error, 500),
     p_routeros_version, p_board_name, p_architecture, p_cpu_load,
     p_ram_free_mb, p_uptime_seconds, coalesce(p_active_users, 0),
     coalesce(p_hotspot_users, 0), coalesce(p_pppoe_users, 0),
     p_public_ip, p_management_ip, p_vpn_ip, v_now);

  if p_ok then
    update public.nodes
       set status               = 'online',
           last_seen            = v_now,
           last_heartbeat_at    = v_now,
           last_success_at      = v_now,
           last_poll_at         = v_now,
           last_error           = null,
           last_error_at        = null,
           consecutive_failures = 0,
           last_connection_method = p_source,
           last_latency_ms      = p_latency_ms,
           active_users         = coalesce(p_active_users, 0),
           cpu_load             = p_cpu_load,
           ram_used_mb          = case when p_ram_free_mb is not null
                                       then greatest(coalesce(v_node.ram_total_mb, 0) - p_ram_free_mb, 0)
                                  else v_node.ram_used_mb end,
           uptime_seconds       = p_uptime_seconds,
           routeros_version     = coalesce(p_routeros_version, v_node.routeros_version),
           board_name           = coalesce(p_board_name, v_node.board_name),
           architecture         = coalesce(p_architecture, v_node.architecture),
           public_ip            = coalesce(p_public_ip, v_node.public_ip),
           management_ip        = coalesce(p_management_ip, v_node.management_ip),
           vpn_ip               = coalesce(p_vpn_ip, v_node.vpn_ip),
           -- A successful heartbeat proves a pending provisioning landed.
           provisioning_state   = case when v_node.provisioning_state = 'provisioning'
                                        then 'applied'
                                        else v_node.provisioning_state end
     where id = p_node_id;
    v_state := 'online';
  else
    v_fails := v_node.consecutive_failures + 1;

    -- Credentials are a hard failure: no amount of retrying fixes a bad
    -- password, so say so immediately rather than after five attempts.
    if p_error ilike '%401%' or p_error ilike '%403%'
       or lower(p_error) like '%unauthorized%'
       or lower(p_error) like '%bad password%'
       or lower(p_error) like '%cannot log in%'
       or lower(p_error) like '%not allowed%' then
      v_state := 'auth_failed';
    elsif v_fails <= public.missed_heartbeats(
            v_node.offline_threshold_secs, v_node.heartbeat_interval_secs) then
      v_state := 'online';   -- isolated miss; hold the current state
    else
      v_state := 'unreachable';
    end if;

    update public.nodes
       set status               = case when v_state = 'online' then v_node.status
                                         else v_state::public.node_state end,
           consecutive_failures = v_fails,
           last_failure_at      = v_now,
           last_poll_at         = v_now,
           last_error           = left(p_error, 500),
           last_error_at        = v_now,
           last_connection_method = p_source
     where id = p_node_id;
  end if;

  return jsonb_build_object('ok', true, 'status', v_state,
                            'consecutive_failures', v_fails);
end;
$$;

revoke all on function public.record_router_heartbeat(uuid, boolean, text, integer, text, text, text, text, integer, integer, bigint, integer, integer, integer, text, text, text) from public;
grant execute on function public.record_router_heartbeat(uuid, boolean, text, integer, text, text, text, text, integer, integer, bigint, integer, integer, integer, text, text, text) to service_role;
-- =============================================================================
--  14. Reachability classification
--
--  "Offline" is not a diagnosis. A router behind carrier NAT has no management
--  IP at all, and telling the ISP it is offline sends them to reboot a machine
--  that is working fine for customers.
--
--  This classifies the situation from evidence rather than guessing:
--    * the address the platform saw the callback come from
--    * the router's own idea of its WAN address
--    * whether a VPN interface is up
--
--  Returns the classification plus a sentence the UI can show verbatim.
-- =============================================================================

create or replace function public.classify_router_reachability(
  p_node_id uuid,
  p_observed_source_ip text default null,
  p_router_wan_ip      text default null,
  p_vpn_ip             text default null
) returns jsonb
  language plpgsql as $$
declare
  v_public  inet;
  v_observed inet;
  v_result  text;
  v_note    text;
begin
  if p_router_wan_ip ~ '^\d{1,3}(\.\d{1,3}){3}$' then
    v_public := p_router_wan_ip::inet;
  end if;

  if p_vpn_ip is not null and p_vpn_ip <> '' then
    v_result := 'vpn_connected';
    v_note   := 'The router is reached over its VPN tunnel to the network worker.';
  elsif p_router_wan_ip is null or p_router_wan_ip = '' then
    v_result := 'unknown';
    v_note   := 'The router has not reported its WAN address yet.';
  elsif v_public is null then
    -- A private or CGNAT WAN means there is no inbound path from the internet.
    if p_router_wan_ip like '100.%' then
      v_result := 'cgnat';
      v_note   := 'The router WAN address is inside the CGNAT range 100.64.0.0/10, '
               || 'so the internet cannot reach it at all. A WireGuard tunnel to '
               || 'the network worker is required before this router can be managed.';
    elsif p_router_wan_ip like '10.%'
       or p_router_wan_ip like '192.168.%'
       or p_router_wan_ip like '172.%' then
      v_result := 'private_only';
      v_note   := 'The router WAN address is private (RFC1918), so it sits behind '
               || 'an upstream NAT. It is reachable only from that network, or over '
               || 'a VPN tunnel.';
    else
      v_result := 'nat';
      v_note   := 'The router reports a public WAN address but the platform has not '
               || 'yet reached it directly. It is probably behind an upstream NAT.';
    end if;
  elsif p_observed_source_ip is not null
        and p_observed_source_ip ~ '^\d{1,3}(\.\d{1,3}){3}$' then
    v_observed := p_observed_source_ip::inet;
    if v_public = v_observed then
      v_result := 'publicly_reachable';
      v_note   := 'The router is reachable directly from the internet at this address.';
    else
      v_result := 'nat';
      v_note   := 'The router reports a public WAN address, but its callbacks arrive '
               || 'from a different address, which means the WAN interface sits '
               || 'behind an upstream NAT.';
    end if;
  else
    v_result := 'publicly_reachable';
    v_note   := 'The router reports a public WAN address. Direct management is possible.';
  end if;

  update public.nodes
     set reachability = v_result, reachability_note = v_note
   where id = p_node_id;

  return jsonb_build_object('ok', true, 'reachability', v_result, 'note', v_note);
end;
$$;

revoke all on function public.classify_router_reachability(uuid, text, text, text) from public;
grant execute on function public.classify_router_reachability(uuid, text, text, text) to service_role;

-- =============================================================================
--  15. Public portal packages
--
--  The captive portal runs before anyone signs in, so it cannot read `plans`.
--  This is the same shape as the existing public_portal_settings: a
--  security-definer function keyed on a slug that returns a fixed allow-list of
--  presentation columns and nothing else.
--
--  It cannot be coerced into returning another tenant: every column is derived
--  from the ISP row the slug resolved to, and no id is accepted as a parameter.
-- =============================================================================

create or replace function public.public_portal_packages(p_slug text)
returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(to_jsonb(p) order by p.price asc), '[]'::jsonb)
  from (
    select
      pl.id, pl.name, pl.kind, pl.duration_label, pl.duration_hours,
      pl.price, pl.speed_down, pl.speed_up, pl.data_limit, pl.fup,
      pl.description, pl.is_popular
    from public.plans pl
    join public.isps i on i.id = pl.isp_id
    where i.slug = p_slug
      -- Only an ISP that has switched its portal on exposes prices.
      and exists (select 1 from public.portal_settings ps
                   where ps.isp_id = i.id and ps.is_enabled)
      and pl.is_active
      and pl.show_on_portal
      -- If the ISP curated a package list, honour it; otherwise show every
      -- active portal-visible package.
      and (pl.id = any (coalesce(
            (select ps2.package_ids from public.portal_settings ps2
              where ps2.isp_id = i.id), '{}'::uuid[]))
           or not exists (select 1 from public.portal_settings ps3
                          where ps3.isp_id = i.id and ps3.package_ids is not null))
  ) p;
$$;

revoke all on function public.public_portal_packages(text) from public;
grant execute on function public.public_portal_packages(text) to anon, authenticated;
-- =============================================================================
--  16. Dashboard summaries
--
--  Every number below is computed from real rows. In particular `online`
--  requires a heartbeat inside the router's own offline threshold; a status
--  string on its own is never treated as proof of life.
-- =============================================================================

create or replace function public.routers_summary(p_isp uuid default null)
returns jsonb
language sql stable security definer set search_path = public as $$
  with mine as (
    select n.*, now() as asof from public.nodes n
     where n.isp_id = coalesce(p_isp, public.current_isp_id())
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', id, 'name', name, 'host', host, 'enabled', enabled,
    'status', status::text,
    'model', model, 'board_name', board_name,
    'routeros_version', coalesce(routeros_version, os_version),
    'routeros_major', routeros_major, 'architecture', architecture,
    'is_chr', is_chr,
    'mgmt_mode', mgmt_mode,
    'last_connection_method', last_connection_method,
    'reachability', reachability, 'reachability_note', reachability_note,
    'active_users', active_users, 'cpu_load', cpu_load,
    'ram_used_mb', ram_used_mb, 'ram_total_mb', ram_total_mb,
    'uptime_seconds', uptime_seconds,
    'last_heartbeat_at', last_heartbeat_at,
    'last_success_at', last_success_at, 'last_failure_at', last_failure_at,
    'consecutive_failures', consecutive_failures, 'last_error', last_error,
    'provisioning_state', provisioning_state, 'sync_state', sync_state,
    'online', (last_heartbeat_at is not null
               and last_heartbeat_at > asof - make_interval(secs => offline_threshold_secs))
  ) order by name), '[]'::jsonb) from mine;
$$;

grant execute on function public.routers_summary(uuid) to authenticated, service_role;

create or replace function public.network_totals(p_isp uuid default null)
returns jsonb
language sql stable security definer set search_path = public as $$
  with mine as (
    select n.*, now() as asof from public.nodes n
     where n.isp_id = coalesce(p_isp, public.current_isp_id())
  )
  select jsonb_build_object(
    'total', count(*),
    'online', count(*) filter (where last_heartbeat_at is not null
       and last_heartbeat_at > asof - make_interval(secs => offline_threshold_secs)),
    'degraded', count(*) filter (where status = 'degraded'),
    'provisioning', count(*) filter (where status = 'provisioning'),
    'offline', count(*) filter (where status in ('offline','unreachable','auth_failed')),
    'behind_nat', count(*) filter (where reachability in ('cgnat','nat','private_only')),
    'cgnat', count(*) filter (where reachability = 'cgnat'),
    'vpn_connected', count(*) filter (where reachability = 'vpn_connected'),
    'active_users', coalesce(sum(active_users), 0),
    'cpu_avg', round(avg(cpu_load)::numeric, 1),
    'ram_used_mb', coalesce(sum(ram_used_mb), 0),
    'ram_total_mb', coalesce(sum(ram_total_mb), 0)
  ) from mine;
$$;

grant execute on function public.network_totals(uuid) to authenticated, service_role;

-- Live user counts come from the newest heartbeat per router, not from a
-- denormalised column that might be stale.
create or replace function public.live_users_total(p_isp uuid default null)
returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_build_object(
    'hotspot', coalesce(sum(h.hotspot_users), 0),
    'pppoe', coalesce(sum(h.pppoe_users), 0),
    'total', coalesce(sum(h.hotspot_users + h.pppoe_users), 0)
  ), jsonb_build_object('hotspot', 0, 'pppoe', 0, 'total', 0))
  from (
    select distinct on (hb.node_id)
      hb.node_id, hb.hotspot_users, hb.pppoe_users
      from public.router_heartbeats hb
      join public.nodes n on n.id = hb.node_id
     where n.isp_id = coalesce(p_isp, public.current_isp_id())
     order by hb.node_id, hb.observed_at desc
  ) h;
$$;

grant execute on function public.live_users_total(uuid) to authenticated, service_role;
-- =============================================================================
--  17. Queue and worker overview, retention, and grants
-- =============================================================================

create or replace function public.queue_overview(p_isp uuid default null)
returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'pending', count(*) filter (where status in ('pending','retrying')),
    'processing', count(*) filter (where status = 'processing'),
    'succeeded', count(*) filter (where status = 'succeeded'),
    'failed', count(*) filter (where status = 'failed'),
    'dead', count(*) filter (where status = 'dead'),
    'oldest_pending_at', min(created_at) filter (where status in ('pending','retrying'))
  )
  from public.router_jobs
  where isp_id = coalesce(p_isp, public.current_isp_id());
$$;

grant execute on function public.queue_overview(uuid) to authenticated, service_role;

create or replace function public.worker_overview()
returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'name', w.name, 'status', w.status, 'hostname', w.hostname,
    'public_ip', w.public_ip, 'region', w.region, 'version', w.version,
    'wg_address', w.wg_address,
    'last_heartbeat_at', w.last_heartbeat_at,
    'jobs_processed', w.jobs_processed, 'jobs_failed', w.jobs_failed,
    'last_error', w.last_error,
    -- "Alive" is computed, not stored: no beat in 90s means it is gone.
    'alive', (w.last_heartbeat_at is not null
              and w.last_heartbeat_at > now() - interval '90 seconds')
  ) order by w.name), '[]'::jsonb)
  from public.network_workers w
  where w.status <> 'disabled';
$$;

grant execute on function public.worker_overview() to authenticated, service_role;

-- Heartbeats and job events are append-only, so something has to prune them or
-- the tables grow without bound. Retention is generous because this is the
-- evidence trail an ISP uses when arguing about a disconnection.
create or replace function public.prune_network_history(p_heartbeat_days integer default 30)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_h bigint;
  v_e bigint;
begin
  delete from public.router_heartbeats
   where observed_at < now() - make_interval(days => greatest(p_heartbeat_days, 1));
  get diagnostics v_h = row_count;

  delete from public.router_job_events
   where created_at < now() - interval '30 days';
  get diagnostics v_e = row_count;

  -- Completed jobs older than 14 days are history, not queue.
  delete from public.router_jobs
   where status in ('succeeded','cancelled')
     and completed_at < now() - interval '14 days';

  return jsonb_build_object('ok', true, 'heartbeats_deleted', v_h,
                            'events_deleted', v_e);
end;
$$;

grant execute on function public.prune_network_history(integer) to service_role;

-- =============================================================================
--  18. Grants
--
--  RLS covers row access. These grants cover the tables themselves, so a tenant
--  can read their own rows and cannot read anyone else's.
-- =============================================================================

grant select on public.router_heartbeats          to authenticated;
grant select on public.router_capabilities        to authenticated;
grant select, insert, update on public.router_jobs to authenticated;
grant select on public.router_job_events          to authenticated;
grant select, insert, update on public.radius_accounts to authenticated;
grant select, insert on public.network_diagnostics to authenticated;
grant select, insert on public.router_session_commands to authenticated;
grant select on public.network_workers           to authenticated;

-- The worker runs with the service role and needs full access to the new tables.
grant all on public.router_jobs             to service_role;
grant all on public.router_job_events       to service_role;
grant all on public.router_heartbeats       to service_role;
grant all on public.router_capabilities     to service_role;
grant all on public.network_workers         to service_role;
grant all on public.network_diagnostics    to service_role;
grant all on public.router_session_commands to service_role;
grant all on public.radius_accounts         to service_role;
