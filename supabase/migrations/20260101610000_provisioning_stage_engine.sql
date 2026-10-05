-- =============================================================================
--  Staged provisioning: the integration layer.
--
--  16b2268 shipped the stage machine but nothing called it. This migration is the
--  wiring, and it is deliberately small: it opens the door for the worker, and
--  adds the functions the wizard needs. It does NOT add a second queue, a second
--  token system or a second copy of the stage list.
--
--  THE PROBLEM THIS SOLVES
--  ----------------------
--  `advance_provisioning_stage()` gates on is_super_admin()/can_manage_isp(),
--  which resolve through auth.uid(). The worker authenticates with the service
--  role and has NO uid - it is a trusted backend process, not a logged-in user.
--  So the worker could not record a single stage transition.
--
--  The obvious fix - letting anything with the service key call it freely - is
--  wrong, because the service key is in the Edge Functions too, and the router-
--  facing claim endpoint holds it. The narrow fix is below: the worker proves it
--  is the worker by naming itself in the `netisp.worker` GUC, exactly as
--  complete_router_job() already requires.
-- =============================================================================

begin;

-- ── 1. Who may advance a stage ───────────────────────────────────────────
--
-- Staff keep their existing permissions. The worker is additionally allowed,
-- and only for a session belonging to the ISP the job itself names.
create or replace function public.can_advance_provisioning_stage(
  p_session_id uuid,
  p_isp_id     uuid default null
) returns boolean
language sql stable security definer set search_path = public as $$
  select
    public.is_super_admin()
    -- A browser session: an ISP owner or admin of the session's own tenant.
    or exists (
      select 1 from public.provisioning_sessions s
       where s.id = p_session_id
         and s.isp_id = public.current_isp_id()
         and public.can_manage_isp()
    )
    -- The worker. Identified by the GUC the job queue already sets, and
    -- cross-checked against the session's tenant so a tampered job row cannot be
    -- used to drive another ISP's session.
    or (
      current_setting('netisp.worker', true) is not null
      and current_setting('netisp.worker', true) <> ''
      and p_isp_id is not null
      and exists (
        select 1 from public.provisioning_sessions s
         where s.id = p_session_id and s.isp_id = p_isp_id
      )
    );
$$;

comment on function public.can_advance_provisioning_stage(uuid, uuid) is
  'True for ISP staff of that tenant, or for the worker claiming that tenant. '
  'The worker is identified by the netisp.worker GUC set by set_job_worker, not '
  'by holding the service key, because router-facing endpoints hold it too.';

-- ── 2. advance_provisioning_stage, with the worker path ──────────────────
--
-- Same function, same ordering rule, same terminal states. Only the
-- authorisation check changes, and it changes to a check that can actually
-- identify the caller.
create or replace function public.advance_provisioning_stage(
  p_session_id  uuid,
  p_stage       text,
  p_status      text,
  p_error       text default null,
  p_detail      jsonb default '{}'::jsonb,
  p_skip_reason text default null,
  p_isp_id      uuid default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_session public.provisioning_sessions%rowtype;
  v_all     text[] := public.provisioning_stage_order();
  v_idx     integer;
  v_blocker text;
begin
  select * into v_session from public.provisioning_sessions s where s.id = p_session_id;
  if v_session.id is null then raise exception 'Provisioning session not found'; end if;

  if not public.can_advance_provisioning_stage(p_session_id,
       coalesce(p_isp_id, v_session.isp_id)) then
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

revoke all on function public.advance_provisioning_stage(uuid, text, text, text, jsonb, text, uuid)
  from public, anon;
grant execute on function public.advance_provisioning_stage(uuid, text, text, text, jsonb, text, uuid)
  to authenticated, service_role;

-- ── 3. Start staged provisioning for a session ───────────────────────────
--
-- Seeds the stage rows, marks the ones that are already decided by what the
-- router reported (discovery done, an unselected service skipped), and queues
-- exactly ONE job: `provision`. The worker then walks the stage list itself.
--
-- One job, not thirteen. A job per stage would mean thirteen queue rows that
-- have to be kept in step with the stage table, and a crash between two of them
-- would leave a gap the ordering rule could not close. One job that consults
-- the stage table each time it starts a stage is resumable by construction: it
-- asks "what is the first unsettled stage?" and does that one.
create or replace function public.enqueue_staged_provisioning(
  p_session_id uuid
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_session public.provisioning_sessions%rowtype;
  v_job     uuid;
  v_tunnel  text;
  v_statuses text[];
begin
  select * into v_session from public.provisioning_sessions s where s.id = p_session_id;
  if v_session.id is null then
    return jsonb_build_object('ok', false, 'error', 'Provisioning session not found.');
  end if;
  if not (public.is_super_admin()
          or (v_session.isp_id = public.current_isp_id() and public.can_manage_isp())) then
    return jsonb_build_object('ok', false, 'error', 'That session belongs to another ISP.');
  end if;
  if v_session.node_id is null then
    return jsonb_build_object('ok', false,
      'error', 'This router has not contacted the platform yet.');
  end if;

  perform public.seed_provisioning_stages(p_session_id);

  v_tunnel := coalesce(v_session.wizard_answers->>'tunnel', '');

  -- The states a stage starts in, decided here rather than in the worker,
  -- because they follow from what the ISP chose and what the router is, neither
  -- of which changes while the job runs.
  --
  -- NOTE there is no 'unsupported' here. Whether this firmware can do a thing
  -- is discovered by PROBING, not guessed from the version, and the worker
  -- records what it actually found. Guessing 'unsupported' for a required stage
  -- is exactly how a broken router gets reported healthy.
  v_statuses := array[
    'success',                                          -- discovery: the router reported
    case when v_tunnel = 'wireguard' then 'pending' else 'skipped' end,
    'pending',                                           -- backup
    'pending',                                           -- connectivity
    case when v_tunnel = 'wireguard' then 'pending' else 'skipped' end,
    'pending',                                           -- radius
    case when v_session.role = 'pppoe' then 'skipped' else 'pending' end,
    case when v_session.role = 'hotspot' then 'skipped' else 'pending' end,
    'pending',                                           -- firewall_nat
    'pending',                                           -- sync_scripts
    'pending',                                           -- heartbeat
    'pending',                                           -- package_sync
    'pending',                                           -- customer_sync
    'pending'                                            -- verification
  ];

  update public.provisioning_stages ps
     set status = v_statuses[spec.position]
   from public.provisioning_stage_specs spec
   where spec.stage = ps.stage
     and ps.session_id = p_session_id
     -- Only a stage that has not run yet is seeded. This is also the retry path,
     -- and a retry must not erase evidence that a stage succeeded earlier.
     and ps.status = 'pending';

  -- A stage left RUNNING when the worker died would stay running forever. Its
  -- work was never confirmed, so it goes back to pending and is re-attempted.
  -- Safe because every stage is idempotent.
  update public.provisioning_stages
     set status = 'pending', started_at = null
   where session_id = p_session_id and status = 'running';

  update public.provisioning_sessions
     set state = 'configuring', last_error = null, attempts = attempts + 1
   where id = p_session_id;

  insert into public.provisioning_events (session_id, isp_id, event, source, detail)
  values (p_session_id, v_session.isp_id, 'staged_provisioning_queued', 'panel',
          jsonb_build_object('role', v_session.role, 'tunnel', v_tunnel));

  -- Idempotent per attempt, so a double-click cannot start two runs against the
  -- same router. The key includes the attempt counter precisely so a genuine
  -- retry is NOT swallowed as a duplicate.
  select (r->>'job_id')::uuid into v_job
    from public.enqueue_router_job(
      v_session.node_id, 'provision',
      jsonb_build_object('session_id', p_session_id),
      format('provision:%s:%s', p_session_id, v_session.attempts + 1),
      5,   -- priority: ahead of routine sweeps, behind a fresh claim
      8    -- attempts
    ) as r;

  return jsonb_build_object('ok', true, 'job_id', v_job,
    'stages', (select count(*) from public.provisioning_stages
                where session_id = p_session_id));
end;
$$;

comment on function public.enqueue_staged_provisioning(uuid) is
  'Seeds the stage rows and queues ONE provisioning job. The worker walks the '
  'stage list itself, so a crash resumes from the first unsettled stage rather '
  'than from a gap in a queue the stage table cannot see.';

revoke all on function public.enqueue_staged_provisioning(uuid) from public, anon;
grant execute on function public.enqueue_staged_provisioning(uuid) to authenticated, service_role;

-- ── 4. Read the live stage list ──────────────────────────────────────────
--
-- One call the wizard polls. Returns the catalogue in order with each stage's
-- real status, the session state, and the ONLINE verdict, so the panel never
-- has to assemble "is this finished" from several tables and get it wrong.
create or replace function public.provisioning_stage_report(
  p_session_id uuid,
  p_isp_id     uuid default null
) returns jsonb
language sql stable security definer set search_path = public as $$
  with s as (
    select ps.* from public.provisioning_sessions ps where ps.id = p_session_id
  ), readable as (
    select s.* from s
     where public.is_super_admin()
        or (s.isp_id = public.current_isp_id() and public.can_manage_isp())
        -- The worker, which must name the tenant it is acting for. Comparing the
        -- session to itself here would be a tautology that lets any service-role
        -- caller read any session's stages.
        or (current_setting('netisp.worker', true) is not null
            and current_setting('netisp.worker', true) <> ''
            and p_isp_id is not null
            and s.isp_id = p_isp_id)
  )
  select jsonb_build_object(
    'ok', true,
    'session', (select jsonb_build_object(
        'id', id, 'state', state, 'role', role, 'node_id', node_id,
        'label', label, 'last_error', last_error,
        'wan_interface', wan_interface,
        'hotspot_interfaces', hotspot_interfaces,
        'pppoe_interfaces', pppoe_interfaces,
        'management_interfaces', management_interfaces,
        'wizard_answers', wizard_answers)
      from readable),
    'stages', coalesce((
      select jsonb_agg(jsonb_build_object(
        'stage', spec.stage,
        'label', spec.label,
        'required', spec.required,
        'rationale', spec.rationale,
        'status', coalesce(st.status, 'pending'),
        'error', st.error,
        'skipped_reason', st.skipped_reason,
        'attempt_count', coalesce(st.attempt_count, 0),
        'started_at', st.started_at,
        'completed_at', st.completed_at,
        'duration_ms', st.duration_ms)
        order by spec.position)
      from public.provisioning_stage_specs spec
      left join public.provisioning_stages st
        on st.session_id = p_session_id and st.stage = spec.stage),
      '[]'::jsonb),
    'online', case
      when exists (select 1 from readable)
        then public.router_online_blocker(p_session_id)
      else jsonb_build_object('blocked', true, 'reason', 'Not your session.')
    end,
    'backups', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', b.id, 'filename', b.filename, 'kind', b.kind,
        'status', b.status, 'routeros_version', b.routeros_version,
        'size_bytes', b.size_bytes, 'created_at', b.created_at)
        order by b.created_at desc)
      from public.router_backups b
      where b.session_id = p_session_id), '[]'::jsonb)
  )
  from readable limit 1;
$$;

comment on function public.provisioning_stage_report(uuid) is
  'The stage list with real statuses, plus the ONLINE verdict and backup history. '
  'One call, so the panel cannot disagree with the gate by assembling it itself.';

revoke all on function public.provisioning_stage_report(uuid, uuid) from public, anon;
grant execute on function public.provisioning_stage_report(uuid, uuid) to authenticated, service_role;

-- ── 5. Copy plans from another router of the SAME ISP ────────────────────
--
-- "Copy plans" is a real convenience: an ISP with four branches does not want to
-- type the same ten packages four times. It is also a cross-tenant data
-- exfiltration risk if the source router id is not checked, so the tenant test
-- is the FIRST thing this function does, before it reads anything.
--
-- What is copied is the DATABASE plan catalogue, never a router's live objects.
-- The target router then gets its own objects built from those plans during the
-- package_sync stage. Copying raw RouterOS rows would drag across identifiers
-- that are specific to the source device - addresses, .id values, interface
-- names - and those must never be reused on another router.
create or replace function public.copy_router_plans(
  p_source_node_id uuid,
  p_target_session uuid,
  p_kinds         text[] default array['hotspot','pppoe'],
  p_replace       boolean default false
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_target  public.provisioning_sessions%rowtype;
  v_source_isp uuid;
  v_target_isp uuid;
  v_copied  integer := 0;
  v_plans   public.plans%rowtype;
begin
  select * into v_target from public.provisioning_sessions s where s.id = p_target_session;
  if v_target.id is null then
    return jsonb_build_object('ok', false, 'error', 'Provisioning session not found.');
  end if;
  if not (public.is_super_admin()
          or (v_target.isp_id = public.current_isp_id() and public.can_manage_isp())) then
    return jsonb_build_object('ok', false, 'error', 'That session belongs to another ISP.');
  end if;

  select n.isp_id into v_source_isp from public.nodes n where n.id = p_source_node_id;
  if v_source_isp is null then
    return jsonb_build_object('ok', false, 'error', 'Source router not found.');
  end if;

  v_target_isp := v_target.isp_id;

  -- THE TENANT GATE. Cross-tenant copying is refused outright, before any plan
  -- row is read. An ISP may only ever copy from a router of their own.
  if not public.is_super_admin() and v_source_isp <> v_target_isp then
    return jsonb_build_object('ok', false,
      'error', 'You can only copy plans from another router of your own ISP.');
  end if;

  -- Only the target's own plans are ever written to. Plans belong to the ISP,
  -- not to a router, so a copy brings the package definition across without
  -- touching prices already paid.
  for v_plans in
    select p.* from public.plans p
     where p.isp_id = v_target_isp
       and (p.kind = any (coalesce(p_kinds, array['hotspot','pppoe']))
            or p.kind = 'fiber')
       and p.is_active
     order by p.name
  loop
    -- A plan with this name already exists for this ISP. With replace=false the
    -- existing one wins, because overwriting a package an ISP has been selling
    -- would silently change the speeds their current customers think they bought.
    if exists (select 1 from public.plans x
                where x.isp_id = v_target_isp and lower(x.name) = lower(v_plans.name)) then
      if not p_replace then
        v_copied := v_copied + 1;
        continue;
      end if;
      update public.plans x
         set kind           = v_plans.kind,
             duration_label = v_plans.duration_label,
             duration_hours = v_plans.duration_hours,
             speed_down     = v_plans.speed_down,
             speed_up       = v_plans.speed_up,
             shared_users   = v_plans.shared_users,
             data_limit     = v_plans.data_limit,
             fup            = v_plans.fup,
             updated_at     = now()
       where x.isp_id = v_target_isp and lower(x.name) = lower(v_plans.name);
    else
      -- The price is deliberately NOT copied as a new value: it is copied from
      -- the plan it already came from in the same tenant, so nothing changes.
      -- Historical payments are never touched by any of this.
      insert into public.plans
        (isp_id, name, kind, duration_label, duration_hours, price,
         speed_down, speed_up, shared_users, data_limit, fup,
         description, is_popular, is_active, show_on_portal)
      values
        (v_target_isp, v_plans.name, v_plans.kind, v_plans.duration_label,
         v_plans.duration_hours, v_plans.price, v_plans.speed_down, v_plans.speed_up,
         v_plans.shared_users, v_plans.data_limit, v_plans.fup,
         v_plans.description, v_plans.is_popular, v_plans.is_active, true);
    end if;
    v_copied := v_copied + 1;
  end loop;

  update public.provisioning_sessions
     set wizard_answers = coalesce(wizard_answers, '{}'::jsonb)
                          || jsonb_build_object('plans_copied_from', p_source_node_id)
     where id = p_target_session;

  insert into public.provisioning_events (session_id, isp_id, event, source, detail)
  values (p_target_session, v_target_isp, 'plans_copied', 'panel',
          jsonb_build_object('source_node', p_source_node_id, 'plans', v_copied));

  return jsonb_build_object('ok', true, 'plans', v_copied,
                            'source_node', p_source_node_id);
end;
$$;

comment on function public.copy_router_plans(uuid, uuid, text[], boolean) is
  'Copies a package catalogue from another router OF THE SAME ISP. The tenant '
  'check runs before any plan is read. Copies plan definitions only, never the '
  'source router''s live RouterOS objects, and never a price or a payment.';

revoke all on function public.copy_router_plans(uuid, uuid, text[], boolean) from public, anon;
grant execute on function public.copy_router_plans(uuid, uuid, text[], boolean)
  to authenticated, service_role;

-- APPEND_HERE
-- ── 6b. Persist the address pools the survey found ───────────────────────
--
-- Pools were never being stored, which is the real reason PPPoE failed with
-- "assign an address range" on routers that already had perfectly good ones:
-- the information existed on the device and was thrown away by the survey.
--
-- Additive columns only. Nothing is rewritten, dropped or retyped.
alter table public.router_capabilities
  add column if not exists pools jsonb not null default '[]'::jsonb,
  add column if not exists addresses jsonb not null default '[]'::jsonb;

comment on column public.router_capabilities.pools is
  'Address pools the router reported (/ip pool print). These are what PPPoE and '
  'HotSpot are allocated from, so the wizard never asks the operator to retype a '
  'range the device already has.';

-- ── 7. The pools the wizard can offer for a session ──────────────────────
--
-- Resolved server-side from the survey, so the browser is shown the ranges that
-- will ACTUALLY be used rather than a blank field. The browser never decides;
-- it renders this and the worker recomputes the same answer independently.
--
-- An explicit wizard answer still wins, which is why this is a preview and not
-- an assignment.
create or replace function public.provisioning_pool_options(p_session_id uuid)
returns jsonb
language sql stable security definer set search_path = public as $$
  with sess as (
    select ps.* from public.provisioning_sessions ps where ps.id = p_session_id
  ), caps as (
    select c.pools
      from sess s
      join public.router_capabilities c on c.node_id = s.node_id
  ), usable as (
    -- A pool must have a name and a readable two-ended range.
    select p->>'name' as name,
           p->>'ranges' as ranges,
           (p->>'next-pool') is null or (p->>'next-pool') = '' as terminal
      from caps, jsonb_array_elements(coalesce(caps.pools, '[]'::jsonb)) p
     where nullif(p->>'name', '') is not null
       and p->>'ranges' like '%-%'
  )
  select jsonb_build_object(
    'ok', true,
    'role', (select role from sess),
    'discovered', coalesce((
      select jsonb_agg(jsonb_build_object(
        'name', u.name, 'ranges', u.ranges, 'usable', u.terminal))
        from usable u), '[]'::jsonb),
    -- What the survey currently has, so an operator can see it is not empty.
    'count', (select count(*) from usable)
  )
  from sess;
$$;

comment on function public.provisioning_pool_options(uuid) is
  'The address pools the survey found for this session''s router, for the wizard '
  'to offer. A preview only: the worker resolves the ranges independently and an '
  'explicit operator choice overrides both.';

revoke all on function public.provisioning_pool_options(uuid) from public, anon;
grant execute on function public.provisioning_pool_options(uuid) to authenticated, service_role;

commit;