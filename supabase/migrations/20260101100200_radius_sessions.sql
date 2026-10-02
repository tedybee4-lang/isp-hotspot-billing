-- =============================================================================
--  RADIUS accounting sessions.
--
--  FreeRADIUS needs somewhere to record that a subscriber is online. The
--  existing `sessions` table is Supabase's OAuth session store and is nothing
--  to do with network access; using it for this would mix two unrelated
--  lifecycles on one table and break both.
--
--  This table is the live-session record the panel reads, the RADIUS accounting
--  target, and the evidence trail for a billing dispute ("you were cut off at
--  14:32, here is the Acct-Stop that says so").
--
--  Additive only. Nothing existing is altered.
-- =============================================================================

begin;

create table if not exists public.radius_sessions (
  id                  uuid primary key default gen_random_uuid(),
  isp_id              uuid not null references public.isps(id) on delete cascade,

  -- What FreeRADIUS calls it. The unique index below is what makes a repeated
  -- Acct-Start update one row instead of double-counting a customer's online
  -- time, which is the failure mode that shows up as inflated revenue.
  acct_session_id     text not null,

  username            text not null,
  client_id           uuid references public.clients(id) on delete set null,
  node_id             uuid references public.nodes(id) on delete set null,

  -- hotspot | pppoe | fiber
  service_type        text,
  framed_ip           text,
  called_station_id   text,
  nas_ip_address      text,
  nas_port            integer,

  started_at          timestamptz not null default now(),
  last_update         timestamptz not null default now(),
  ended_at            timestamptz,
  -- Bytes the router reported at Acct-Stop. Null while the session is open.
  input_octets        bigint,
  output_octets       bigint,
  session_time_secs   integer,
  -- Why the session ended: acct-stop | acct-interim | timeout | admin |
  -- expired | superseded | radius-restart.
  -- `admin` is the worker's deliberate disconnect.
  end_reason          text,

  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),

  constraint radius_sessions_service_type_ck
    check (service_type is null or service_type in ('hotspot','pppoe','fiber')),
  constraint radius_sessions_end_reason_ck
    check (end_reason is null or end_reason in
      ('acct-stop','acct-interim','timeout','admin','expired','superseded',
       'radius-restart'))
);

-- One session per acct_session_id. This is the constraint that makes a replayed
-- Acct-Start idempotent rather than duplicating a customer's time.
create unique index if not exists radius_sessions_acct_key
  on public.radius_sessions (acct_session_id);

-- The panel's main query: "who is online for this tenant, right now".
create index if not exists radius_sessions_live_idx
  on public.radius_sessions (isp_id, started_at desc)
  where ended_at is null;

create index if not exists radius_sessions_user_idx
  on public.radius_sessions (isp_id, username, started_at desc);

create index if not exists radius_sessions_client_idx
  on public.radius_sessions (client_id)
  where client_id is not null;

-- ── Disconnect command linkage ───────────────────────────────────────────────
--
-- router_session_commands.session_id has a foreign key to `sessions`, which is
-- Supabase's OAuth session store and has nothing to do with network access. That
-- made it impossible to reference a RADIUS session from a disconnect command,
-- and writing one anyway would have failed the FK.
--
-- A separate nullable column is added rather than repointing the existing FK, so
-- any historical rows keep working and nothing existing is reinterpreted.
alter table public.router_session_commands
  add column if not exists radius_session_id uuid
    references public.radius_sessions(id) on delete cascade;

create index if not exists router_session_commands_radius_idx
  on public.router_session_commands (radius_session_id)
  where radius_session_id is not null;

comment on column public.router_session_commands.session_id is
  'Auth session id (OAuth). Not a network session - see radius_session_id.';
comment on column public.router_session_commands.radius_session_id is
  'RADIUS accounting session this command applies to.';

comment on table public.radius_sessions is
  'Live and historical RADIUS sessions written by FreeRADIUS post-auth and closed by Acct-Stop or the network worker.';

comment on column public.radius_sessions.end_reason is
  'Why the session ended. admin = the worker disconnected it deliberately.';

-- =============================================================================
--  Tenant-safe reads
--
--  FreeRADIUS writes with the service role and does not use these; they exist
--  so the panel reads live sessions through a function that resolves the caller
--  rather than through a table it could read directly.
-- =============================================================================

create or replace function public.live_radius_sessions(p_isp_id uuid default null)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_isp uuid;
begin
  if public.is_super_admin() then
    v_isp := coalesce(p_isp_id, public.current_isp_id());
  else
    v_isp := public.current_isp_id();
    if p_isp_id is not null and p_isp_id is distinct from v_isp then
      raise exception 'requested ISP is not yours'
        using errcode = 'insufficient_privilege';
    end if;
  end if;

  return coalesce(
    (select jsonb_agg(to_jsonb(s) order by s.started_at desc)
       from (
         select s.*, c.account_no, c.full_name
           from public.radius_sessions s
           left join public.clients c on c.id = s.client_id
          where s.isp_id = v_isp
            and s.ended_at is null
          order by s.started_at desc
          limit 500
       ) s),
    '[]'::jsonb);
end;
$$;

revoke all on function public.live_radius_sessions(uuid) from public;
grant execute on function public.live_radius_sessions(uuid) to authenticated, service_role;

-- =============================================================================
--  Deliberate disconnect
--
--  Closes the session AND records the router_session_commands row the worker
--  picks up. One transaction, so a disconnect cannot be visible in the panel
--  without a command queued to actually perform it on the device.
-- =============================================================================

create or replace function public.request_session_disconnect(
  p_acct_session_id text,
  p_reason text default 'admin'
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_isp  uuid := public.current_isp_id();
  v_sess public.radius_sessions;
  v_cmd  uuid;
begin
  if v_isp is null then
    raise exception 'No ISP in scope' using errcode = 'insufficient_privilege';
  end if;
  if not (public.can_manage_isp() or public.is_isp_staff() or public.is_super_admin()) then
    raise exception 'You cannot disconnect users' using errcode = 'insufficient_privilege';
  end if;

  select * into v_sess from public.radius_sessions
   where acct_session_id = p_acct_session_id and isp_id = v_isp
   for update;

  if v_sess.id is null then
    raise exception 'Session not found' using errcode = 'no_data_found';
  end if;

  -- Already closed. Return the existing state rather than queuing a second
  -- command that would disconnect whoever reconnected with the same username.
  if v_sess.ended_at is not null then
    return jsonb_build_object('ok', true, 'already_closed', true,
                              'ended_at', v_sess.ended_at);
  end if;

  -- Close the session now so the panel reflects reality immediately...
  update public.radius_sessions
     set ended_at = now(),
         end_reason = coalesce(p_reason, 'admin'),
         updated_at = now()
   where id = v_sess.id;

  -- ...and queue the command that makes the router agree. A session with no node
  -- cannot be killed on the device, and that is reported honestly rather than
  -- pretending the disconnect reached the router.
  if v_sess.node_id is not null then
    --
    -- `session_id` here is a radius_sessions id, NOT an auth.sessions id. That
    -- column's foreign key points at Supabase's OAuth session store, which is
    -- unrelated to network access; putting a RADIUS session id in it fails the
    -- FK. The command is therefore keyed on the account and the address, which
    -- is what the worker actually uses to find the session on the device.
    --
    -- A dedicated nullable column is the honest fix. Adding it rather than
    -- dropping the FK keeps any historical Daraja-era rows intact.
    insert into public.router_session_commands (
      isp_id, node_id, radius_session_id, command, mac_address, ip_address, status
    ) values (
      v_isp, v_sess.node_id, v_sess.id, 'disconnect',
      v_sess.called_station_id, v_sess.framed_ip, 'pending'
    )
    returning id into v_cmd;

    insert into public.audit_logs(
      actor_id, actor_role, isp_id, action, target_type, target_id, metadata
    ) values (
      auth.uid(),
      case when public.is_super_admin() then 'super_admin'::platform_role
           else 'isp_admin'::platform_role end,
      v_isp, 'session:disconnect-requested', 'radius_session', v_sess.id::text,
      jsonb_build_object('username', v_sess.username,
                         'acct_session_id', v_sess.acct_session_id));

    return jsonb_build_object('ok', true, 'command_id', v_cmd,
                              'router_notified', true);
  end if;

  return jsonb_build_object(
    'ok', true,
    'router_notified', false,
    'detail', 'Closed in ISPFlow, but this session has no router attached, so the '
              || 'device was not told. It will end at the next session timeout or '
              || 'reconnect.');
end;
$$;

revoke all on function public.request_session_disconnect(text, text) from public;
grant execute on function public.request_session_disconnect(text, text) to authenticated;

commit;
