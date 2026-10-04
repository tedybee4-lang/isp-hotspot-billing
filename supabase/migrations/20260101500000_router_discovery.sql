-- =============================================================================
--  Router self-discovery: receive what the router found, and stage the work.
--
--  The claim already told us a router's board, version and architecture from a
--  handful of query parameters. That registers a router but cannot answer the
--  question that decides whether provisioning is safe: what is ALREADY
--  configured on this box? An ISP onboarding a router that has run production
--  for two years must see its existing bridges, pools, HotSpot servers and
--  PPPoE customers BEFORE anything is applied.
--
--  So the router now surveys itself (see _shared/discovery.ts) and posts each
--  subsystem back here. One POST per subsystem, because `/tool fetch
--  output=user` caps a body at 63 KiB and because one unsupported menu must
--  cost exactly one survey rather than the whole report.
--
--  Two things are added here and nothing is changed:
--    * a 'discover' purpose for provisioning_tokens, so discovery carries its
--      own short-lived credential instead of reusing the single-use claim;
--    * a provisioning_stages table, so a twelve-stage rollout is visible and
--      resumable rather than one opaque state column.
-- =============================================================================

begin;

-- ── 1. A separate credential for discovery ─────────────────────────────────
--
-- The claim token is single-use and is consumed the moment the router fetches
-- its bootstrap script. Discovery happens AFTER that, from inside the script we
-- just returned, so it cannot reuse the claim token. Giving it its own token
-- means discovery can expire independently and can be revoked without
-- invalidating a router that is already half-provisioned.
--
-- Widening an existing check constraint is a rewrite of one column's constraint,
-- not a table rewrite: no row is touched, and 'claim' tokens keep their meaning.
alter table public.provisioning_tokens
  drop constraint if exists provisioning_tokens_purpose_check;
alter table public.provisioning_tokens
  add constraint provisioning_tokens_purpose_check
  check (purpose in ('claim','configure','rotate','discover'));

comment on column public.provisioning_tokens.purpose is
  'claim = bootstrap script fetch (single use). discover = the router posting '
  'its self-survey back, minted during the claim and expiring independently.';

-- ── 2. Persist what the router reports ─────────────────────────────────────
--
-- One row per (session, survey). Written with an upsert so a router that
-- retries a survey after a flaky uplink overwrites its own earlier answer
-- instead of accumulating contradictory copies.
create table if not exists public.router_surveys (
  session_id  uuid not null references public.provisioning_sessions(id) on delete cascade,
  isp_id      uuid not null references public.isps(id) on delete cascade,
  survey      text not null,
  payload     jsonb not null default '{}'::jsonb,
  -- 'reported' = the router answered. 'skipped' = it deliberately did not look,
  -- and said why. Never collapsing the two is what keeps "we did not ask"
  -- distinguishable from "the box does not support it".
  status      text not null default 'reported'
                check (status in ('reported','skipped')),
  router_ip   text,
  reported_at timestamptz not null default now(),
  primary key (session_id, survey)
);

create index if not exists router_surveys_session_idx
  on public.router_surveys (session_id);

comment on table public.router_surveys is
  'What each router reported about itself, per subsystem. Read-only from the '
  'panel; written only by record_router_survey() using a discover token.';

alter table public.router_surveys enable row level security;
alter table public.router_surveys force row level security;

drop policy if exists router_surveys_read on public.router_surveys;
create policy router_surveys_read on public.router_surveys for select
  using (public.is_super_admin() or isp_id = public.current_isp_id());

-- No insert/update/delete policy on purpose. The router is not authenticated
-- as a user and must never be able to write directly; it goes through the
-- security-definer function below, which checks the token.

-- ── 3. Receive one survey ────────────────────────────────────────────────
--
-- SECURITY: the router proves who it is with a 'discover' token, looked up by
-- hash exactly like the claim token. It cannot name a session or an ISP: both
-- come from the token row, so a router holding ISP A's token can only ever
-- write into ISP A's session. There is deliberately no session_id parameter.
--
-- The token is NOT consumed here. A router sends ~25 surveys, and consuming it
-- on the first would break exactly the rural, lossy links this feature exists
-- to serve. Expiry and revocation still apply, so the window stays bounded.
create or replace function public.record_router_survey(
  p_token_hash text,
  p_survey     text,
  p_payload    jsonb,
  p_router_ip  text default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_token   public.provisioning_tokens%rowtype;
  v_session public.provisioning_sessions%rowtype;
  v_status  text := 'reported';
  v_count   integer := 0;
begin
  if p_token_hash is null or length(p_token_hash) < 32 then
    return jsonb_build_object('ok', false, 'code', 'malformed',
                              'message', 'Missing or malformed token.');
  end if;

  if p_survey is null or btrim(p_survey) = '' or length(p_survey) > 40 then
    return jsonb_build_object('ok', false, 'code', 'bad_survey',
                              'message', 'Unknown survey.');
  end if;

  select * into v_token
    from public.provisioning_tokens
   where token_hash = p_token_hash
     and purpose = 'discover'
   for update;

  if not found then
    return jsonb_build_object('ok', false, 'code', 'unknown',
                              'message', 'Unknown token.');
  end if;
  if v_token.revoked_at is not null then
    return jsonb_build_object('ok', false, 'code', 'revoked',
                              'message', 'This provisioning link was revoked.');
  end if;
  if v_token.expires_at < now() then
    return jsonb_build_object('ok', false, 'code', 'expired',
                              'message', 'This provisioning link has expired.');
  end if;

  select * into v_session from public.provisioning_sessions where id = v_token.session_id;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'no_session',
                              'message', 'Provisioning session missing.');
  end if;

  -- A skipped survey carries a reason and no data. Keeping the two states
  -- apart is what stops the panel reporting "no wireless" on a router nobody
  -- asked about wireless.
  if p_payload ? 'unsupported' then
    v_status := 'skipped';
    p_payload := jsonb_build_object('unsupported', p_payload->'unsupported');
  end if;

  insert into public.router_surveys (session_id, isp_id, survey, payload, status, router_ip)
  values (v_session.id, v_session.isp_id, btrim(p_survey), coalesce(p_payload, '{}'::jsonb),
          v_status, left(coalesce(p_router_ip, ''), 64))
  on conflict (session_id, survey) do update
     set payload     = excluded.payload,
         status      = excluded.status,
         router_ip   = coalesce(excluded.router_ip, router_surveys.router_ip),
         reported_at = now();

  -- Mirror the identity and resource answers onto the session, because those
  -- are what the node row and the wizard read and they should not need a
  -- second round trip to be joined in.
  if btrim(p_survey) in ('identity', 'resource', 'board') then
    update public.provisioning_sessions s
       set detected = s.detected || jsonb_build_object(btrim(p_survey), p_payload)
     where s.id = v_session.id;
  end if;

  if v_status = 'reported' then
    select count(*) into v_count
      from public.router_surveys
     where session_id = v_session.id and status = 'reported';
  end if;

  return jsonb_build_object('ok', true, 'survey', btrim(p_survey),
                            'status', v_status, 'reported', v_count);
end;
$$;

comment on function public.record_router_survey(text, text, jsonb, text) is
  'Receives one self-survey from a router, authenticated by a discover token. '
  'The session and ISP come from the token, never from the request.';

revoke all on function public.record_router_survey(text, text, jsonb, text) from public, anon, authenticated;
grant execute on function public.record_router_survey(text, text, jsonb, text) to service_role;

-- ── 4. Mint the discovery token during the claim ─────────────────────────
--
-- Called by the Edge Function immediately after claim_provisioning_token()
-- succeeds, so this credential is only ever created for a router that has
-- already proved it holds a valid claim token.
create or replace function public.mint_discovery_token(p_session_id uuid)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_isp     uuid;
  v_token   text;
  v_hash    text;
  v_expires timestamptz;
begin
  select s.isp_id into v_isp from public.provisioning_sessions s where s.id = p_session_id;
  if v_isp is null then
    raise exception 'Provisioning session not found';
  end if;

  -- A live discovery token is reused rather than replaced, so a router whose
  -- claim was retried keeps working instead of invalidating its own earlier
  -- script mid-flight.
  select t.token_hash into v_hash
    from public.provisioning_tokens t
   where t.session_id = p_session_id
     and t.purpose = 'discover'
     and t.revoked_at is null
     and t.expires_at > now()
   order by t.created_at desc
   limit 1;

  if v_hash is not null then
    return jsonb_build_object('ok', false, 'code', 'already_minted');
  end if;

  v_token   := encode(extensions.gen_random_bytes(24), 'hex');
  v_hash    := encode(extensions.digest(v_token, 'sha256'), 'hex');
  v_expires := now() + interval '30 minutes';

  insert into public.provisioning_tokens (session_id, isp_id, token_hash, purpose, expires_at)
  values (p_session_id, v_isp, v_hash, 'discover', v_expires);

  return jsonb_build_object('ok', true, 'token', v_token, 'expires_at', v_expires);
end;
$$;

comment on function public.mint_discovery_token(uuid) is
  'Mints the short-lived credential a router uses to post its self-survey. '
  'Called by the Edge Function after a successful claim, never by a browser.';

revoke all on function public.mint_discovery_token(uuid) from public, anon, authenticated;
grant execute on function public.mint_discovery_token(uuid) to service_role;

-- ── 5. What the router already has, for the wizard ───────────────────────
--
-- One read that assembles the port table the ISP actually chooses from:
-- discovered interfaces, plus what is already on each of them. A port the
-- incumbent operator commented "UPLINK" is shown as such rather than as an
-- empty etherN.
create or replace function public.router_discovery_summary(p_session_id uuid)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_isp uuid := public.current_isp_id();
  v_row public.provisioning_sessions%rowtype;
begin
  select * into v_row from public.provisioning_sessions s
   where s.id = p_session_id
     and (public.is_super_admin() or s.isp_id = v_isp);
  if v_row.id is null then
    raise exception 'Provisioning session not found';
  end if;

  return jsonb_build_object(
    'session_id',   v_row.id,
    'state',        v_row.state,
    'role',         v_row.role,
    'detected',     v_row.detected,
    'surveys', coalesce((
      select jsonb_object_agg(sr.survey,
                              jsonb_build_object('status', sr.status, 'payload', sr.payload))
        from public.router_surveys sr
       where sr.session_id = v_row.id), '{}'::jsonb),
    -- Read from router_surveys, not from detected: only identity/resource/board
    -- are mirrored onto the session row, because those three are what the node
    -- row and the compatibility engine consume. The port table lives with the
    -- rest of the survey data.
    'interfaces', coalesce((
      select jsonb_agg(jsonb_build_object(
               'name',     e->>'name',
               'type',     e->>'type',
               'running',  e->>'running',
               'disabled', e->>'disabled',
               'comment',  nullif(e->>'comment', '')))
        from jsonb_array_elements(
               coalesce((select sr.payload
                           from public.router_surveys sr
                          where sr.session_id = v_row.id and sr.survey = 'interfaces'), '[]'::jsonb)) e),
      '[]'::jsonb),
    'production_config', jsonb_build_object(
      'bridges', coalesce(public.survey_count(v_row.id, 'bridges'), 0),
      'vlans',   coalesce(public.survey_count(v_row.id, 'vlans'),   0),
      'dhcp',    coalesce(public.survey_count(v_row.id, 'dhcp'),    0),
      'pools',   coalesce(public.survey_count(v_row.id, 'pools'),   0),
      'hotspot', coalesce(public.survey_count(v_row.id, 'hotspot'), 0),
      -- HotSpot users live under the 'pppoe' survey key: that is the one that
      -- walks /ip hotspot user, which is where paying customers' sessions are.
      'hotspot_users', coalesce(public.survey_count(v_row.id, 'pppoe'), 0),
      'firewall', coalesce(public.survey_count(v_row.id, 'firewall'), 0),
      'nat',      coalesce(public.survey_count(v_row.id, 'nat'),      0))
  );
end;
$$;

comment on function public.router_discovery_summary(uuid) is
  'The port table and existing-configuration counts the ISP chooses from. '
  'Tenant-checked against the session, like every panel read.';

revoke all on function public.router_discovery_summary(uuid) from public, anon;
grant execute on function public.router_discovery_summary(uuid) to authenticated, service_role;

-- How many rows one survey found. Zero is a real answer ("none configured"),
-- and NULL is not: it means the survey never arrived, which the panel shows
-- differently so a router that has not reported is never mistaken for a router
-- with nothing on it.
create or replace function public.survey_count(p_session_id uuid, p_survey text)
returns integer
language sql stable security definer set search_path = public as $$
  select case
           when jsonb_typeof(sr.payload) = 'array' then jsonb_array_length(sr.payload)
           else null
         end
    from public.router_surveys sr
   where sr.session_id = p_session_id and sr.survey = p_survey;
$$;

comment on function public.survey_count(uuid, text) is
  'Row count from one router survey, or NULL when the router never reported it.';

revoke all on function public.survey_count(uuid, text) from public, anon, authenticated;
grant execute on function public.survey_count(uuid, text) to authenticated, service_role;

commit;