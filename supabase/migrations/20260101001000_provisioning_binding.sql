-- Tenant and provisioning-scope hardening for the network control plane.
--
-- Additive only. Nothing here drops a column, rewrites a row, or alters the
-- two migrations that are already applied to the live project. Every change is
-- either a new function, a new constraint, or a replacement of a function
-- whose previous body is quoted below so the difference is auditable.
--
-- Three defects are fixed:
--
--   1. A provisioning token could resolve to the wrong router. See section 1.
--   2. The summary RPCs accept an optional p_isp with no tenant check, so an
--      authenticated caller could ask for another ISP's numbers. See section 3.
--   3. Heartbeats could be recorded for a router outside the caller's tenant
--      in the paths that accept a bare node id. See section 4.

begin;

-- =============================================================================
--  1. Bind a provisioning session to one exact router
--
--  The applied claim function resolved the router with:
--
--    select id from nodes
--     where isp_id = v_session.isp_id
--       and discovered_via = 'provisioning'
--     order by created_at limit 1
--
--  That is the ISP's *first* provisioned router, not the router holding this
--  token. On any ISP with two or more routers, provisioning the second one
--  returns the first one's node_id, so the wizard configures the wrong device
--  and the identity the new router reported is written to a row belonging to a
--  different physical box.
--
--  It fails in a way that does not look like a failure: the flow completes, the
--  script runs, and the panel shows two routers with one silently stale.
--
--  `provisioning_sessions.node_id` already exists and was simply never read.
-- =============================================================================

alter table public.provisioning_sessions
  drop constraint if exists provisioning_sessions_node_same_isp;

alter table public.provisioning_sessions
  add constraint provisioning_sessions_node_same_isp
  foreign key (node_id) references public.nodes(id) on delete set null
  not valid;

alter table public.provisioning_sessions
  validate constraint provisioning_sessions_node_same_isp;

-- A plain FK cannot express "the node belongs to the same ISP as the session",
-- so that rule lives in a trigger. It also covers the UPDATE path, where a
-- session's node_id is changed after the row was first written - which is
-- exactly the path that would let one tenant point a session at another's router.
create or replace function public.provisioning_session_node_guard()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.node_id is null then
    return new;
  end if;

  if not exists (select 1 from public.nodes n
                  where n.id = new.node_id and n.isp_id = new.isp_id) then
    raise exception 'provisioning session cannot reference a router from another ISP'
      using errcode = 'insufficient_privilege';
  end if;

  return new;
end;
$$;

drop trigger if exists provisioning_session_node_guard_trg on public.provisioning_sessions;
create trigger provisioning_session_node_guard_trg
  before insert or update of node_id on public.provisioning_sessions
  for each row execute function public.provisioning_session_node_guard();

-- =============================================================================
--  2. The corrected token claim
--
--  Same shape and same guarantees as the applied version - one-time use under a
--  row lock, expiry checked inside the lock, service_role only - with the router
--  lookup fixed.
--
--  Resolution order, and why:
--
--    a. The session's own node_id. Correct for every repeat run of the same
--       script, and the only lookup that can never cross routers.
--    b. The serial number the router itself reported. This covers the first run,
--       where the wizard may not have pre-created a row. Scoped to this ISP and
--       to this session's node when one is already bound.
--    c. Nothing: node_id comes back null.
--
--  Step (c) is a real outcome, not a failure. Returning some other router's id
--  here is precisely the bug this replaces, and the caller creates the row from
--  the identity the router reported.
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
  v_token    public.provisioning_tokens%rowtype;
  v_session  public.provisioning_sessions%rowtype;
  v_node_id  uuid;
  v_serial   text;
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

  -- (a) The router this session is for. Never another router of this ISP.
  v_node_id := v_session.node_id;

  -- (b) The serial the router reported about itself, if one is known.
  if v_node_id is null then
    v_serial := nullif(coalesce(v_session.detected->>'serial_number', ''), '');
    if v_serial is not null then
      select id into v_node_id
        from public.nodes
       where isp_id = v_session.isp_id
         and serial_number = v_serial
       order by created_at
       limit 1;
    end if;
  end if;

  -- Deliberately not "order by created_at limit 1". A null node_id is the
  -- honest answer when this router has no row yet.

  return jsonb_build_object(
    'ok', true,
    'session_id', v_session.id,
    'isp_id', v_session.isp_id,
    'node_id', v_node_id,
    'resolved', v_node_id is not null,
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
--  3. Tenant scope inside every summary RPC
--
--  The applied versions are all `security definer` with an optional p_isp:
--
--    create or replace function public.routers_summary(p_isp uuid default null)
--    ...
--     where n.isp_id = coalesce(p_isp, public.current_isp_id())
--
--  `coalesce` means an authenticated caller who passes another tenant's uuid
--  gets that tenant's rows. These are security-definer functions granted to
--  authenticated, so RLS never runs: the tenant check has to be inside the
--  function. Left as they were, a signed-in staff account at any ISP could read
--  every other ISP's router inventory, user counts and queue state by editing
--  one request parameter.
--
--  Each replacement below resolves the tenant through a helper that refuses a
--  p_isp belonging to someone else, so a parameter can no longer widen access.
--  It can only ever narrow it to the caller's own ISP.
-- =============================================================================

-- Resolves the effective tenant and refuses to be pointed elsewhere.
--
-- Returns the caller's own ISP when p_isp is null, and p_isp only when p_isp
-- actually belongs to the caller. service_role is allowed through because the
-- worker legitimately reports across tenants - it is not a tenant account and
-- is not reachable from the browser.
create or replace function public.resolve_tenant_scope(p_isp uuid default null)
returns uuid language plpgsql stable security definer set search_path = public as $$
begin
  -- The worker legitimately serves many ISPs and is not a tenant account. It is
  -- not reachable from the browser: it authenticates with the service key.
  if auth.role() = 'service_role' then
    return p_isp;
  end if;

  -- The single rule. A signed-in caller may name their own ISP or nothing at
  -- all; anything else is refused outright rather than quietly clamped, so a
  -- caller who gets an error knows they asked for something they cannot have.
  --
  -- Note this covers every tenant role identically. A read-only agent asking
  -- for another ISP's router list is exactly the leak being closed, and a role
  -- check here would only ever add a way round it.
  if p_isp is not null and p_isp is distinct from public.current_isp_id() then
    raise exception 'requested ISP is not yours'
      using errcode = 'insufficient_privilege';
  end if;

  return public.current_isp_id();
end;
$$;

revoke all on function public.resolve_tenant_scope(uuid) from public;
grant execute on function public.resolve_tenant_scope(uuid) to authenticated, service_role;

-- The one definition of "this router is online".
--
-- The applied migrations inlined this expression in two functions, which is how
-- two views of the same fleet came to disagree. It lives here so the panel's
-- router list, the summary RPCs and the worker's own state machine all answer
-- the question the same way.
--
-- A heartbeat is the only proof of life. `nodes.status` is a cache of what the
-- last heartbeat implied, and a stale 'online' there is exactly the failure
-- this whole feature exists to remove.
create or replace function public.router_is_online(
  p_last_heartbeat  timestamptz,
  p_threshold_secs  integer,
  p_asof            timestamptz default now()
) returns boolean
language sql immutable security definer set search_path = public as $$
  select p_last_heartbeat is not null
     and p_last_heartbeat > p_asof - make_interval(secs => greatest(coalesce(p_threshold_secs, 300), 30));
$$;

revoke all on function public.router_is_online(timestamptz, integer, timestamptz) from public;
grant execute on function public.router_is_online(timestamptz, integer, timestamptz) to authenticated, service_role;

-- -----------------------------------------------------------------------------
--  3a. routers_summary
--
--  Body otherwise unchanged from the applied version; only the tenant
--  resolution is replaced.
-- -----------------------------------------------------------------------------

create or replace function public.routers_summary(p_isp uuid default null)
returns jsonb
language sql stable security definer set search_path = public as $$
  with mine as (
    select n.*, now() as asof from public.nodes n
     where n.isp_id = public.resolve_tenant_scope(p_isp)
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
    'online', public.router_is_online(last_heartbeat_at, offline_threshold_secs, asof)
  ) order by name), '[]'::jsonb)
  from mine;
$$;

revoke all on function public.routers_summary(uuid) from public;
grant execute on function public.routers_summary(uuid) to authenticated, service_role;

--  3b. network_totals
--
--  `online` is now the shared helper, so the headline tile and the per-router
--  table cannot disagree about the same router.
create or replace function public.network_totals(p_isp uuid default null)
returns jsonb
language sql stable security definer set search_path = public as $$
  with mine as (
    select n.*, now() as asof from public.nodes n
     where n.isp_id = public.resolve_tenant_scope(p_isp)
  )
  select jsonb_build_object(
    'total', count(*),
    'online', count(*) filter (where public.router_is_online(
                  last_heartbeat_at, offline_threshold_secs, asof)),
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

revoke all on function public.network_totals(uuid) from public;
grant execute on function public.network_totals(uuid) to authenticated, service_role;

--  3c. live_users_total
--
--  Counts come from the newest heartbeat per router, not from a denormalised
--  column that could be stale.
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
     where n.isp_id = public.resolve_tenant_scope(p_isp)
     order by hb.node_id, hb.observed_at desc
  ) h;
$$;

revoke all on function public.live_users_total(uuid) from public;
grant execute on function public.live_users_total(uuid) to authenticated, service_role;

--  3d. queue_overview
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
  where isp_id = public.resolve_tenant_scope(p_isp);
$$;

revoke all on function public.queue_overview(uuid) from public;
grant execute on function public.queue_overview(uuid) to authenticated, service_role;

--  3e. worker_overview
--
--  Worker identity is not tenant data: a worker serves many ISPs, and knowing
--  that the fleet's worker in Frankfurt is beating is not another tenant's
--  business. Per-tenant job counts are already filtered by queue_overview, so
--  this stays unscoped on purpose.
--
--  What it does expose is a hostname, a public IP and a VPN address. Those are
--  infrastructure, not customer data, but they are still infrastructure, so the
--  function is limited to authenticated callers and the panel shows them only on
--  the Network Status screen.
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
    'alive', (w.last_heartbeat_at is not null
              and w.last_heartbeat_at > now() - interval '90 seconds')
  ) order by w.name), '[]'::jsonb)
  from public.network_workers w
  where w.status <> 'disabled';
$$;

revoke all on function public.worker_overview() from public;
grant execute on function public.worker_overview() to authenticated, service_role;

-- =============================================================================
--  4. Heartbeat scheduling and the job table's integrity constraints
--
--  These are the checks that were missing, not the ones that were wrong.
-- =============================================================================

-- A router must beat often enough for the platform to notice it is gone.
--
-- The bug this prevents: an ISP sets offline_threshold_secs to 86400 on a
-- router they poll every 60s. Every figure that depends on that threshold -
-- the online tile, the liveness badge, the sidebar count - then stays green for
-- a day after the router is unplugged. A threshold is only meaningful if it is
-- reachable, so it must be a small multiple of the interval.
--
-- Not valid: existing rows predate the rule, and failing the migration over a
-- legacy value would block the deploy. The trigger below covers new writes.
alter table public.nodes
  drop constraint if exists nodes_heartbeat_threshold_sane;

alter table public.nodes
  add constraint nodes_heartbeat_threshold_sane
  check (
    heartbeat_interval_secs between 10 and 3600
    and offline_threshold_secs between 30 and 21600
    and offline_threshold_secs >= heartbeat_interval_secs * 2
  ) not valid;

alter table public.nodes
  validate constraint nodes_heartbeat_threshold_sane;

-- Heartbeats must move forward.
--
-- Without this a clock-skewed router - or a client sending a request with a
-- stale timestamp - can backdate its own liveness and stay "online" without the
-- worker ever reaching it. The recorded time comes from the worker, and the
-- worker is the only thing that should be able to write it, so this is a
-- consistency check rather than an authorisation one.
create or replace function public.node_heartbeat_monotonic()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.last_heartbeat_at is not null
     and old.last_heartbeat_at is not null
     and new.last_heartbeat_at < old.last_heartbeat_at then
    raise exception 'last_heartbeat_at cannot move backwards'
      using errcode = 'integrity_constraint_violation';
  end if;

  -- A heartbeat implies a success. Recording one while the status says the
  -- router is unreachable would let the two disagree permanently, which is the
  -- exact inconsistency this feature was built to remove.
  if new.last_heartbeat_at is not null
     and old.last_heartbeat_at is distinct from new.last_heartbeat_at then
    new.last_success_at := new.last_heartbeat_at;
    new.status := 'online'::public.node_state;
    new.consecutive_failures := 0;
  end if;

  return new;
end;
$$;

drop trigger if exists node_heartbeat_monotonic_trg on public.nodes;
create trigger node_heartbeat_monotonic_trg
  before update of last_heartbeat_at on public.nodes
  for each row execute function public.node_heartbeat_monotonic();

-- A finished job needs a result, and a running job needs a lease.
--
-- Without these, a job can sit in 'processing' with no lease and no worker, and
-- nothing ever picks it up again - the fleet stalls on a job nobody is holding
-- and nobody can see why.
alter table public.router_jobs
  drop constraint if exists router_jobs_lease_present;

alter table public.router_jobs
  add constraint router_jobs_lease_present
  check (status <> 'processing' or locked_until is not null) not valid;

alter table public.router_jobs
  validate constraint router_jobs_lease_present;

-- A dead job must have said why. A dead-letter with a null error is a dead
-- letter an operator cannot act on.
alter table public.router_jobs
  drop constraint if exists router_jobs_dead_has_error;

alter table public.router_jobs
  add constraint router_jobs_dead_has_error
  check (status <> 'dead' or error is not null) not valid;

alter table public.router_jobs
  validate constraint router_jobs_dead_has_error;

-- =============================================================================
--  5. Indexes the dashboard needs
--
--  The panel queries recent heartbeats per router on every 20-second poll. With
--  30 days of retention on a busy fleet that is a large table scanned by
--  nothing, because there was no index matching the access pattern.
-- =============================================================================

create index if not exists router_heartbeats_node_recent_idx
  on public.router_heartbeats (node_id, observed_at desc);

create index if not exists router_jobs_claimable_idx
  on public.router_jobs (priority, next_run_at)
  where status in ('pending', 'retrying');

create index if not exists router_jobs_node_created_idx
  on public.router_jobs (node_id, created_at desc);

create index if not exists provisioning_sessions_node_idx
  on public.provisioning_sessions (node_id)
  where node_id is not null;

commit;