-- 147_my_offsite_spells.sql
-- Companion to 146: the My Clock page now shows a full day timeline —
-- shift in/out plus break / off-site-job spells — so employees can see
-- exactly what the kiosk recorded for them.
--
-- Breaks and off-site jobs live in status_events (an 'off_site_break' /
-- 'off_site_job' row when they leave, closed by the next 'on_site' row
-- when they scan back in), not in clock_events. status_events RLS is
-- admin-only, so employees read their own spells via this SECURITY
-- DEFINER RPC — it only ever returns the caller's rows.
--
-- returned_at is null when the spell wasn't closed by a scan back in
-- (still out right now, or the day ended with a clock-out / auto-close).
--
-- Safe to re-run.

create or replace function public.list_my_offsite_spells(
    p_start    timestamptz,
    p_end_excl timestamptz
)
returns table (
    started_at  timestamptz,
    returned_at timestamptz,
    kind        text,   -- 'break' | 'off_site_job'
    break_name  text
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
           b.name as break_name
      from public.status_events se
      left join public.breaks b on b.id = se.break_id
      left join lateral (
          select (select min(s2.occurred_at) from public.status_events s2
                   where s2.user_id = se.user_id
                     and s2.status = 'on_site'
                     and s2.occurred_at > se.occurred_at) as on_at,
                 (select min(c2.occurred_at) from public.clock_events c2
                   where c2.user_id = se.user_id
                     and c2.event_type = 'out'
                     and c2.occurred_at > se.occurred_at) as out_at
      ) nr on true
     where se.user_id = v_me.id
       and se.status in ('off_site_break', 'off_site_job')
       and se.occurred_at >= p_start
       and se.occurred_at <  p_end_excl
     order by se.occurred_at;
end$$;

grant execute on function public.list_my_offsite_spells(timestamptz, timestamptz) to authenticated;
