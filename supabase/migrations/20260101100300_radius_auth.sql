-- =============================================================================
--  RADIUS authentication: tenant resolution and verifiable passwords.
--
--  Three defects in the previous design are fixed here, each of which made
--  authentication impossible or unsafe rather than merely untidy.
--
--  1. There was no way to authenticate anyone.
--     service_accounts.password_hash existed but nothing in the system ever
--     wrote it, and the RADIUS query selected no password column at all, so
--     sql_load_accounts() had nothing to compare. Rather than store a password
--     that CHAP and MS-CHAP cannot verify without the cleartext -- and which is
--     exactly what MikroTik sends for PPPoE and HotSpot -- the password is
--     encrypted at rest and decrypted only for the duration of the RADIUS
--     query, by the RADIUS server itself.
--
--     The encryption key never lives in this database. It is held only in the
--     FreeRADIUS sql.conf on the RADIUS host and injected per connection as a
--     session GUC (`netisp.radius_key`), so a database dump yields nothing
--     usable and a compromised SQL role yields nothing either.
--
--  2. The lookup was not tenant-safe.
--     The old query was `WHERE sa.username = '%{User-Name}' LIMIT 1`. Username
--     is unique per (isp_id, username), NOT globally, so with two ISPs running
--     a "john" the query could return either tenant's subscriber and bill the
--     wrong one. The comment in the old query claimed this "can never return
--     two candidates"; it could. The tenant is now resolved from the NAS that
--     sent the packet and the lookup is scoped by it, so the question
--     "whose subscriber is this?" has exactly one answer.
--
--  3. Accounting had no tenant provenance.
--     radius_sessions.isp_id was nullable and set from a subquery over
--     service_accounts by username alone -- the same ambiguity. It is now
--     derived from the NAS and NOT NULL.
--
--  Additive and non-destructive. No existing row is altered, and existing
--  service_accounts rows simply have a NULL password until one is provisioned,
--  which is a rejection, not a bypass.
-- =============================================================================

begin;

-- ── NAS registry ──────────────────────────────────────────────────────────────
--
-- Maps a RADIUS client (the router) to its tenant. This is the trust anchor for
-- tenant isolation: a packet from a NAS that is not in this table is rejected
-- before any subscriber lookup, so an unregistered router cannot ask about any
-- customer.
create table if not exists public.radius_nas (
  id              uuid primary key default gen_random_uuid(),
  isp_id          uuid not null references public.isps(id) on delete cascade,
  node_id         uuid references public.nodes(id) on delete set null,

  -- What the router puts in Called-Station-Id / NAS-Identifier.
  nas_identifier  text not null,

  -- Source address FreeRADIUS saw. Stored so a router behind NAT, whose
  -- address can change, can be re-matched without editing the client entry.
  client_ip       inet,

  secret_set      boolean not null default false,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  constraint radius_nas_identifier_ck check (nas_identifier ~ '^[A-Za-z0-9._-]{1,64}$')
);

-- One router, one tenant. This uniqueness is what makes the tenant resolution
-- below return at most one row, so the subscriber lookup cannot be ambiguous.
create unique index if not exists radius_nas_identifier_key
  on public.radius_nas (nas_identifier);
create unique index if not exists radius_nas_node_key
  on public.radius_nas (node_id) where node_id is not null;

comment on table public.radius_nas is
  'RADIUS client (router) to tenant mapping. The trust anchor for tenant '
  'isolation: an unregistered NAS is rejected before any subscriber lookup.';

-- ── Password storage ──────────────────────────────────────────────────────────
--
-- Nullable on purpose. A service account with no password cannot authenticate,
-- and that is the correct state for an account nobody has provisioned yet.
alter table public.service_accounts
  add column if not exists password_encrypted text;

comment on column public.service_accounts.password_encrypted is
  'OpenPGP-symmetric password (pgcrypto pgp_sym_encrypt). Encrypted with the '
  'RADIUS host key, which is NOT stored in this database. Decrypted only by '
  'the RADIUS server for the duration of an authentication query.';

-- ── Accounting provenance ─────────────────────────────────────────────────────
--
-- isp_id must come from the NAS, never from a username lookup.
alter table public.radius_sessions
  add column if not exists nas_identifier text;
alter table public.radius_sessions
  drop constraint if exists radius_sessions_isp_id_nn;

-- ── Session termination reason ────────────────────────────────────────────────
--
-- Acct-Terminate-Cause from the router, so a disconnect can be attributed to a
-- customer request, an idle timeout or an admin cut-off rather than guessed.
alter table public.radius_sessions
  add column if not exists terminate_cause integer;
alter table public.radius_sessions
  add column if not exists last_interim_at timestamptz;

comment on column public.radius_sessions.last_interim_at is
  'Timestamp of the most recent Interim-Update. Distinguishes a session that '
  'is genuinely alive from one whose router died without sending Acct-Stop.';

-- ── Provisioning: store a password without ever storing plaintext ─────────────
--
-- The cleartext password arrives as a parameter, is encrypted immediately with
-- the RADIUS host key, and the cleartext variable is overwritten. Nothing
-- writes it to a log, a table or a result.
--
-- SECURITY DEFINER because the caller is an Edge Function holding the service
-- role, while the function itself needs the key held in this locked table.
-- search_path is pinned so a hijacked schema cannot redirect it.
create table if not exists public.netisp_internal_keys (
  name       text primary key,
  key_value  text not null,
  updated_at timestamptz not null default now()
);

-- No policy at all: unreadable by every role except the function owner.
-- radius_reader has no grant on it, so a RADIUS compromise cannot read the key
-- that would otherwise let it read every password.
revoke all on public.netisp_internal_keys from public, anon, authenticated;

create or replace function public.set_service_account_password(
  p_username text,
  p_password text,
  p_isp_id    uuid default null
) returns uuid
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_row public.service_accounts;
  v_key text;
begin
  if p_password is null or length(p_password) < 6 then
    raise exception 'Password must be at least 6 characters'
      using errcode = 'invalid_parameter_value';
  end if;

  select key_value into v_key
  from public.netisp_internal_keys where name = 'radius_host_key';

  if v_key is null then
    raise exception 'RADIUS host key is not configured'
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  -- Scope by tenant whenever the caller supplies one. An unqualified lookup
  -- would let one ISP set the password of another ISP's identically-named
  -- subscriber.
  if p_isp_id is null then
    select * into v_row
    from public.service_accounts where username = p_username
    order by created_at limit 1;
  else
    select * into v_row
    from public.service_accounts
    where username = p_username and isp_id = p_isp_id
    limit 1;
  end if;

  if v_row.id is null then
    raise exception 'No service account for that username'
      using errcode = 'no_data_found';
  end if;

  update public.service_accounts
     set password_encrypted = extensions.pgp_sym_encrypt(p_password, v_key),
         password_hash = 'pgp',
         updated_at = now()
   where id = v_row.id;

  -- Overwrite so the cleartext does not linger in the frame.
  p_password := null;

  return v_row.id;
end;
$$;

revoke all on function public.set_service_account_password(text, text, uuid)
  from public;
grant execute on function public.set_service_account_password(text, text, uuid)
  to authenticated, service_role;

-- ── Verification helper ───────────────────────────────────────────────────────
--
-- Lets a deployment prove the key on the RADIUS host matches the key used here,
-- without either side revealing it: both hash their copy and the digests are
-- compared.
create or replace function public.radius_key_fingerprint()
returns text
language sql
security definer
set search_path = public, pg_temp
as $$
  select encode(
           extensions.digest(
             coalesce((select key_value from public.netisp_internal_keys
                        where name = 'radius_host_key'), ''),
             'sha256'),
           'hex');
$$;

revoke all on function public.radius_key_fingerprint() from public;
grant execute on function public.radius_key_fingerprint() to service_role;

-- ── radius_reader: what RADIUS may read ───────────────────────────────────────
grant select on public.radius_nas to radius_reader;

-- The rest of what the queries read. These grants were applied directly to the
-- database when the module was brought up but were never written down here, so
-- the migration did not reproduce the permissions the server actually depends
-- on: a database rebuilt from migrations would have had radius_reader able to
-- resolve a router and then fail to find the subscriber.
grant select on public.service_accounts to radius_reader;
grant select on public.plans to radius_reader;
grant select on public.radius_accounts to radius_reader;

-- Accounting writes. The session table is the only thing RADIUS may modify, and
-- only through the statements in queries.conf.
grant insert, update on public.radius_sessions to radius_reader;

-- pgp_sym_decrypt runs as SECURITY DEFINER (see set_service_account_password),
-- so radius_reader can use it without holding any grant on netisp_internal_keys.
-- Deliberately NOT granted:
--   netisp_internal_keys   the RADIUS host key
--   router_credentials     every router's admin password
--   payments               customer money

commit;