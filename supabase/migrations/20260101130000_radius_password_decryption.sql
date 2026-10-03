-- =============================================================================
--  RADIUS password decryption without a session GUC.
--
--  The reply query decrypted the stored password with:
--
--      extensions.pgp_sym_decrypt(
--          sa.password_encrypted::bytea,
--          current_setting('netisp.radius_key', true))
--
--  and always returned an empty string. Measured on the host, connecting with
--  the exact `options=` string taken from the installed module file:
--
--      no options              -> current_setting(...) = NULL
--      module options verbatim -> current_setting(...) = NULL
--
--  The key IS present in the options string, and its SHA-256 prefix matches
--  radius_key_fingerprint() exactly, so the key is correct and in the right
--  place. The `options` connection parameter simply never reaches the backend:
--  the Supabase pooler terminates the connection and does not forward libpq
--  startup options. `-c netisp.radius_key=...` is silently dropped.
--
--  `current_setting(..., true)` returns NULL for a missing GUC rather than
--  raising, so the failure was silent: pgp_sym_decrypt(bytea, NULL) is NULL,
--  NULL reached rlm_sql as "", and pap compared the real password against an
--  empty string and failed every login with
--
--      pap: Comparing with "known good" Cleartext-Password
--      pap: ERROR: Cleartext password does not match "known good" password
--
--  THE FIX
--  -------
--  Decrypt inside a SECURITY DEFINER function that reads the key itself, which
--  is exactly how set_service_account_password() already encrypts. Nothing about
--  the storage design changes:
--
--    * the password stays pgp_sym_encrypt-ed at rest, unchanged;
--    * the key stays in netisp_internal_keys and is NOT granted to radius_reader,
--      so the function being SECURITY DEFINER is what keeps the key unreadable;
--    * the key never appears in a query string, a log line or a config file that
--      a debug run would echo.
--
--  It is scoped by BOTH username and tenant, and the caller passes nas.isp_id -
--  the tenant resolved from the registered router - so it cannot be used to read
--  another tenant's subscriber.
--
--  EXECUTE is revoked from PUBLIC, anon and authenticated and granted only to
--  radius_reader and service_role. A SECURITY DEFINER function that returns
--  cleartext passwords and is callable by the browser's role would be a far
--  worse problem than the one this fixes.
-- =============================================================================

create or replace function public.radius_cleartext_password(
  p_username text,
  p_isp_id    uuid
)
returns text
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_encrypted text;
  v_key       text;
begin
  -- Both parameters are required. A NULL either way returns NULL rather than
  -- falling back to "the only subscriber with this name", which is how a
  -- tenant-agnostic password lookup happens.
  if p_username is null or p_isp_id is null then
    return null;
  end if;

  select sa.password_encrypted, k.key_value
    into v_encrypted, v_key
    from public.service_accounts sa
    join public.netisp_internal_keys k
      on k.name = 'radius_host_key'
   where sa.username  = p_username
     and sa.isp_id    = p_isp_id;

  if v_encrypted is null or v_encrypted = '' or v_key is null then
    return null;
  end if;

  return extensions.pgp_sym_decrypt(v_encrypted::bytea, v_key);
exception
  when others then
    -- A wrong key or corrupt ciphertext must not surface as a password. It
    -- must look exactly like "no password configured", so the policy rejects
    -- rather than comparing against garbage.
    return null;
end;
$$;

comment on function public.radius_cleartext_password(text, uuid) is
  'Decrypts a subscriber password for RADIUS. SECURITY DEFINER so radius_reader '
  'never needs to read netisp_internal_keys. Returns NULL for an unknown '
  'subscriber, an unprovisioned password, or any decryption failure, so the '
  'caller cannot distinguish "wrong tenant" from "no such subscriber".';

revoke all on function public.radius_cleartext_password(text, uuid)
  from public, anon, authenticated;
grant execute on function public.radius_cleartext_password(text, uuid)
  to radius_reader, service_role;
