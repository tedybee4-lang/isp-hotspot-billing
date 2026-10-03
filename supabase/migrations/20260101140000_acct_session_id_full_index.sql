-- =============================================================================
--  Full unique index on radius_sessions.acct_session_id.
--
--  The accounting statement uses:
--
--      ON CONFLICT (acct_session_id) DO UPDATE SET ...
--
--  so that a repeated Acct-Start folds into one row instead of creating a second
--  session and double-counting the customer's time.
--
--  PostgreSQL's ON CONFLICT can only infer a FULL unique index. It cannot match
--  a PARTIAL one, and the only index on this column was partial:
--
--      CREATE UNIQUE INDEX radius_sessions_acct_session_id_uniq
--          ON public.radius_sessions (acct_session_id)
--          WHERE acct_session_id IS NOT NULL
--
--  The result was that the insert path worked - a session row was created - and
--  every Interim-Update and Stop failed to update it. Observed live:
--
--      acct_session_id  = RADIUSTEST-sess-1
--      input_octets     = NULL
--      session_time_secs= NULL
--      terminate_cause  = NULL
--      ended_at         = NULL
--
--  after Start, Interim-Update and Stop had all been accepted with valid
--  response authenticators. Billing reads those columns, so every session would
--  have been recorded as zero bytes and never closed.
--
--  NULLs do not collide in a unique index anyway - PostgreSQL permits any number
--  of rows where the indexed column is NULL - so the partial predicate bought
--  nothing and cost the ON CONFLICT clause entirely.
--
--  The partial index is replaced, not added alongside, so there is one obvious
--  constraint and no chance of a second deployment picking the wrong one.
-- =============================================================================

create unique index if not exists radius_sessions_acct_session_id_uniq_full
    on public.radius_sessions (acct_session_id);

drop index if exists public.radius_sessions_acct_session_id_uniq;

comment on index public.radius_sessions_acct_session_id_uniq_full is
  'Session identity for accounting idempotency. Must be a FULL unique index: '
  'ON CONFLICT (acct_session_id) cannot infer a partial one. NULLs do not '
  'collide here, so no predicate is needed.';
