-- =============================================================================
--  Connect a RADIUS session to the network worker.
--
--  Found by tracing the layers rather than reading them.
--
--  Two things were missing between "a customer is online" and "the router cuts
--  them off", and neither was a missing feature so much as two rows that were
--  never joined.
--
--  1. request_session_disconnect() recorded the intent and stopped there.
--     It closed the session and wrote a router_session_commands row, but never
--     enqueued a router_jobs row. Nothing in the system reads those command rows
--     and enqueues work, so the disconnect never reached a router. The worker is
--     the only component that can speak RouterOS and it only executes rows in
--     router_jobs.
--
--  2. A RADIUS session had no router attached.
--     radius_sessions.node_id is nullable and NOTHING sets it: the accounting
--     statement in queries.conf records isp_id, called_station_id and
--     nas_identifier, but not node_id. So even with a job enqueued there was no
--     node to address, and the function would have taken its "router_notified:
--     false" branch for every real customer.
--
--     The link already exists and is unambiguous: radius_nas.nas_identifier is
--     UNIQUE and is exactly what FreeRADIUS writes into Called-Station-Id, which
--     is what queries.conf stores in called_station_id. The router is therefore
--     resolved from the session's own NAS, inside the tenant, so an unregistered
--     router resolves to nothing rather than to some other ISP's device.
--
--  Both changes are additive and reuse the existing queue: the job is the same
--  shape the panel already produces for a manual disconnect, so the worker's
--  'disconnect' handler is unchanged and no second code path is introduced.
-- =============================================================================

begin;
create or replace function public.request_session_disconnect(
  p_acct_session_id text
, p_reason text default 'admin'
) returns jsonb
  language plpgsql
  security definer
  set search_path = public as $$
declare
  v_isp     uuid := public.current_isp_id();
  v_sess    public.radius_sessions;
  v_cmd     uuid;
  v_node    uuid;
  v_out     uuid;
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

  -- ...and resolve the router. A session opened by post-auth or accounting has
  -- no node_id of its own, so fall back to the NAS that authenticated it. Scoped
  -- to this tenant AND to the session's own called_station_id, so a session
  -- cannot be pointed at another ISP's router by any means.
  v_node := v_sess.node_id;
  if v_node is null and coalesce(v_sess.called_station_id, '') <> '' then
    select n.node_id into v_node
      from public.radius_nas n
     where n.isp_id = v_sess.isp_id
       and n.nas_identifier = v_sess.called_station_id
     limit 1;
  end if;

  -- radius_sessions has NO mac_address column: RADIUS accounting never records
  -- one, and inventing a value would be a guess. The worker's disconnect handler
  -- looks up by the router's own id, then MAC, then `=user`, and RADIUS sessions
  -- always carry a username, so the user lookup is the correct fallback.
  insert into public.router_session_commands (
    isp_id, node_id, radius_session_id, command, mac_address, ip_address, status
  ) values (
    v_sess.isp_id, v_node, v_sess.id, 'disconnect', null,
    v_sess.framed_ip, 'pending'
  )
  returning id into v_cmd;

  insert into public.audit_logs(
    actor_id, actor_role, isp_id, action, target_type, target_id, metadata
  ) values (
    auth.uid(),
    case when public.is_super_admin() then 'super_admin'::platform_role
         else 'isp_admin'::platform_role end,
    v_sess.isp_id, 'session:disconnect-requested', 'radius_session', v_sess.id::text,
    jsonb_build_object('username', v_sess.username,
                       'acct_session_id', v_sess.acct_session_id));
  v_out := v_cmd;

  -- Only a router that actually exists can be asked. Without this the command
  -- sat pending forever and the operator was told the request was outstanding,
  -- which is honest but never resolves.
  if v_node is not null then
    insert into public.router_jobs (
      isp_id, node_id, kind, payload, idempotency_key, priority, max_attempts
    ) values (
      v_sess.isp_id, v_node, 'disconnect',
      jsonb_build_object('command_id', v_cmd,
                         'username', v_sess.username,
                         'ip_address', v_sess.framed_ip,
                         'acct_session_id', v_sess.acct_session_id),
      -- One disconnect per session, so a double-click cannot cut a customer off
      -- twice or queue two identical jobs.
      'disconnect:' || v_sess.id::text,
      1, 3
    );
  end if;

  return jsonb_build_object(
    'ok', true,
    'command_id', v_out,
    'router_notified', v_node is not null,
    'detail', case when v_node is not null then
                     'Closed in ISPFlow and queued for the router. The session ' ||
                     'stays closed here even if the router cannot be reached.'
                   else
                     'Closed in ISPFlow, but this session has no router attached, ' ||
                     'so nothing was queued. It will end at the next session ' ||
                     'timeout or reconnect.'
                 end);
end;
$$;

comment on function public.request_session_disconnect(text, text) is
  'Closes a RADIUS session in ISPFlow and, when the session can be traced to a '
  'router, queues the disconnect job the worker executes. Resolves the router '
  'through radius_nas when the session has no node_id of its own.';

revoke all on function public.request_session_disconnect(text, text) from public;
grant execute on function public.request_session_disconnect(text, text) to authenticated;

commit;