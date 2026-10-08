create table if not exists public.router_autoconfig_commands (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.provisioning_sessions(id) on delete cascade,
  isp_id uuid not null references public.isps(id) on delete cascade,
  node_id uuid not null references public.nodes(id) on delete cascade,
  command text not null check (command = 'hotspot-bootstrap'),
  status text not null default 'pending'
    check (status in ('pending', 'complete', 'failed', 'blocked')),
  plan jsonb not null,
  attempts integer not null default 0 check (attempts >= 0),
  authentication_ready boolean,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  unique (session_id, command)
);

create index if not exists router_autoconfig_commands_node_status_idx
  on public.router_autoconfig_commands (node_id, status);

alter table public.router_autoconfig_commands enable row level security;
alter table public.router_autoconfig_commands force row level security;

drop policy if exists router_autoconfig_commands_read
  on public.router_autoconfig_commands;
create policy router_autoconfig_commands_read
  on public.router_autoconfig_commands for select
  using (public.is_super_admin() or isp_id = public.current_isp_id());

comment on table public.router_autoconfig_commands is
  'Audited, idempotent router-pull commands. Scripts are generated server-side '
  'from validated read-only surveys and are never accepted from browsers.';
