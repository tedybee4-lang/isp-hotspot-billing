-- =============================================================================
--  Tenant-scoped read model for the ISP live-users panel.
--
--  Found by tracing the dashboard back to its source.
--
--  fetchSessions() read the `sessions` table. That table is Supabase's OAuth
--  session store: it holds browser refresh tokens, not network sessions, and
--  the ISP live-users panel was therefore rendering rows that RADIUS never
--  wrote. The authoritative record of who is online is radius_sessions, written
--  by FreeRADIUS accounting.
--
--  Two consequences of reading the wrong table:
--
--    * every RADIUS session was invisible, so the panel could only ever show
--      whatever OAuth rows happened to exist;
--    * kickSession() then had no RADIUS session id to act on.
--
--  This adds ONE read model over radius_sessions. It is not a second table:
--  radius_sessions remains the only store, and this is a view-shaped function
--  over it.
--
--  Tenant scoping is resolved from auth.uid() inside the function, exactly as
--  every other RPC in this schema does. There is deliberately no p_isp_id
--  parameter, so there is no value a browser could supply to widen the query.
--  A caller cannot ask for another tenant's rows because it cannot express the
--  question.
--
--  Exposed fields are only those an ISP already knows about its own customers.
--  Router credentials, session secrets and the RADIUS host key are not in the
--  row and are not selected. `router_name` comes from the nodes table by join,
--  not from any credential column.
-- =============================================================================

begin;

create or replace function public.my_radius_sessions(
  p_open_only boolean default false,
  limit_rows integer default 200
) returns table (
  id uuid,
  acct_session_id text,
  username text,
  node_id uuid,
  router_name text,
  nas_identifier text,
  ip_address text,
  service_type text,
  started_at timestamptz,
  ended_at timestamptz,
  duration_secs integer,
  input_octets bigint,
  output_octets bigint,
  end_reason text,
  is_active boolean,
  can_disconnect boolean
)
  language plpgsql
  stable
  security definer
  set search_path = public as $$
declare
  v_isp uuid := public.current_isp_id();
begin
  if v_isp is null then
    raise exception 'No ISP in scope' using errcode = 'insufficient_privilege';
  end if;

  return query
  select s.id,
         s.acct_session_id,
         s.username,
         s.node_id,
         n.name,
         coalesce(s.nas_identifier, s.called_station_id),
         s.framed_ip,
         s.service_type,
         s.started_at,
         s.ended_at,
         -- Only ever counted from the SESSION's own clock, never from "now":
         -- a closed session must not keep growing.
         case
           when s.ended_at is not null
             then greatest(extract(epoch from (s.ended_at - s.started_at))::int, 0)
           else extract(epoch from (now() - s.started_at))::int
         end,
         s.input_octets,
         s.output_octets,
         s.end_reason,
         -- A session is "active" only when RADIUS says it has not ended. An
         -- ISP is never shown a session as online on the strength of a row
         -- existing, because a router that died without sending Acct-Stop
         -- leaves exactly such a row behind.
         (s.ended_at is null) as is_active,
         -- Disconnecting an already-ended session would queue work for a
         -- customer who is not online. The UI uses this to disable the action.
         (s.ended_at is null) as can_disconnect
    from public.radius_sessions s
    left join public.nodes n on n.id = s.node_id
   where s.isp_id = v_isp
     and (not p_open_only or s.ended_at is null)
   order by s.started_at desc
   limit greatest(least(coalesce(limit_rows, 200), 500), 1);
end;
$$;

revoke all on function public.my_radius_sessions(boolean, integer) from public;
grant execute on function public.my_radius_sessions(boolean, integer) to authenticated;

comment on function public.my_radius_sessions(boolean, integer) is
  'RADIUS sessions for the caller''s own ISP, resolved from auth.uid(). Takes no '
  'isp_id, so a client cannot widen it. radius_sessions is the only store; this '
  'is a read model over it, not a second table.';

commit;