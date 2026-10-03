-- =============================================================================
--  Reclaim jobs stranded in 'processing' by a worker that died.
--
--  Found by running the queue, not by reading it.
--
--  claim_router_jobs() only ever selected
--
--      where j.status in ('pending','retrying')
--
--  but claiming is what SETS status to 'processing'. So the moment a worker was
--  handed a job, that job stopped matching the claim predicate and could never be
--  handed out again. The lease expiry that the same function's comment relies on
--  - "if a worker dies mid-job the lease expires and another worker picks the job
--  up on a later pass, so a crash cannot strand work forever" - could not fire,
--  because a crashed worker leaves its job in 'processing', not in 'retrying'.
--
--  Measured on production by expiring a live lease and re-claiming:
--
--      locked_until = <60s in the past>   status = processing
--      second claim returns 0 jobs
--
--  The job is then invisible to every worker, forever. Nothing recovers it: no
--  transition moves 'processing' back to a runnable state, because only
--  fail_router_job() writes a terminal status and only the worker that owned the
--  job ever calls it. A worker killed by an OOM, a deploy, or a reboot drops work
--  on the floor permanently, and a provisioning job for a customer silently
--  never runs.
--
--  The fix: a row left 'processing' past its lease is claimable again, because
--  the lease is the only evidence that a worker was holding it and the lease has
--  expired. Live leases are still excluded by the existing locked_until test, so
--  two workers still cannot hold one job.
--
--  No attempt cap is applied here. Reclaiming an exhausted job lets it run and
--  fail, and fail_router_job() then moves it to 'dead' on its own, which both
--  terminates the loop and surfaces it to an operator. Adding a cap here would
--  instead leave the row 'processing' and therefore still stranded.
--
--  The status/lease predicate is unchanged for every other state, so this cannot
--  cause a job to run twice: 'succeeded', 'failed', 'dead' and 'retrying' rows
--  with a live or absent lease are excluded exactly as before.
-- =============================================================================

begin;

create or replace function public.claim_router_jobs(
  p_worker     text,
  p_limit      integer default 5,
  p_lease_secs integer default 120,
  p_kinds      text[] default null
) returns setof public.router_jobs
  language plpgsql
  security definer
  set search_path = public
as $$
begin
  if p_worker is null or length(p_worker) < 2 then
    raise exception 'worker name is required';
  end if;

  return query
  with picked as (
    select j.id
      from public.router_jobs j
     where (
             -- Work that has not been handed out, or that a previous attempt
             -- released for another try.
             (j.status in ('pending', 'retrying') and j.next_run_at <= now())
             -- Work whose holder died before it could release it. The lease is
             -- the only record that anyone held this row, and it has expired.
          or (j.status = 'processing' and j.locked_until is not null
              and j.locked_until < now())
           )
       and (j.locked_until is null or j.locked_until < now())
       and (p_kinds is null or j.kind = any (p_kinds))
     order by j.priority asc, j.next_run_at asc, j.created_at asc
     limit greatest(1, least(coalesce(p_limit, 5), 100))
     for update skip locked
  )
  update public.router_jobs j
     set status         = 'processing',
         locked_by      = p_worker,
         locked_until   = now() + make_interval(secs => greatest(p_lease_secs, 10)),
         attempt_count  = j.attempt_count + 1,
         started_at     = case when j.attempt_count = 0 then now() else j.started_at end,
         updated_at     = now()
    from picked
   where j.id = picked.id
  returning j.*;
end;
$$;

comment on function public.claim_router_jobs(text, integer, integer, text[]) is
  'Claims a batch of jobs under a lease, and reclaims rows left in ''processing'''
    ' by a worker that died before it could release them. A live lease is never '
    'stolen, so two workers cannot hold one job.';

commit;