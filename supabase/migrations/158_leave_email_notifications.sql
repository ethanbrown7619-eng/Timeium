-- 158_leave_email_notifications.sql
-- Per-request email notifications for the leave workflow.
--
-- Model: a trigger on leave_requests derives an event kind from each
-- INSERT / status transition and appends a row to a queue table. The
-- send-timesheet-notifications edge function (already cron'd every 15
-- minutes) drains the queue for orgs with notify_leave enabled — one
-- email per event, no digests. Emails honour the org's debug redirect
-- (org_secrets.debug_redirect_email), so the whole flow can be tested
-- with every message rerouted to one inbox.
--
-- Event kinds and who the edge function emails:
--   submitted         employee raised a request      -> department manager (fallback: admins)
--   on_behalf         manager raised it on behalf    -> the employee (must accept)
--   accepted          employee accepted on-behalf    -> whoever requested it
--   declined          employee declined on-behalf    -> whoever requested it
--   approved          manager approved               -> the employee
--   rejected          manager rejected               -> the employee
--   cancelled         employee cancelled a pending   -> department manager (fallback: admins)
--   revoked           approved leave pulled back     -> the employee
--   change_requested  cancel/amend asked on approved -> department manager (fallback: admins)
--
-- The FUTURE-DATES rule (only email about leave starting today or later)
-- is enforced at send time in the edge function, not here — the queue
-- keeps the row and marks it "skipped: past start date" so there's an
-- audit trail of suppressed events.
--
-- Nothing is enqueued while notify_leave is off, so switching the
-- feature on later doesn't flush a backlog of stale events.
--
-- Safe to re-run.

--------------------------------------------------------------------------------
-- Org toggle
--------------------------------------------------------------------------------

alter table public.organisations
    add column if not exists notify_leave boolean not null default false;

-- Dedicated setter rather than widening save_org_settings — that function's
-- live definition has drifted across migrations and recreating it from a
-- repo snapshot risks clobbering columns (see the record_scan incident).
create or replace function public.set_leave_notifications(
    p_org_id  bigint,
    p_enabled boolean
)
returns void
language plpgsql security definer set search_path = public
as $$
begin
    if not public.is_admin_of(p_org_id) then
        raise exception 'Not an admin of this organisation';
    end if;
    update public.organisations
       set notify_leave = coalesce(p_enabled, false)
     where id = p_org_id;
end;
$$;

grant execute on function public.set_leave_notifications(bigint, boolean) to authenticated;

--------------------------------------------------------------------------------
-- Queue table — written by the trigger, read/updated only by the edge
-- function's service role. RLS on with no policies = invisible to clients.
--------------------------------------------------------------------------------

create table if not exists public.leave_notification_queue (
    id               bigserial primary key,
    organisation_id  bigint not null references public.organisations (id) on delete cascade,
    leave_request_id bigint not null references public.leave_requests (id) on delete cascade,
    kind             text   not null check (kind in
        ('submitted','on_behalf','accepted','declined','approved',
         'rejected','cancelled','revoked','change_requested')),
    actor_auth_uid   uuid,
    attempts         integer not null default 0,
    created_at       timestamptz not null default now(),
    sent_at          timestamptz,
    result           text
);

alter table public.leave_notification_queue enable row level security;
revoke all on public.leave_notification_queue from anon, authenticated;

create index if not exists leave_notification_queue_unsent_idx
    on public.leave_notification_queue (organisation_id)
    where sent_at is null;

--------------------------------------------------------------------------------
-- Trigger — derive the event kind from the transition
--------------------------------------------------------------------------------

create or replace function public._queue_leave_notification()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
    v_enabled  boolean;
    v_kind     text;
    v_emp_auth uuid;
begin
    select o.notify_leave into v_enabled
      from public.organisations o where o.id = new.organisation_id;
    if not coalesce(v_enabled, false) then
        return new;
    end if;

    if tg_op = 'INSERT' then
        v_kind := case new.status
                    when 'pending_manager'  then 'submitted'
                    when 'pending_admin'    then 'submitted'   -- legacy status
                    when 'pending_employee' then 'on_behalf'
                    else null
                  end;
    else
        if new.status is distinct from old.status then
            if new.status = 'approved' then
                v_kind := case when old.status = 'pending_employee'
                               then 'accepted' else 'approved' end;
            elsif new.status = 'rejected' then
                v_kind := 'rejected';
            elsif new.status = 'cancelled' then
                if old.status = 'pending_employee' then
                    -- Employee declining tells the requester; the requester
                    -- withdrawing their own on-behalf request emails nobody
                    -- (they did it themselves from the edit dialog).
                    select u.auth_user_id into v_emp_auth
                      from public.users u where u.id = new.user_id;
                    if v_emp_auth is not null and v_emp_auth = auth.uid() then
                        v_kind := 'declined';
                    end if;
                elsif old.status = 'approved' then
                    v_kind := 'revoked';
                else
                    v_kind := 'cancelled';
                end if;
            end if;
        elsif new.change_request_type is not null
              and old.change_request_type is null then
            v_kind := 'change_requested';
        end if;
    end if;

    if v_kind is null then
        return new;
    end if;

    insert into public.leave_notification_queue
        (organisation_id, leave_request_id, kind, actor_auth_uid)
    values
        (new.organisation_id, new.id, v_kind, auth.uid());

    return new;
end;
$$;

drop trigger if exists trg_queue_leave_notification on public.leave_requests;
create trigger trg_queue_leave_notification
    after insert or update on public.leave_requests
    for each row execute function public._queue_leave_notification();
