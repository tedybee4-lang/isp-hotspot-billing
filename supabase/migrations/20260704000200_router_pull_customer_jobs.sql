begin;

-- RouterOS devices behind NAT cannot receive connections from the worker.
-- Let only a live heartbeat credential claim jobs for its own bound router.
create or replace function public.claim_router_pull_jobs(
  p_token_hash text,
  p_limit integer default 3
) returns jsonb
  language plpgsql
  security definer
  set search_path = public
as $$
declare
  v_session_id uuid;
  v_isp_id uuid;
  v_node_id uuid;
  v_claimant text;
  v_job public.router_jobs%rowtype;
  v_jobs jsonb := '[]'::jsonb;
begin
  if p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' then
    return jsonb_build_object('ok', false, 'error', 'Invalid heartbeat credential.');
  end if;

  select s.id, s.isp_id, s.node_id
    into v_session_id, v_isp_id, v_node_id
    from public.provisioning_tokens t
    join public.provisioning_sessions s on s.id = t.session_id
    join public.nodes n on n.id = s.node_id and n.isp_id = s.isp_id
   where t.token_hash = p_token_hash
     and t.purpose = 'heartbeat'
     and t.revoked_at is null
     and t.expires_at > now()
     and s.state not in ('revoked', 'expired')
     and n.enabled;

  if v_node_id is null then
    return jsonb_build_object('ok', false, 'error', 'Router identity is not active.');
  end if;

  if not exists (
    select 1 from public.router_autoconfig_commands c
     where c.session_id = v_session_id
       and c.node_id = v_node_id
       and c.status = 'complete'
  ) then
    return jsonb_build_object('ok', true, 'jobs', v_jobs);
  end if;

  v_claimant := 'router-pull:' || v_node_id::text;

  -- An exhausted pull lease must not remain processing forever. Record its
  -- terminal outcome before selecting more work for this same router.
  for v_job in
    select j.*
      from public.router_jobs j
     where j.node_id = v_node_id
       and j.isp_id = v_isp_id
       and j.kind in ('voucher_sync', 'voucher_revoke', 'customer_sync',
                      'customer_suspend', 'customer_reactivate', 'customer_expire')
       and j.status = 'processing'
       and j.locked_by = v_claimant
       and j.locked_until < now()
       and j.attempt_count >= j.max_attempts
     for update skip locked
  loop
    insert into public.router_job_events
      (job_id, isp_id, attempt, ok, error, detail, worker)
    values
      (v_job.id, v_job.isp_id, v_job.attempt_count, false,
       'Router pull acknowledgement lease expired.',
       jsonb_build_object('transport', 'router-pull'), v_claimant);

    update public.router_jobs
       set status = 'dead',
           error = 'Router pull acknowledgement lease expired.',
           locked_by = null,
           locked_until = null,
           updated_at = now()
     where id = v_job.id;
  end loop;

  for v_job in
    select j.*
      from public.router_jobs j
     where j.node_id = v_node_id
       and j.isp_id = v_isp_id
       and j.kind in ('voucher_sync', 'voucher_revoke', 'customer_sync',
                      'customer_suspend', 'customer_reactivate', 'customer_expire')
       and j.attempt_count < j.max_attempts
       and (
         (j.status in ('pending', 'retrying') and j.next_run_at <= now())
         or (j.status = 'processing' and j.locked_by = v_claimant
             and j.locked_until < now())
       )
     order by j.priority asc, j.next_run_at asc, j.created_at asc
     limit greatest(1, least(coalesce(p_limit, 3), 5))
     for update skip locked
  loop
    update public.router_jobs
       set status = 'processing',
           locked_by = v_claimant,
           locked_until = now() + interval '5 minutes',
           attempt_count = attempt_count + 1,
           started_at = coalesce(started_at, now()),
           updated_at = now()
     where id = v_job.id
     returning * into v_job;

    if v_job.kind in ('voucher_sync', 'voucher_revoke')
       and (v_job.payload->>'voucher_id') ~*
         '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
      update public.vouchers
         set sync_state = 'processing',
             sync_node_id = v_node_id,
             sync_job_id = v_job.id,
             sync_attempts = sync_attempts + 1,
             sync_error = null,
             updated_at = now()
       where id = (v_job.payload->>'voucher_id')::uuid
         and isp_id = v_isp_id;
    end if;

    v_jobs := v_jobs || jsonb_build_array(jsonb_build_object(
      'id', v_job.id,
      'isp_id', v_job.isp_id,
      'kind', v_job.kind,
      'payload', v_job.payload
    ));
  end loop;

  return jsonb_build_object('ok', true, 'jobs', v_jobs);
end;
$$;

revoke all on function public.claim_router_pull_jobs(text, integer) from public;
grant execute on function public.claim_router_pull_jobs(text, integer) to service_role;

-- Acknowledgements use the established job completion/failure RPCs, preserving
-- their event log and retry/backoff rules. The credential, lock owner, tenant,
-- and router are revalidated in the same transaction as the state change.
create or replace function public.ack_router_pull_job(
  p_token_hash text,
  p_job_id uuid,
  p_status text,
  p_retryable boolean default true,
  p_error text default null,
  p_result jsonb default '{}'::jsonb
) returns jsonb
  language plpgsql
  security definer
  set search_path = public
as $$
declare
  v_session_id uuid;
  v_isp_id uuid;
  v_node_id uuid;
  v_claimant text;
  v_job public.router_jobs%rowtype;
  v_result jsonb;
  v_entity_id uuid;
  v_voucher public.vouchers%rowtype;
  v_client public.clients%rowtype;
  v_success boolean;
  v_error text;
begin
  if p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$'
     or p_job_id is null
     or p_status not in ('succeeded', 'failed')
     or (p_status = 'succeeded' and coalesce(p_retryable, false)) then
    return jsonb_build_object('ok', false, 'error', 'Invalid router job acknowledgement.');
  end if;

  select s.id, s.isp_id, s.node_id
    into v_session_id, v_isp_id, v_node_id
    from public.provisioning_tokens t
    join public.provisioning_sessions s on s.id = t.session_id
    join public.nodes n on n.id = s.node_id and n.isp_id = s.isp_id
   where t.token_hash = p_token_hash
     and t.purpose = 'heartbeat'
     and t.revoked_at is null
     and t.expires_at > now()
     and s.state not in ('revoked', 'expired')
     and n.enabled;

  if v_node_id is null then
    return jsonb_build_object('ok', false, 'error', 'Router identity is not active.');
  end if;
  v_claimant := 'router-pull:' || v_node_id::text;

  select * into v_job
    from public.router_jobs
   where id = p_job_id
     and isp_id = v_isp_id
     and node_id = v_node_id
     and kind in ('voucher_sync', 'voucher_revoke', 'customer_sync',
                  'customer_suspend', 'customer_reactivate', 'customer_expire')
   for update;

  if not found then
    return jsonb_build_object('ok', false, 'error', 'Job does not belong to this router.');
  end if;

  if v_job.status = 'succeeded'
     and v_job.result->>'transport' = 'router-pull' then
    return jsonb_build_object('ok', true, 'duplicate', true, 'status', 'succeeded');
  end if;
  if v_job.status <> 'processing'
     or v_job.locked_by is distinct from v_claimant
     or v_job.locked_until is null
     or v_job.locked_until < now() then
    return jsonb_build_object('ok', false, 'error', 'Job is not held by this router.');
  end if;

  v_success := p_status = 'succeeded';
  v_error := left(coalesce(nullif(p_error, ''), 'RouterOS rejected the subscriber update.'), 300);

  if v_job.kind in ('voucher_sync', 'voucher_revoke') then
    if (v_job.payload->>'voucher_id') ~*
       '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
      v_entity_id := (v_job.payload->>'voucher_id')::uuid;
      select * into v_voucher from public.vouchers
       where id = v_entity_id and isp_id = v_isp_id
       for update;
    end if;

    if v_success and (v_voucher.id is null
       or v_voucher.code is distinct from v_job.payload->>'code'
       or (v_voucher.sync_node_id is not null and v_voucher.sync_node_id <> v_node_id)) then
      v_success := false;
      v_error := 'Voucher identity or router assignment does not match the job.';
      p_retryable := false;
    end if;
  else
    if (v_job.payload->>'client_id') ~*
       '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
      v_entity_id := (v_job.payload->>'client_id')::uuid;
      select * into v_client from public.clients
       where id = v_entity_id and isp_id = v_isp_id
       for update;
    end if;

    if v_success and (v_client.id is null
       or (v_client.router_id is not null and v_client.router_id <> v_node_id)
       or (v_client.hotspot_username is not null
           and v_client.hotspot_username is distinct from v_job.payload->>'username')) then
      v_success := false;
      v_error := 'Subscriber identity or router assignment does not match the job.';
      p_retryable := false;
    end if;
  end if;

  if v_success then
    perform set_config('netisp.worker', v_claimant, true);
    v_result := public.complete_router_job(
      p_job_id,
      coalesce(p_result, '{}'::jsonb) || jsonb_build_object('transport', 'router-pull'),
      'https-pull',
      null
    );
  else
    v_result := public.fail_router_job(
      p_job_id,
      v_error,
      coalesce(p_result, '{}'::jsonb) || jsonb_build_object('transport', 'router-pull'),
      'https-pull',
      null,
      coalesce(p_retryable, false)
    );
  end if;

  if coalesce((v_result->>'ok')::boolean, false) is false then
    return v_result;
  end if;

  if v_job.kind in ('voucher_sync', 'voucher_revoke') and v_voucher.id is not null then
    update public.vouchers
       set sync_state = case
             when not v_success then 'failed'
             when v_job.kind = 'voucher_revoke' then 'revoked'
             else 'synced'
           end,
           sync_node_id = v_node_id,
           sync_job_id = v_job.id,
           sync_error = case when v_success then null else v_error end,
           synced_at = case when v_success then now() else synced_at end,
           updated_at = now()
     where id = v_voucher.id and isp_id = v_isp_id;
  elsif v_job.kind not in ('voucher_sync', 'voucher_revoke')
        and v_client.id is not null then
    update public.clients
       set network_state = case
             when not v_success then 'failed'
             when v_job.kind = 'customer_sync' then 'active'
             when v_job.kind = 'customer_reactivate' then 'active'
             when v_job.kind = 'customer_expire' then 'expired'
             else 'suspended'
           end,
           router_id = case when v_success and v_job.kind = 'customer_sync'
                            then v_node_id else router_id end,
           hotspot_username = case when v_success and v_job.kind = 'customer_sync'
                                   then v_job.payload->>'username'
                                   else hotspot_username end,
           last_sync_error = case when v_success then null else v_error end,
           updated_at = now()
     where id = v_client.id and isp_id = v_isp_id;
  end if;

  if v_success and v_job.kind in ('voucher_sync', 'customer_sync') then
    update public.router_autoconfig_commands
       set authentication_ready = true,
           updated_at = now()
     where session_id = v_session_id
       and node_id = v_node_id
       and command = 'hotspot-bootstrap'
       and status = 'complete';
  end if;

  return v_result;
end;
$$;

revoke all on function public.ack_router_pull_job(text, uuid, text, boolean, text, jsonb) from public;
grant execute on function public.ack_router_pull_job(text, uuid, text, boolean, text, jsonb) to service_role;

commit;
