-- =============================================================================
--  Daraja cutover, part 2: make the retired modes inert in the database.
--
--  The application no longer offers `platform_daraja` or `own_daraja`: the mode
--  selector, the per-tenant Daraja credential form and the shared platform
--  credential form were all removed, and `stk-push` is now an unconditional 410
--  with the Daraja implementation deleted rather than parked behind the gate.
--
--  This closes the same door from the database side, so the guarantee does not
--  depend on the browser being the only caller.
--
--  NOTHING IS DROPPED AND NOTHING IS RESET.
--
--    * The `payment_mode` and `payment_provider` enums keep their Daraja labels.
--      They are Postgres enum values behind a column type; removing one means
--      recreating the type and re-adding every row, which is destructive for no
--      security benefit once nothing can write the value.
--
--    * The Daraja credential columns stay in place. They are all NULL in
--      production (verified before writing this) and dropping them would discard
--      schema history for no gain. What matters is that nothing can write them.
--
--  What does change:
--
--    1. `set_payment_config` refuses a Daraja mode. It is SECURITY DEFINER and
--       reachable from the browser, so it was the one remaining way to write
--       `own_daraja` once the UI was gone.
--
--    2. CHECK constraints make the retired values unwritable at table level.
--
--    3. `payment_provider = 'daraja'` is refused on `payments`, so a payment row
--       can never claim to be a Daraja payment that nothing will ever settle.
-- =============================================================================

-- ── 1. The write path in the RPC ──────────────────────────────────────────────
--
-- Rewritten rather than dropped so every existing grant keeps working; the
-- signature is unchanged, so no caller breaks.
create or replace function public.set_payment_config(
  p_isp_id          uuid,
  p_payment_mode    public.payment_mode default null,
  p_mpesa_env       text default null,
  p_shortcode       text default null,
  p_passkey         text default null,
  p_consumer_key    text default null,
  p_consumer_secret text default null,
  p_till_number     text default null,
  p_paybill_number  text default null,
  p_customer_notice text default null
)
returns public.isp_payment_configs
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor uuid := auth.uid();
  v_isp   uuid;
  v_row   public.isp_payment_configs;
begin
  -- ── Daraja is closed. Refuse before anything is written. ───────────────────
  --
  -- Checked first so a caller passing both a Daraja mode and a real change gets
  -- the refusal rather than a partial write.
  if p_payment_mode is not null
     and p_payment_mode::text in ('platform_daraja', 'own_daraja') then
    raise exception
      'Daraja payment modes have been removed. Automated M-Pesa runs through HashBack;'
      ' configure the HashBack channel under Settings > Payments.'
      using errcode = 'integrity_constraint_violation';
  end if;

  -- ── Caller identity (unchanged) ────────────────────────────────────────────
  select p.isp_id into v_isp
  from public.profiles p
  where p.id = v_actor and p.role <> 'super_admin'
  limit 1;

  if v_isp is null and not exists (
    select 1 from public.profiles p where p.id = v_actor and p.role = 'super_admin'
  ) then
    raise exception 'Not allowed' using errcode = 'insufficient_privilege';
  end if;

  -- A super admin may configure any tenant; anyone else only their own.
  if v_isp is null then
    v_isp := p_isp_id;
  elsif v_isp <> p_isp_id then
    raise exception 'Not allowed' using errcode = 'insufficient_privilege';
  end if;

  insert into public.isp_payment_configs as c (isp_id)
  values (v_isp)
  on conflict (isp_id) do nothing;

  update public.isp_payment_configs c
     set payment_mode    = coalesce(p_payment_mode, c.payment_mode),
         mpesa_env       = coalesce(p_mpesa_env, c.mpesa_env),
         mpesa_shortcode = coalesce(p_shortcode, c.mpesa_shortcode),
         till_number     = coalesce(p_till_number, c.till_number),
         paybill_number  = coalesce(p_paybill_number, c.paybill_number),
         customer_notice = coalesce(p_customer_notice, c.customer_notice),
         updated_at      = now()
   where c.isp_id = v_isp
  returning * into v_row;

  -- ── The Daraja credential columns are no longer writable ───────────────────
  --
  -- Zeroed rather than coalesced, so a value cannot be smuggled in through this
  -- RPC. They are NULL in production; this only guarantees they stay that way.
  update public.isp_payment_configs c
     set mpesa_passkey         = null,
         mpesa_consumer_key    = null,
         mpesa_consumer_secret = null
   where c.isp_id = v_isp;

  return v_row;
end;
$$;

revoke all on function public.set_payment_config(uuid, public.payment_mode, text,
  text, text, text, text, text, text, text) from public;


-- ── 2. Table-level guards ────────────────────────────────────────────────────
--
-- Both columns are empty in production, so a validated constraint is safe. NOT
-- VALID is deliberately not used: an unenforced-for-existing-rows constraint
-- would leave a historical row able to be updated straight back into a Daraja
-- mode, which is the opposite of what this migration is for.
do $$
begin
  if not exists (select 1 from pg_constraint
                 where conname = 'isp_payment_configs_no_daraja') then
    alter table public.isp_payment_configs
      add constraint isp_payment_configs_no_daraja
      check (payment_mode is null or payment_mode::text not in
             ('platform_daraja', 'own_daraja'));
  end if;
end $$;

comment on constraint isp_payment_configs_no_daraja on public.isp_payment_configs is
  'Daraja payment modes were removed when HashBack became the only M-Pesa provider. '
  'The enum labels remain so existing rows and the enum type still typecheck; no '
  'caller can write them.';

-- A payment row claiming provider 'daraja' could never be settled: the settlement
-- path is HashBack-only. Refusing the write is better than accepting a row that
-- looks collectable and is not.
do $$
begin
  if not exists (select 1 from pg_constraint
                 where conname = 'payments_no_daraja_provider') then
    alter table public.payments
      add constraint payments_no_daraja_provider
      check (payment_provider is null or payment_provider::text <> 'daraja');
  end if;
end $$;

comment on constraint payments_no_daraja_provider on public.payments is
  'No new payment may claim the retired Daraja provider. Historical rows are left '
  'untouched; the platform currently holds none.';

-- ── 3. Say so where a reader will look ───────────────────────────────────────
comment on type public.payment_mode is
  'manual_till = collect by hand. platform_daraja and own_daraja are RETIRED '
  '(HashBack replaced them) and cannot be written; the labels remain so existing '
  'rows and the enum type still typecheck.';

comment on type public.payment_provider is
  'manual = no automated provider. hashback = the only automated M-Pesa provider. '
  'daraja is RETIRED and cannot be written on new rows.';
