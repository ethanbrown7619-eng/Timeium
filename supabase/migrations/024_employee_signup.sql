-- 024_employee_signup.sql
-- Temporium employee self-signup support.
--
-- When a new employee signs up to Temporium with their work email, this RPC
-- links their Supabase auth user to their pre-existing public.users row
-- (created by the admin). No-op if already linked. Returns a jsonb envelope
-- so the front-end can branch on claimed/unclaimed without parsing an
-- exception message.

create or replace function public.claim_employee_by_email()
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
    v_auth_email text;
    v_existing   public.users;
    v_candidate  public.users;
begin
    -- Short-circuit: already linked.
    select * into v_existing
    from public.users
    where auth_user_id = auth.uid()
    limit 1;

    if v_existing.id is not null then
        return jsonb_build_object(
            'claimed',         true,
            'already_linked',  true,
            'user_id',         v_existing.id,
            'organisation_id', v_existing.organisation_id,
            'name',            v_existing.name
        );
    end if;

    -- Look up the auth user's email.
    select email into v_auth_email from auth.users where id = auth.uid();
    if v_auth_email is null then
        raise exception 'Not signed in';
    end if;

    -- Find a matching unclaimed employee row (case-insensitive).
    select * into v_candidate
    from public.users
    where auth_user_id is null
      and email is not null
      and lower(email) = lower(v_auth_email)
    limit 1;

    if v_candidate.id is null then
        return jsonb_build_object(
            'claimed', false,
            'reason',  'no_match',
            'email',   v_auth_email
        );
    end if;

    update public.users
        set auth_user_id = auth.uid()
        where id = v_candidate.id;

    return jsonb_build_object(
        'claimed',         true,
        'already_linked',  false,
        'user_id',         v_candidate.id,
        'organisation_id', v_candidate.organisation_id,
        'name',            v_candidate.name
    );
end$$;

grant execute on function public.claim_employee_by_email() to authenticated;
