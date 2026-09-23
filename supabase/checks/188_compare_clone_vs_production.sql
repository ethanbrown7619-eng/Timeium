-- 188_compare_clone_vs_production.sql
-- Run in BOTH projects' SQL editors (Tokyo clone = kyfydyownbgwhquorchn,
-- production = swpxduxnjimsxtfpyxur) right after both have received the SAME
-- Infusion sync, and compare the rows: every fingerprint should be identical.
--
-- Tokyo has Timeium 188 (feeds write only rows that changed); production does
-- not yet. Identical fingerprints mean 188 stores exactly what the old code
-- stores. Only the CONTENT the feeds write is compared - ids, created_at,
-- updated_at, last_synced_at, last_seen_at, first_seen_at and sync_token are
-- left out on purpose (they legitimately differ between the two databases, and
-- 188 changes when last_synced_at moves). Read-only.
select 'jobs' as what, count(*) as rows,
       md5(string_agg(concat_ws('|', job_code, description, status, customer_name,
                                start_date, due_date, job_type, source), E'\n' order by job_code)) as fingerprint
  from public.jobs
union all
select 'quotes', count(*),
       md5(string_agg(concat_ws('|', quote_no, title, debtor_name, job_code, status, raw_status,
                                quote_date, rep_code, line_count, total_value), E'\n' order by quote_no))
  from public.quotes
union all
select 'quote_lines', count(*),
       md5(string_agg(concat_ws('|', quote_no, line_no, description, qty, rate, extended),
                      E'\n' order by quote_no, line_no))
  from public.quote_lines
union all
select 'invoices', count(*),
       md5(string_agg(concat_ws('|', invoice_no, invoice_date, status, raw_status, job_code,
                                quote_total, invoice_total), E'\n' order by invoice_no))
  from public.invoices
order by 1;
