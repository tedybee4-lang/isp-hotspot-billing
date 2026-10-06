-- =============================================================================
--  Router-side heartbeat: a long-lived credential and the endpoint that
--  consumes it.
--
--  The worker polls routers over the API (the primary liveness path), but a
--  router behind NAT that the worker cannot reach still needs a way to report
--  in - that is the scheduler-installed heartbeat on the router. It POSTs to
--  `/functions/v1/router-provision/ping`, and that endpoint must attribute the
--  ping to exactly one router without trusting anything in the body.
--
--  A 'claim' token is single-use and a 'discover' token lives 30 minutes, so
--  neither can authenticate a job that runs every few minutes for a year. This
--  adds a dedicated `heartbeat` purpose with a long expiry, stored hashed like
--  every other provisioning token, plus two functions:
--
--    mint_heartbeat_token   creates (or reports) the session's heartbeat
--                           credential; p_force rotates it, used only when
--                           the installed script is known absent and needs a
--                           fresh secret to embed.
--
--    record_router_ping     validates the credential, resolves the node from
--                           the SESSION (never the request body) and records
--                           through the same record_router_heartbeat() the
--                           worker uses, so one function owns "is it alive".
--
--  Service-role only: no browser and no anonymous role can mint or redeem.
-- =============================================================================

-- ── 1. Purpose: add 'heartbeat' ─────────────────────────────────────────────
alter table public.provisioning_tokens
  drop constraint if exists provisioning_tokens_purpose_check;
alter table public.provisioning_tokens
  add constraint provisioning_tokens_purpose_check
  check (purpose in ('claim','configure','rotate','discover','heartbeat'));

comment on column public.provisioning_tokens.purpose is
  'claim = bootstrap script fetch (single use). discover = the router posting '
  'its self-survey back. heartbeat = the router''s scheduled POST to /ping; '
  'long-lived, hashed, bound to one session.';

-- ── 2. Mint the heartbeat credential ────────────────────────────────────────
-- Called by the Edge Function (all-in-one bootstrap) and the network worker
-- (heartbeat stage) with the service role. The PLAINTEXT is returned exactly
-- once, on creation; a live token is reported as code=exists WITHOUT its
-- plaintext, because only the hash is stored. p_force revokes every live
-- heartbeat token for the session first - used only when the caller has
-- confirmed no installed script holds a valid one, so rotation can never
-- strand a working heartbeat.
create or replace function public.mint_heartbeat_token(
  p_session_id uuid,
  p_force      boolean default false
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_isp     uuid;
  v_hash    text;
  v_token   text;
  v_expires timestamptz;
begin
  select s.isp_id into v_isp
    from public.provisioning_sessions s where s.id = p_session_id;
  if v_isp is null then
    raise exception 'Provisioning session not found';
  end if;

  select t.token_hash into v_hash
    from public.provisioning_tokens t
   where t.session_id = p_session_id
     and t.purpose = 'heartbeat'
     and t.revoked_at is null
     and t.expires_at > now()
   order by t.created_at desc
   limit 1;

  if v_hash is not null and not p_force then
    -- Already exists. The caller that needs the plaintext is the caller about
    -- to INSTALL the script, so "exists" means "already installed" - minting a
    -- second live token here would create a credential nothing holds.
    return jsonb_build_object('ok', true, 'code', 'exists', 'token', null);
  end if;

  if p_force then
    update public.provisioning_tokens
       set revoked_at = now()
     where session_id = p_session_id
       and purpose = 'heartbeat'
       and revoked_at is null;
  end if;

  v_token   := encode(extensions.gen_random_bytes(32), 'hex');
  v_hash    := encode(extensions.digest(v_token, 'sha256'), 'hex');
  v_expires := now() + interval '400 days';

  insert into public.provisioning_tokens (session_id, isp_id, token_hash, purpose, expires_at)
  values (p_session_id, v_isp, v_hash, 'heartbeat', v_expires);

  return jsonb_build_object('ok', true, 'code', 'created', 'token', v_token,
                            'expires_at', v_expires);
end;
$$;
-- ── 3. Redeem a ping ────────────────────────────────────────────────────────
-- The token decides which session, the session decides which node, and the
-- body can only ever ADD read-only facts (version, uptime, free memory). A
-- request that cannot be attributed is rejected without touching anything.
--
-- The RouterOS uptime string ("1w2d3h4m5s") is parsed best-effort into seconds
-- for record_router_heartbeat; anything unparseable records null rather than
-- failing the ping, because a heartbeat that arrives is more valuable than a
-- precise uptime figure.
create or replace function public.record_router_ping(
  p_token_hash       text,
  p_identity         text default null,
  p_routeros_version text default null,
  p_uptime           text default null,
  p_free_memory      bigint default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_token   public.provisioning_tokens%rowtype;
  v_session public.provisioning_sessions%rowtype;
  v_secs    bigint := 0;
  v_part    text[];
  v_mb      integer;
begin
  if p_token_hash is null or length(p_token_hash) < 32 then
    return jsonb_build_object('ok', false, 'code', 'malformed');
  end if;

  select * into v_token
    from public.provisioning_tokens
   where token_hash = p_token_hash
     and purpose = 'heartbeat'
   for update;

  if not found then
    return jsonb_build_object('ok', false, 'code', 'unknown');
  end if;
  if v_token.revoked_at is not null then
    return jsonb_build_object('ok', false, 'code', 'revoked');
  end if;
  if v_token.expires_at < now() then
    return jsonb_build_object('ok', false, 'code', 'expired');
  end if;

  select * into v_session
    from public.provisioning_sessions where id = v_token.session_id;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'no_session');
  end if;
  if v_session.state in ('revoked', 'expired') then
    return jsonb_build_object('ok', false, 'code', 'session_closed');
  end if;
  if v_session.node_id is null then
    -- Pings arrive only after the claim registered the router, but a heartbeat
    -- credential can outlive a wiped node link; say so rather than inventing
    -- a target.
    return jsonb_build_object('ok', false, 'code', 'no_node');
  end if;

  -- "1w2d3h4m5s" -> seconds. Each unit is optional; unparseable input leaves
  -- the running total alone and the caller records null.
  v_part := regexp_match(coalesce(p_uptime, ''), '(\d+)w');
  if v_part is not null then v_secs := v_secs + v_part[1]::bigint * 604800; end if;
  v_part := regexp_match(coalesce(p_uptime, ''), '(\d+)d');
  if v_part is not null then v_secs := v_secs + v_part[1]::bigint * 86400; end if;
  v_part := regexp_match(coalesce(p_uptime, ''), '(\d+)h');
  if v_part is not null then v_secs := v_secs + v_part[1]::bigint * 3600; end if;
  v_part := regexp_match(coalesce(p_uptime, ''), '(\d+)m');
  if v_part is not null then v_secs := v_secs + v_part[1]::bigint * 60; end if;
  v_part := regexp_match(coalesce(p_uptime, ''), '(\d+)s');
  if v_part is not null then v_secs := v_secs + v_part[1]::bigint; end if;

  -- free-memory arrives in bytes from /system resource; the heartbeat column
  -- is megabytes.
  if p_free_memory is not null and p_free_memory > 0 then
    v_mb := greatest(1, (p_free_memory / 1048576)::integer);
  end if;

  -- A heartbeat is also the cheapest identity proof the router can offer: the
  -- session's detected facts are refreshed from it, never from the token row.
  if p_identity is not null and btrim(p_identity) <> '' then
    update public.provisioning_sessions s
       set detected = coalesce(s.detected, '{}'::jsonb)
             || jsonb_build_object('identity', left(btrim(p_identity), 64))
     where s.id = v_session.id;
  end if;

  perform public.record_router_heartbeat(
    p_node_id          => v_session.node_id,
    p_ok               => true,
    p_source           => 'router',
    p_routeros_version => p_routeros_version,
    p_ram_free_mb      => v_mb,
    p_uptime_seconds   => case when v_secs > 0 then v_secs else null end
  );

  return jsonb_build_object('ok', true,
                            'node_id', v_session.node_id,
                            'session_id', v_session.id);
end;
$$;

comment on function public.record_router_ping(text, text, text, text, bigint) is
  'Redeems a heartbeat POST from a router: token hash decides the session, the '
  'session decides the node, the body contributes only read-only facts.';

revoke all on function public.record_router_ping(text, text, text, text, bigint) from public, anon, authenticated;
grant execute on function public.record_router_ping(text, text, text, text, bigint) to service_role;


comment on function public.mint_heartbeat_token(uuid, boolean) is
  'Mints the long-lived credential the router''s scheduled heartbeat POSTs to '
  '/ping with. Plaintext returned only on creation; service role only.';

revoke all on function public.mint_heartbeat_token(uuid, boolean) from public, anon, authenticated;
grant execute on function public.mint_heartbeat_token(uuid, boolean) to service_role;
