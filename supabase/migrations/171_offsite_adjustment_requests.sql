-- 171_offsite_adjustment_requests.sql
--
-- Let employees request a time fix on their off-site spells, not just on
-- their shift clock in/out.
--
-- Today the My Clock page shows three kinds of row: Shift (from
-- clock_events), Break and Off-site job (both from status_events, via
-- list_my_offsite_spells — migration 147). Only the shift rows are
-- double-clickable, because clock_adjustment_requests.clock_event_id is a
-- NOT NULL FK to clock_events and there is nowhere to put a status_events
-- id. So a wrong break time or a missed scan-back-in has no self-service
-- route at all — it needs an admin to edit the row by hand.
--
-- This widens the SAME request table rather than building a parallel one,
-- so the reviewer's Adjustments queue stays a single list.
--
-- BREAKS RIDE ALONG. Breaks and off-site jobs are both status_events rows
-- differing only in the `status` value, so making one adjustable makes both
-- adjustable. That's a deliberate call, not an oversight — a mistimed break
-- is exactly as wrong on a timesheet as a mistimed off-site job.
--
-- Each spell has TWO adjustable times, and they are separate status_events
-- rows:
--   * the 'off_site_break' / 'off_site_job' row  -> when they LEFT  (Out)
--   * the following 'on_site' row                -> when they RETURNED (In)
-- A spell with no scan back in has no second row, so its In cell stays
-- inert — you cannot request a fix on an event that was never recorded,
-- exactly as a missing clock-out behaves today.
--
-- Safe to re-run.


--------------------------------------------------------------------------------
-- 1. The request table gains a second target
--------------------------------------------------------------------------------
-- clock_event_id becomes nullable and gains a sibling. The check keeps the
-- pair honest: exactly one target, never both, never neither — so every
-- existing row stays valid and no request can be ambiguous about what it
-- would change on approval.
alter table public.clock_adjustment_requests
    alter column clock_event_id drop not null;

alter table public.clock_adjustment_requests
    add column if not exists status_event_id bigint
        references public.status_events (id) on delete cascade;

do $$
begin
    if not exists (select 1 from pg_constraint
                    where conname = 'clock_adjustment_one_target') then
        alter table public.clock_adjustment_requests
            add constraint clock_adjustment_one_target
            check (num_nonnulls(clock_event_id, status_event_id) = 1);
    end if;
end$$;

-- Mirrors clock_adjustment_pending_uq: one open request per event at a
-- time. Nulls are distinct in a unique index, so the two indexes don't
-- interfere — a shift request has a null status_event_id and vice versa.
create unique index if not exists clock_adjustment_pending_status_uq
    on public.clock_adjustment_requests (status_event_id)
    where (status = 'pending');


--------------------------------------------------------------------------------
-- 2. list_my_offsite_spells — now returns the ids behind each time
--------------------------------------------------------------------------------
-- DROP then recreate: create or replace cannot change a function's return
-- type, and this gains four OUT columns. Dropping loses the grant, so it is
-- re-issued below.
--
-- event_type semantics carried into the UI: the start row is the "Out"
-- (left site), the return row is the "In" (came back). That matches how the
-- My Clock table already lays the two columns out for spells.
drop function if exists public.list_my_offsite_spells(timestamptz, timestamptz);

create or replace function public.list_my_offsite_spells(
    p_start    timestamptz,
    p_end_excl timestamptz
)
returns table (
    started_at              timestamptz,
    returned_at             timestamptz,
    kind                    text,   -- 'break' | 'off_site_job'
    break_name              text,
    start_event_id          bigint,
    return_event_id         bigint,
    start_pending_request_id  bigint,
    return_pending_request_id bigint
)
language plpgsql stable security definer set search_path = public
as $$
declare
    v_me public.users%rowtype;
begin
    select * into v_me from public.users where auth_user_id = auth.uid();
    if v_me.id is null then
        raise exception 'No employee record for this account';
    end if;

    return query
    select se.occurred_at as started_at,
           -- Closed by the next scan-back-in, unless a clock-out landed
           -- first (clocked out while off site / auto-close) — then the
           -- spell has no return and the row shows In as "—".
           case when nr.on_at is not null and (nr.out_at is null or nr.on_at <= nr.out_at)
                then nr.on_at end as returned_at,
           case when se.status = 'off_site_break' then 'break'
                else 'off_site_job' end as kind,
           b.name as break_name,
           se.id as start_event_id,
           -- Same condition as returned_at above: the id is only offered
           -- when that on_site row is genuinely THIS spell's return. A
           -- clock-out that beat it means the spell never closed, and the
           -- unrelated later on_site row must not become adjustable here.
           case when nr.on_at is not null and (nr.out_at is null or nr.on_at <= nr.out_at)
                then nr.on_id end as return_event_id,
           spr.id as start_pending_request_id,
           case when nr.on_at is not null and (nr.out_at is null or nr.on_at <= nr.out_at)
                then rpr.id end as return_pending_request_id
      from public.status_events se
      left join public.breaks b on b.id = se.break_id
      left join lateral (
          select n.occurred_at as on_at,
                 n.id          as on_id,
                 (select min(c2.occurred_at) from public.clock_events c2
                   where c2.user_id = se.user_id
                     and c2.event_type = 'out'
                     and c2.occurred_at > se.occurred_at) as out_at
            from public.status_events n
           where n.user_id = se.user_id
             and n.status = 'on_site'
             and n.occurred_at > se.occurred_at
           order by n.occurred_at
           limit 1
      ) nr on true
      left join lateral (
          select r.id from public.clock_adjustment_requests r
           where r.status_event_id = se.id and r.status = 'pending'
           limit 1
      ) spr on true
      left join lateral (
          select r.id from public.clock_adjustment_requests r
           where r.status_event_id = nr.on_id and r.status = 'pending'
           limit 1
      ) rpr on true
     where se.user_id = v_me.id
       and se.status in ('off_site_break', 'off_site_job')
       and se.occurred_at >= p_start
       and se.occurred_at <  p_end_excl
     order by se.occurred_at;
end$$;

grant execute on function public.list_my_offsite_spells(timestamptz, timestamptz) to authenticated;


--------------------------------------------------------------------------------
-- 3. submit_offsite_adjustment — a SEPARATE function, deliberately
--------------------------------------------------------------------------------
-- NOT a fourth defaulted parameter on submit_clock_adjustment. That would
-- create an overload rather than a replacement: the 3-arg version would
-- survive, and PostgREST's named-parameter dispatch could no longer pick
-- between them — which would break the shift-adjustment flow that is
-- already live, the moment this migration is applied.
--
-- Same guards as submit_clock_adjustment: must be your own event, must
-- differ from the recorded time, must stay within 24h, one pending request
-- at a time.
create or replace function public.submit_offsite_adjustment(
    p_status_event_id bigint,
    p_requested_time  timestamptz,
    p_reason          text default null
)
returns bigint
language plpgsql security definer set search_path = public
as $$
declare
    v_me public.users%rowtype;
    v_ev public.status_events%rowtype;
    v_id bigint;
begin
    select * into v_me from public.users where auth_user_id = auth.uid();
    if v_me.id is null then
        raise exception 'No employee record for this account';
    end if;

    select * into v_ev from public.status_events
     where id = p_status_event_id and user_id = v_me.id;
    if v_ev.id is null then
        raise exception 'Status event not found';
    end if;
    -- Only the three statuses the My Clock page actually renders. Bars the
    -- caller from filing against 'clocked_out_early' or 'off_site_personal'
    -- rows, which have no cell in the UI and no defined adjust semantics.
    if v_ev.status not in ('off_site_break', 'off_site_job', 'on_site') then
        raise exception 'That event type cannot be adjusted';
    end if;

    if p_requested_time is null then
        raise exception 'Requested time is required';
    end if;
    if p_requested_time = v_ev.occurred_at then
        raise exception 'Requested time is the same as the recorded time';
    end if;
    if abs(extract(epoch from (p_requested_time - v_ev.occurred_at))) > 86400 then
        raise exception 'Requested time must be within 24 hours of the recorded time';
    end if;
    if exists (select 1 from public.clock_adjustment_requests r
                where r.status_event_id = p_status_event_id and r.status = 'pending') then
        raise exception 'There is already a pending request for this event';
    end if;

    insert into public.clock_adjustment_requests
        (organisation_id, user_id, status_event_id, event_type,
         original_time, requested_time, reason)
    values
        (v_ev.organisation_id, v_me.id, p_status_event_id,
         -- Leaving site reads as an Out, scanning back in as an In, so the
         -- reviewer's existing In/Out column needs no new vocabulary.
         case when v_ev.status = 'on_site' then 'in' else 'out' end,
         v_ev.occurred_at, p_requested_time,
         nullif(trim(coalesce(p_reason, '')), ''))
    returning id into v_id;

    return v_id;
end$$;

grant execute on function public.submit_offsite_adjustment(bigint, timestamptz, text) to authenticated;


--------------------------------------------------------------------------------
-- 4. list_clock_adjustment_requests — tell the reviewer what kind it is
--------------------------------------------------------------------------------
-- Gains status_event_id and target_kind, so DROP and recreate again.
--
-- target_kind is DERIVED at read time from the joined status_events row
-- rather than snapshotted onto the request. The other columns here are
-- snapshots because the underlying time can move after the request is
-- filed; a break can't turn into an off-site job, so there is nothing to
-- protect against.
drop function if exists public.list_clock_adjustment_requests(bigint, text);

create or replace function public.list_clock_adjustment_requests(
    p_org_id bigint,
    p_status text default null
)
returns table (
    id              bigint,
    user_id         bigint,
    employee_name   text,
    department_name text,
    clock_event_id  bigint,
    status_event_id bigint,
    target_kind     text,   -- 'clock' | 'break' | 'off_site_job'
    event_type      text,
    original_time   timestamptz,
    requested_time  timestamptz,
    reason          text,
    status          text,
    review_note     text,
    reviewed_at     timestamptz,
    created_at      timestamptz
)
language plpgsql stable security definer set search_path = public
as $$
declare
    v_caller public.users%rowtype;
    v_all    boolean := false;
begin
    if public.is_admin_of(p_org_id) or public.is_developer() then
        v_all := true;
    else
        select * into v_caller from public.users
         where auth_user_id = auth.uid() and organisation_id = p_org_id;
        if v_caller.id is null or not v_caller.can_view_clock_comparison then
            raise exception 'Not authorised to review clock adjustments';
        end if;
        if coalesce(v_caller.clock_view_scope, 'all') = 'all' then
            v_all := true;
        end if;
    end if;

    return query
    select r.id, r.user_id, u.name, d.name,
           r.clock_event_id, r.status_event_id,
           case
             when r.status_event_id is null then 'clock'
             when se.status = 'off_site_break' then 'break'
             when se.status = 'off_site_job'   then 'off_site_job'
             -- An 'on_site' row is the RETURN from a spell, so the kind
             -- comes from the spell it closes, not from the row itself.
             else coalesce(
               (select case when p.status = 'off_site_break' then 'break'
                            else 'off_site_job' end
                  from public.status_events p
                 where p.user_id = se.user_id
                   and p.status in ('off_site_break', 'off_site_job')
                   and p.occurred_at < se.occurred_at
                 order by p.occurred_at desc
                 limit 1),
               'off_site_job')
           end as target_kind,
           r.event_type, r.original_time,
           r.requested_time, r.reason, r.status,
           r.review_note, r.reviewed_at, r.created_at
      from public.clock_adjustment_requests r
      join public.users u on u.id = r.user_id
      left join public.departments d on d.id = u.department_id
      left join public.status_events se on se.id = r.status_event_id
     where r.organisation_id = p_org_id
       and (p_status is null or r.status = p_status)
       and (v_all or u.department_id in
             (select dd.id from public.departments dd
               where dd.organisation_id = p_org_id
                 and dd.manager_id = v_caller.id))
     order by r.created_at;
end$$;

grant execute on function public.list_clock_adjustment_requests(bigint, text) to authenticated;


--------------------------------------------------------------------------------
-- 5. review_clock_adjustment — apply to whichever table the request targets
--------------------------------------------------------------------------------
-- Same signature, so create or replace is fine here and the grant survives.
-- Permission logic is untouched, carried forward from 146 verbatim; the
-- only change is the branch that writes the fix.
--
-- status_events has no auto_closed column — that flag only exists on
-- clock_events, where it records an auto-clock-out. Nothing to clear on
-- the status branch.
create or replace function public.review_clock_adjustment(
    p_request_id bigint,
    p_approve    boolean,
    p_note       text default null
)
returns void
language plpgsql security definer set search_path = public
as $$
declare
    v_req     public.clock_adjustment_requests%rowtype;
    v_target  public.users%rowtype;
    v_caller  public.users%rowtype;
    v_allowed boolean := false;
begin
    select * into v_req from public.clock_adjustment_requests
     where id = p_request_id
     for update;
    if v_req.id is null then
        raise exception 'Request not found';
    end if;
    if v_req.status <> 'pending' then
        raise exception 'Request has already been reviewed';
    end if;

    select * into v_target from public.users where id = v_req.user_id;

    if public.is_admin_of(v_req.organisation_id) or public.is_developer() then
        v_allowed := true;
    else
        select * into v_caller from public.users
         where auth_user_id = auth.uid()
           and organisation_id = v_req.organisation_id;
        if v_caller.id is not null and v_caller.can_view_clock_comparison then
            if coalesce(v_caller.clock_view_scope, 'all') = 'all' then
                v_allowed := true;
            else
                v_allowed := exists (
                    select 1 from public.departments d
                     where d.organisation_id = v_req.organisation_id
                       and d.manager_id = v_caller.id
                       and d.id = v_target.department_id);
            end if;
        end if;
    end if;
    if not v_allowed then
        raise exception 'Not authorised to review this request';
    end if;

    if p_approve then
        if v_req.clock_event_id is not null then
            update public.clock_events
               set occurred_at = v_req.requested_time,
                   auto_closed = false
             where id = v_req.clock_event_id;
            if not found then
                raise exception 'The clock event no longer exists';
            end if;
        else
            update public.status_events
               set occurred_at = v_req.requested_time
             where id = v_req.status_event_id;
            if not found then
                raise exception 'The status event no longer exists';
            end if;
        end if;
    end if;

    update public.clock_adjustment_requests
       set status      = case when p_approve then 'approved' else 'declined' end,
           reviewed_by = (select u.id from public.users u
                           where u.auth_user_id = auth.uid()
                             and u.organisation_id = v_req.organisation_id),
           review_note = nullif(trim(coalesce(p_note, '')), ''),
           reviewed_at = now()
     where id = p_request_id;
end$$;

grant execute on function public.review_clock_adjustment(bigint, boolean, text) to authenticated;


--------------------------------------------------------------------------------
-- 6. Deliberately NOT done here
--------------------------------------------------------------------------------
-- No ordering guard. Approving a return time earlier than its own start
-- would produce a negative spell, and nothing here stops that. The existing
-- shift flow has the same gap — a reviewer can already approve a clock-in
-- later than its clock-out — so this matches precedent rather than
-- half-fixing one side. The 24h bound is the only sanity check on both.
-- If that becomes a real problem it wants one guard covering both kinds,
-- not a special case bolted onto this migration.
