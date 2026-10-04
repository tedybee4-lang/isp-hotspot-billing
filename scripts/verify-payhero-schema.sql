-- Verification query: confirms every PayHero structure exists in production.
-- Read-only. Returns a single row of counts.
select
  (select count(*)::int from pg_type
     where typname = 'payment_provider'
       and 'payhero' = any(enum_range(null::payment_provider)))          as enum_value_ok,
  (select count(*)::int from information_schema.columns
     where table_name = 'platform_payment_config'
       and column_name = 'payhero_api_token_ciphertext')                 as platform_cipher_col,
  (select count(*)::int from information_schema.columns
     where table_name = 'platform_payment_config'
       and column_name = 'payhero_channels')                             as platform_channels_col,
  (select count(*)::int from information_schema.columns
     where table_name = 'isp_payment_configs'
       and column_name = 'payhero_channel_id')                           as tenant_channel_col,
  (select count(*)::int from information_schema.indexes
     where indexname = 'isp_payment_configs_payhero_channel_uniq')       as unique_index_ok,
  (select count(*)::int from pg_proc
     where proname = 'create_payhero_payment')                           as create_rpc,
  (select count(*)::int from pg_proc
     where proname = 'settle_payhero_payment')                           as settle_rpc,
  (select count(*)::int from pg_proc
     where proname = 'record_payhero_stk')                                as stk_rpc,
  (select count(*)::int from pg_proc
     where proname = 'assign_payhero_channel')                            as assign_rpc;