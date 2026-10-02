-- =============================================================================
--  Router lifecycle states (additive enum extension)
--
--  `node_state` only ever had online/offline/maintenance, which cannot express
--  why a router is unreachable. The platform needs to tell an ISP the truth:
--  a router behind CGNAT is not the same fault as one with a bad password.
--
--  PostgreSQL cannot use a value added by ALTER TYPE inside the same
--  transaction that added it, so this file exists on its own: the management
--  API runs each file as a separate transaction, and the next migration
--  (20260101000900) is the first to write any of these values.
--
--  No existing row is rewritten. online/offline/maintenance keep their
--  meaning, so older code and older dashboards continue to work.
-- =============================================================================

alter type public.node_state add value if not exists 'provisioning';
alter type public.node_state add value if not exists 'degraded';
alter type public.node_state add value if not exists 'unreachable';
alter type public.node_state add value if not exists 'auth_failed';
alter type public.node_state add value if not exists 'config_error';
alter type public.node_state add value if not exists 'provisioning_failed';
alter type public.node_state add value if not exists 'disabled';