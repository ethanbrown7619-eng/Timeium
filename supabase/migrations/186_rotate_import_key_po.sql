-- ============================================================================
-- 186_rotate_import_key_po.sql — rotate_import_key gains the 'po' kind.
--
-- The outstanding-orders (purchase-order lines) feed moved off its Cloudflare
-- Worker onto a plain RPC keyed by org_secrets.po_webhook_key (ptl-purchase-
-- orders migration 098, 2026-09-16) — the same pattern as jobs / tasks / dept
-- codes / invoices / quotes. 098 adds the column and mints the first key; this
-- migration lets an admin ROTATE it the way the other five are rotated.
--
-- Body carried forward from 178 (the live version) with one extra branch; same
-- signature, so grants survive. Apply order does not matter relative to 098:
-- the column is created here too (`add column if not exists`) so this never
-- fails on an org where 098 has not landed yet.
--
-- Safe to re-run.
-- ============================================================================

alter table public.org_secrets
    add column if not exists po_webhook_key text;

create unique index if not exists org_secrets_po_webhook_idx
    on public.org_secrets (po_webhook_key) where po_webhook_key is not null;

create or replace function public.rotate_import_key(p_kind text, p_org_id bigint default null)
returns text language plpgsql security definer set search_path = public as $function$
declare v_org bigint; v_key text;
begin
    v_org := public.resolve_org_id(p_org_id);
    if not public.is_admin_of(v_org) then raise exception 'not an admin of organisation %', v_org; end if;
    v_key := replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
    insert into public.org_secrets (organisation_id) values (v_org) on conflict (organisation_id) do nothing;
    if p_kind = 'jobs' then update public.org_secrets set jobs_webhook_key = v_key, updated_at = now() where organisation_id = v_org;
    elsif p_kind = 'tasks' then update public.org_secrets set tasks_webhook_key = v_key, updated_at = now() where organisation_id = v_org;
    elsif p_kind = 'dept_codes' then update public.org_secrets set dept_codes_webhook_key = v_key, updated_at = now() where organisation_id = v_org;
    elsif p_kind = 'invoices' then update public.org_secrets set invoices_webhook_key = v_key, updated_at = now() where organisation_id = v_org;
    elsif p_kind = 'quotes' then update public.org_secrets set quotes_webhook_key = v_key, updated_at = now() where organisation_id = v_org;
    elsif p_kind = 'po' then update public.org_secrets set po_webhook_key = v_key, updated_at = now() where organisation_id = v_org;
    else raise exception 'unknown kind: %, expected jobs, tasks, dept_codes, invoices, quotes, or po', p_kind;
    end if;
    return v_key;
end$function$;

-- Footer check: the branch exists.
select proname, pg_get_function_arguments(oid) as args,
       position('po_webhook_key' in prosrc) > 0 as has_po_branch
  from pg_proc where proname = 'rotate_import_key';
