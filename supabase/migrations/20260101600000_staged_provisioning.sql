-- =============================================================================
--  Staged provisioning, safety backups, and the gate on ONLINE.
--
--  A session used to have ONE state column that could say "configuring" or
--  "failed" and nothing else. That cannot answer the two questions an ISP asks
--  after something breaks - which step failed, and what do I press next - and
--  it cannot resume, because there is nothing to resume FROM.
--
--  Two tables and four functions:
--    * provisioning_stages - one row per stage per session, with its own
--      status, timing, error and diagnostic. The session state becomes a
--      summary of the list rather than the source of truth.
--    * router_backups      - what was written, on which router, under which
--      RouterOS version, and whether it succeeded. Metadata only: the file
--      itself stays on the router and is never uploaded.
--
--  The ONLINE gate lives here rather than in application code, because the
--  rule is a rule about the state of the world and it must hold no matter
--  which caller asks.
-- =============================================================================

begin;

-- ── 1. Per-stage status ───────────────────────────────────────────────────
create table if not exists public.provisioning_stages (
  session_id    uuid not null references public.provisioning_sessions(id) on delete cascade,
  isp_id        uuid not null references public.isps(id) on delete cascade,
  stage         text not null,
  status        text not null default 'pending'
                  check (status in ('pending','running','success','failed',
                                    'skipped','unsupported')),
  -- Why it is not running. Distinct from `error`: "already correct" and "this
  -- firmware cannot do it" are not failures and must never read as one.
  skipped_reason text,
  error         text,
  -- Free-form, safe-to-show diagnostic. Never secrets.
  detail        jsonb not null default '{}'::jsonb,
  attempt_count integer not null default 0,
  started_at    timestamptz,
  completed_at  timestamptz,
  duration_ms   integer,
  updated_at    timestamptz not null default now(),
  primary key (session_id, stage)
);

create index if not exists provisioning_stages_session_idx
  on public.provisioning_stages (session_id);

comment on table public.provisioning_stages is
  'Per-stage provisioning status. A stage runs only once every earlier stage has '
  'settled, which is what makes a run ordered and resumable.';

alter table public.provisioning_stages enable row level security;
alter table public.provisioning_stages force row level security;

drop policy if exists provisioning_stages_read on public.provisioning_stages;
create policy provisioning_stages_read on public.provisioning_stages for select
  using (public.is_super_admin() or isp_id = public.current_isp_id());

-- No write policy: stages are advanced by advance_provisioning_stage(), which
-- enforces the ordering rules. A browser must not be able to mark a stage
-- success and thereby unblock the router to ONLINE.

-- ── 2. Safety backups ─────────────────────────────────────────────────────
create table if not exists public.router_backups (
  id            uuid primary key default gen_random_uuid(),
  isp_id        uuid not null references public.isps(id) on delete cascade,
  node_id       uuid references public.nodes(id) on delete cascade,
  session_id    uuid references public.provisioning_sessions(id) on delete set null,
  filename      text not null,
  kind          text not null check (kind in ('binary','export')),
  routeros_version text,
  board_name    text,
  status        text not null default 'succeeded'
                  check (status in ('succeeded','failed')),
  error         text,
  -- Size in bytes, when the router reported it. Metadata only.
  size_bytes    bigint,
  created_at    timestamptz not null default now()
);

create index if not exists router_backups_node_idx
  on public.router_backups (node_id, created_at desc);
create index if not exists router_backups_session_idx
  on public.router_backups (session_id);

comment on table public.router_backups is
  'Metadata for backups written to the router filesystem. The file itself is '
  'never uploaded: it contains PPPoE and RADIUS secrets. This table records '
  'what exists, where, and whether it succeeded.';

alter table public.router_backups enable row level security;
alter table public.router_backups force row level security;

drop policy if exists router_backups_read on public.router_backups;
create policy router_backups_read on public.router_backups for select
  using (public.is_super_admin() or isp_id = public.current_isp_id());

-- The stage catalogue must exist before anything reads it, so it lives FIRST.
--
-- ── 2c. Ports, chosen from discovery, and the lockout decision ──────────
--
-- The session already stores wan/hotspot/pppoe interfaces, but NOT the port the
-- operator keeps for management. That omission is the whole reason lockout is
-- possible: the platform reassigned the LAN bridge to HotSpot and had nowhere
-- recorded that this would leave nobody able to reach the router.
--
-- Additive columns only. Nothing existing is renamed, dropped or retyped, so
-- sessions created before this migration keep working.
alter table public.provisioning_sessions
  add column if not exists management_interfaces text[] not null default '{}',
  add column if not exists management_lockout_accepted boolean not null default false,
  add column if not exists management_replacement_path text,
  add column if not exists management_replacement_verified boolean not null default false,
  add column if not exists management_assessed_at timestamptz;

comment on column public.provisioning_sessions.management_interfaces is
  'Ports the operator nominated for management, chosen from the interfaces '
  'discovery actually found. At least one is required for the run to be safe.';

comment on column public.provisioning_sessions.management_lockout_accepted is
  'Set only alongside a VERIFIED out-of-band replacement path. A bare acceptance '
  'flag is not permission to lock an operator out of a remote router.';

-- ── 3. The stage catalogue ────────────────────────────────────────────────
--
-- Which stages exist, in what order, and whether each one is required.
--
-- This table is the DATABASE's copy of the same list that `_shared/stages.ts`
-- holds for the edge function. It is duplicated deliberately rather than
-- imported: the ONLINE gate has to keep working even if the edge function is
-- down, updated or replaced, and a gate whose definition lives in application
-- code is a gate that can be bypassed by whichever caller happens to be
-- loosest. The test suite asserts the two lists agree.
create table if not exists public.provisioning_stage_specs (
  stage     text primary key,
  position  integer not null unique,
  label     text not null,
  required  boolean not null,
  -- Why it is required, kept so the panel can explain a block in plain words.
  rationale text
);

insert into public.provisioning_stage_specs (stage, position, label, required, rationale) values
  ('discovery',     1,  'Discover router',           true,  'Ports and firmware must be known before anything is changed.'),
  ('backup',        2,  'Back up configuration',     true,  'A production router is changed with a way back.'),
  ('connectivity',  3,  'Verify management path',    true,  'If the platform loses the router mid-run, work stops here.'),
  ('secure_tunnel', 4,  'Secure tunnel (WireGuard)', false, 'Optional, but required once the ISP selects WireGuard.'),
  ('radius',        5,  'RADIUS servers',            true,  'Authentication cannot work without it.'),
  ('hotspot',       6,  'HotSpot',                   false, 'Optional, but required once the ISP selects HotSpot.'),
  ('pppoe',         7,  'PPPoE',                     false, 'Optional, but required once the ISP selects PPPoE.'),
  ('firewall_nat',  8,  'Firewall and NAT',          true,  'Without NAT no subscriber has working internet.'),
  ('sync_scripts',  9,  'Sync scripts',              true,  'The account sync the billing system depends on must exist.'),
  ('heartbeat',    10,  'Heartbeat',                 true,  'The panel must be able to see the router.'),
  ('package_sync', 11,  'Package profiles',          true,  'Subscribers need the package they paid for to exist.'),
  ('customer_sync',12,  'Customer accounts',         false, 'Optional for an empty router; required to bill subscribers.'),
  ('verification', 13,  'Verify router',             true,  'Success is claimed from evidence, not from progress.')
on conflict (stage) do update
   set position  = excluded.position,
       label     = excluded.label,
       required  = excluded.required,
       rationale = excluded.rationale;

comment on table public.provisioning_stage_specs is
  'The ordered stage catalogue, mirrored from _shared/stages.ts. The ONLINE gate '
  'reads required-ness from here so the rule holds even if the edge function is down.';

-- ── 4. Seed the stage list for a session ─────────────────────────────────
--
-- Idempotent: re-seeding fills in any stage added since the session started
-- without disturbing one already running or finished. That is what lets a
-- session created by an older release pick up the new stage list.
create or replace function public.seed_provisioning_stages(p_session_id uuid)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_isp uuid;
begin
  select s.isp_id into v_isp from public.provisioning_sessions s where s.id = p_session_id;
  if v_isp is null then raise exception 'Provisioning session not found'; end if;

  -- Seeded from the catalogue, not a list written out here: a stage added to
  -- provisioning_stage_specs is picked up automatically instead of needing this
  -- function edited too.
  insert into public.provisioning_stages (session_id, isp_id, stage)
  select p_session_id, v_isp, spec.stage
    from public.provisioning_stage_specs spec
  on conflict (session_id, stage) do nothing;

  return jsonb_build_object('ok', true,
    'stages', (select count(*) from public.provisioning_stages
                where session_id = p_session_id));
end;
$$;

comment on function public.seed_provisioning_stages(uuid) is
  'Creates any missing stage rows for a session. Idempotent, so a session can be '
  're-seeded as the stage list grows without disturbing work already done.';

revoke all on function public.seed_provisioning_stages(uuid) from public, anon;
grant execute on function public.seed_provisioning_stages(uuid) to authenticated, service_role;

-- The one ordered list of stages, shared by every function below so they cannot
-- disagree about what "before" means. It reads from the catalogue, so adding a
-- stage is one INSERT and not four edits across the file.
create or replace function public.provisioning_stage_order()
returns text[] language sql stable security definer set search_path = public as $$
  select coalesce(array_agg(stage order by position), '{}')
    from public.provisioning_stage_specs;
$$;

revoke all on function public.provisioning_stage_order() from public, anon;
grant execute on function public.provisioning_stage_order() to authenticated, service_role;

-- ── 4. Advance one stage, enforcing the ordering rules ───────────────────
--
-- The ordering is enforced HERE, in the database, not in application code.
-- A stage may only move to 'running' when every earlier stage has settled
-- (success, skipped or unsupported). That single rule is what makes a run
-- ordered, and what stops a caller from marking verification complete while
-- RADIUS is still broken.
--
-- 'unsupported' is a terminal, NON-failing outcome. A RouterOS 6 box has no
-- WireGuard; recording that as a failure would report every cheap access point
-- as broken.
create or replace function public.advance_provisioning_stage(
  p_session_id  uuid,
  p_stage       text,
  p_status      text,
  p_error       text default null,
  p_detail      jsonb default '{}'::jsonb,
  p_skip_reason text default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_isp     uuid := public.current_isp_id();
  v_session public.provisioning_sessions%rowtype;
  v_all     text[] := public.provisioning_stage_order();
  v_idx     integer;
  v_blocker text;
begin
  select * into v_session from public.provisioning_sessions s where s.id = p_session_id;
  if v_session.id is null then raise exception 'Provisioning session not found'; end if;
  if not (public.is_super_admin() or (v_session.isp_id = v_isp and public.can_manage_isp())) then
    raise exception 'Insufficient permissions';
  end if;

  v_idx := array_position(v_all, p_stage);
  if v_idx is null then raise exception 'Unknown stage: %', p_stage; end if;

  if p_status not in ('pending','running','success','failed','skipped','unsupported') then
    raise exception 'Invalid stage status: %', p_status;
  end if;

  -- The ordering gate. Only 'running' needs it: recording a terminal outcome
  -- must always be allowed, so a failed stage can be retried and a mistake
  -- corrected.
  if p_status = 'running' then
    select st.stage into v_blocker
      from unnest(v_all[1:v_idx - 1]) as earlier(stage)
      left join public.provisioning_stages ps
        on ps.session_id = p_session_id and ps.stage = earlier.stage
     where ps.status is null or ps.status not in ('success','skipped','unsupported')
     limit 1;
    if v_blocker is not null then
      raise exception 'Stage % cannot start: % has not completed.', p_stage, v_blocker;
    end if;
  end if;

  insert into public.provisioning_stages (session_id, isp_id, stage)
  values (p_session_id, v_session.isp_id, p_stage)
  on conflict (session_id, stage) do nothing;

  update public.provisioning_stages
     set status         = p_status,
         error          = nullif(left(coalesce(p_error, error), 500), ''),
         detail         = coalesce(p_detail, detail),
         skipped_reason = coalesce(p_skip_reason, skipped_reason),
         attempt_count  = attempt_count
                           + case when p_status = 'running' then 1 else 0 end,
         started_at     = case when p_status = 'running' and started_at is null
                               then now() else started_at end,
         completed_at   = case when p_status in ('success','failed','skipped','unsupported')
                               then now() else null end,
         duration_ms    = case
                            when p_status in ('success','failed','skipped','unsupported')
                              and started_at is not null
                            then (extract(epoch from (now() - started_at)) * 1000)::int
                            else duration_ms end,
         updated_at     = now()
   where session_id = p_session_id and stage = p_stage;

  insert into public.provisioning_events (session_id, isp_id, event, detail)
  values (p_session_id, v_session.isp_id, 'stage_' || p_status,
          jsonb_build_object('stage', p_stage, 'error', p_error));

  return jsonb_build_object('ok', true, 'stage', p_stage, 'status', p_status);
end;
$$;

comment on function public.advance_provisioning_stage(uuid, text, text, text, jsonb, text) is
  'Records a stage transition. A stage may only START once every earlier stage '
  'has settled, which is what makes provisioning ordered and resumable.';

revoke all on function public.advance_provisioning_stage(uuid, text, text, text, jsonb, text)
  from public, anon;
grant execute on function public.advance_provisioning_stage(uuid, text, text, text, jsonb, text)
  to authenticated, service_role;

-- ── 5. The ONLINE gate ───────────────────────────────────────────────────
--
-- The rule lives here, not in the application, because it is a claim about the
-- state of the world and it must hold no matter which caller asks. Any path
-- that flips a router to ONLINE goes through this function, so a new caller
-- cannot invent a laxer version of the rule by accident.
--
-- What counts as evidence:
--   * every required stage reached success, skipped or unsupported
--   * verification specifically SUCCEEDED, not merely settled. A verification
--     marked unsupported, or skipped because someone was impatient, must not
--     read as a passing check.
--   * a successful backup exists for this session
--
-- Every one of those has to be true. A router with a failed RADIUS stage, a
-- HotSpot stage the ISP explicitly selected, and a backup never taken stays
-- offline, and the function says which of those is the reason.
create or replace function public.router_online_blocker(p_session_id uuid)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_session public.provisioning_sessions%rowtype;
  v_selected text[] := '{}';
  v_bad       text;
  v_pending   text;
  v_verify    text;
  v_backup    boolean;
  v_all       text[] := public.provisioning_stage_order();
  -- Stages that must be settled for THIS router: the always-required ones plus
  -- whatever the ISP explicitly selected at the wizard.
  v_needed     text[];
begin
  select * into v_session from public.provisioning_sessions s where s.id = p_session_id;
  if v_session.id is null then raise exception 'Provisioning session not found'; end if;

  -- Optional-by-default stages become required when the ISP selected them.
  -- Read from the session's REAL columns: `role` is a column, the tunnel choice
  -- lives in wizard_answers. There is no `config` jsonb on this table.
  if v_session.role in ('hotspot','both') then
    v_selected := array_append(v_selected, 'hotspot');
  end if;
  if v_session.role in ('pppoe','both') then
    v_selected := array_append(v_selected, 'pppoe');
  end if;
  if coalesce(v_session.wizard_answers->>'tunnel','') = 'wireguard' then
    v_selected := array_append(v_selected, 'secure_tunnel');
  end if;

  select array_agg(spec.stage order by spec.position) into v_needed
    from public.provisioning_stage_specs spec
   where spec.required or spec.stage = any(v_selected);

  -- A stage that FAILED is reported ahead of one that simply has not run yet:
  -- "RADIUS failed" tells the operator something to go and fix.
  select ps.stage into v_bad
    from unnest(coalesce(v_needed, '{}')) as n(stage)
    join public.provisioning_stages ps
      on ps.session_id = p_session_id and ps.stage = n.stage
   where ps.status = 'failed'
   order by array_position(v_all, ps.stage)
   limit 1;

  select n.stage into v_pending
    from unnest(coalesce(v_needed, '{}')) as n(stage)
    left join public.provisioning_stages ps
      on ps.session_id = p_session_id and ps.stage = n.stage
   where ps.status is null
      or ps.status not in ('success','skipped','unsupported')
   order by array_position(v_all, n.stage)
   limit 1;

  select status into v_verify from public.provisioning_stages
   where session_id = p_session_id and stage = 'verification';

  select exists (
    select 1 from public.router_backups b
     where b.session_id = p_session_id
       and b.status = 'succeeded'
       and b.kind = 'binary'
  ) into v_backup;

  -- Assembled in priority order so the panel shows the most useful reason.
  if v_bad is not null then
    return jsonb_build_object('blocked', true, 'stage', v_bad,
      'reason', 'A required provisioning stage failed.');
  end if;
  if v_verify is distinct from 'success' then
    return jsonb_build_object('blocked', true, 'stage', 'verification',
      'reason', case when v_verify is null
        then 'Verification has not run.'
        else 'Verification did not succeed (' || v_verify || ').' end);
  end if;
  if not v_backup then
    return jsonb_build_object('blocked', true, 'stage', 'backup',
      'reason', 'No successful configuration backup was taken for this session.');
  end if;
  if v_pending is not null then
    return jsonb_build_object('blocked', true, 'stage', v_pending,
      'reason', 'A required provisioning stage has not completed.');
  end if;

  return jsonb_build_object('blocked', false);
end;
$$;

comment on function public.router_online_blocker(uuid) is
  'Returns the reason a router may not be marked ONLINE, or blocked=false. Any '
  'caller that changes a router''s status must consult this first.';

revoke all on function public.router_online_blocker(uuid) from public, anon;
grant execute on function public.router_online_blocker(uuid) to authenticated, service_role;

-- ── 6. Record a backup that was written to the router ────────────────────
--
-- Called after the router reports the file exists. Records metadata only - the
-- bytes stay on the device, because a backup file contains every PPPoE and
-- RADIUS secret on the router and this platform has no business storing those
-- in a database it replicates and backs up itself.
--
-- Returns the row so the worker can include the id in the stage diagnostic.
create or replace function public.record_router_backup(
  p_session_id uuid,
  p_node_id    uuid,
  p_filename   text,
  p_kind       text,
  p_routeros_version text default null,
  p_board_name text default null,
  p_size_bytes bigint default null,
  p_status     text default 'succeeded',
  p_error      text default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_session public.provisioning_sessions%rowtype;
  v_id uuid;
begin
  select * into v_session from public.provisioning_sessions s where s.id = p_session_id;
  if v_session.id is null then raise exception 'Provisioning session not found'; end if;
  if not (public.is_super_admin() or v_session.isp_id = public.current_isp_id()) then
    raise exception 'Insufficient permissions';
  end if;
  if p_kind not in ('binary','export') then
    raise exception 'Backup kind must be binary or export, not %', p_kind;
  end if;

  insert into public.router_backups
    (isp_id, node_id, session_id, filename, kind, routeros_version,
     board_name, status, error, size_bytes)
  values
    (v_session.isp_id, p_node_id, p_session_id, p_filename, p_kind,
     p_routeros_version, p_board_name, p_status, p_error, p_size_bytes)
  returning id into v_id;

  return jsonb_build_object('ok', true, 'id', v_id, 'filename', p_filename);
end;
$$;

comment on function public.record_router_backup(uuid, uuid, text, text, text, text, bigint, text, text) is
  'Records metadata for a backup written to the router filesystem. The file is '
  'never uploaded: it contains every secret on the device.';

revoke all on function public.record_router_backup(uuid, uuid, text, text, text, text, bigint, text, text)
  from public, anon;
grant execute on function public.record_router_backup(uuid, uuid, text, text, text, text, bigint, text, text)
  to authenticated, service_role;

commit;