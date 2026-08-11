-- 170_parse_excel_serial_dates.sql
--
-- The jobs webhook sends dates as Excel serial numbers, not dates:
--
--   "jobid": "9340", "startdate": "43836", "duedate": "0"
--
-- 169's parser handled M/D/YYYY and ISO, rejected a bare integer, and
-- returned null — which is why customer_name and job_type landed on the first
-- sync while every date came back empty.
--
-- 43836 is 2020-01-06. 0 is Infusion's "no date", and is the same value the
-- report export renders as 1/0/1900 — the display form of serial zero, which
-- is what sent me looking for a date string in the first place.
--
-- Amends 169's parser only. Nothing else changes: the webhook function, the
-- columns and the import-map defaults are all untouched, and no backfill is
-- needed because the four fields overwrite on every sync, so the next one
-- fills in the dates that are currently null.
--
-- Safe to re-run.


-- Epoch is 1899-12-30, NOT 1900-01-01. Excel treats 1900 as a leap year --
-- there is a phantom 29 February 1900 in its calendar -- so every serial past
-- that phantom day is one greater than a true day count. Dating from the 30th
-- absorbs the off-by-one. Verified against three anchors:
--
--   44197 -> 2021-01-01   the standard Excel checkpoint
--   43836 -> 2020-01-06   job 9340, a completed 2020 job
--   46133 -> 2026-04-21   matches 4/21/2026 as the report export renders it
--
-- Serial 0 lands on 1899-12-30 and is caught by the <1901 guard below, so the
-- "no date" sentinel needs no special case of its own.
create or replace function public._parse_infusion_date(raw text)
returns date
language plpgsql
immutable
as $$
declare
    v date;
    t text := trim(raw);
begin
    if raw is null or length(t) = 0 then
        return null;
    end if;

    begin
        if t ~ '^\d{4}-\d{2}-\d{2}' then
            -- ISO 8601: take the date part, ignore any time/zone suffix.
            v := substring(t from 1 for 10)::date;
        elsif t ~ '^\d+(\.\d+)?$' then
            -- Excel serial. The optional fraction is a time of day; floor it
            -- away rather than rejecting the value.
            v := date '1899-12-30' + floor(t::numeric)::integer;
        else
            -- M/D/YYYY. Confirmed M/D rather than D/M by the data itself:
            -- 8/28/2026 has a day greater than 12. FM makes the leading zero
            -- optional, so 04/21/2026 works too.
            v := to_date(t, 'FMMM/FMDD/YYYY');
        end if;
    exception when others then
        -- A date we cannot read costs that one field. Raising would abort the
        -- whole payload, because the webhook upsert is a single statement.
        -- This also catches a serial large enough to overflow a date.
        return null;
    end;

    -- Catches serial 0, 1/0/1900, 1900-01-01T00:00:00 -- every rendering of
    -- "no date" this feed has produced, in one guard rather than three.
    if v < date '1901-01-01' then
        return null;
    end if;

    return v;
end$$;
