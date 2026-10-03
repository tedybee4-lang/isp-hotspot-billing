-- =============================================================================
--  ISPFlow - RADIUS uniqueness constraints required by the queries.
--
--  Two constraints that the authentication and accounting SQL depends on, and
--  which were described in the design but never actually created. Every failure
--  below is silent: the server starts, the queries run, and the isolation or the
--  idempotency guarantee is simply absent.
--
--  1. radius_nas.nas_identifier must be UNIQUE
--
--     The tenant model resolves the router FIRST and looks the subscriber up
--     second, scoped by the tenant that came back:
--
--         FROM radius_nas nas
--         JOIN service_accounts sa ON sa.isp_id = nas.isp_id
--         WHERE nas.nas_identifier = '%{Called-Station-Id}'
--
--     That is only single-valued if at most one radius_nas row can carry a given
--     nas_identifier. The table shipped with only:
--
--         CHECK (nas_identifier ~ '^[A-Za-z0-9._-]{1,64}$')
--
--     which constrains the SHAPE of the value, not its uniqueness. With two rows
--     sharing an identifier - which nothing prevented - the join returns rows from
--     both tenants, and a subscriber named "john" on tenant A could authenticate
--     on tenant B's router whenever tenant B also registered a "john". The whole
--     point of the NAS-first design is defeated by a duplicate row.
--
--     Also note the comments throughout the RADIUS configuration claimed this
--     was already unique ("radius_nas.nas_identifier is unique so the tenant is
--     single-valued"). It was not. The claim is what made the gap invisible.
--
--  2. radius_sessions.acct_session_id must be UNIQUE
--
--     The session-open and accounting statements use:
--
--         ON CONFLICT (acct_session_id) DO UPDATE
--
--     to make a re-sent Acct-Start idempotent, so a router that re-sends Start on
--     a link flap updates one row instead of creating a second session and
--     double-counting the customer's time. Without a unique constraint that
--     clause fails outright at runtime:
--
--         there is no unique or exclusion constraint matching the ON CONFLICT
--         specification
--
--     A nullable unique column still permits many NULLs in PostgreSQL, so rows
--     that never received a session id are unaffected.
--
--  Both tables were empty when this ran, so no existing row needed de-duplication
--  and no data was merged or deleted.
-- =============================================================================

-- 1. The router -> tenant trust anchor must be single-valued.
CREATE UNIQUE INDEX IF NOT EXISTS radius_nas_nas_identifier_uniq
    ON public.radius_nas (nas_identifier);

-- 2. Session identity, so a repeated Acct-Start cannot double-count.
CREATE UNIQUE INDEX IF NOT EXISTS radius_sessions_acct_session_id_uniq
    ON public.radius_sessions (acct_session_id)
    WHERE acct_session_id IS NOT NULL;
