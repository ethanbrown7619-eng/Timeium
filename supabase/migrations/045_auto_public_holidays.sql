-- 045_auto_public_holidays.sql
-- Auto-generate NZ public holidays with correct Mondayisation.
-- Handles: fixed holidays, Mondayisation of singles and pairs,
-- Easter (algorithmic), King's Birthday (1st Mon June),
-- Labour Day (4th Mon Oct), Matariki (gazetted through 2052).
--
-- Safe to re-run.

-- Store the country on the org for future multi-country support
alter table public.organisations
    add column if not exists country text not null default 'NZ';

--------------------------------------------------------------------------------
-- generate_nz_public_holidays(p_year)
-- Returns all NZ public holidays for a given year with Mondayisation applied.
--------------------------------------------------------------------------------

create or replace function public.generate_nz_public_holidays(p_year int)
returns table(holiday_date date, name text)
language plpgsql stable set search_path = public
as $$
declare
    -- Easter calculation variables
    v_a int; v_b int; v_c int; v_d int; v_e int; v_f int;
    v_g int; v_h int; v_i int; v_k int; v_l int; v_m int;
    v_month int; v_day int;
    v_easter date;
    -- Mondayisation temps
    v_d1 date; v_d2 date; v_dow1 int;
    v_obs1 date; v_obs2 date;
    -- Matariki lookup
    v_matariki date;
begin
    -- === Easter (Anonymous Gregorian algorithm) ===
    v_a := p_year % 19;
    v_b := p_year / 100;
    v_c := p_year % 100;
    v_d := v_b / 4;
    v_e := v_b % 4;
    v_f := (v_b + 8) / 25;
    v_g := (v_b - v_f + 1) / 3;
    v_h := (19 * v_a + v_b - v_d - v_g + 15) % 30;
    v_i := v_c / 4;
    v_k := v_c % 4;
    v_l := (32 + 2 * v_e + 2 * v_i - v_h - v_k) % 7;
    v_m := (v_a + 11 * v_h + 22 * v_l) / 451;
    v_month := (v_h + v_l - 7 * v_m + 114) / 31;
    v_day := ((v_h + v_l - 7 * v_m + 114) % 31) + 1;
    v_easter := make_date(p_year, v_month, v_day);

    -- Good Friday & Easter Monday (no Mondayisation needed — always Fri/Mon)
    holiday_date := v_easter - 2;  name := 'Good Friday';           return next;
    holiday_date := v_easter + 1;  name := 'Easter Monday';         return next;

    -- === New Year pair (Mondayise as pair) ===
    v_d1 := make_date(p_year, 1, 1);
    v_d2 := make_date(p_year, 1, 2);
    v_dow1 := extract(isodow from v_d1)::int;  -- 1=Mon..7=Sun
    if v_dow1 = 6 then       -- Sat: d1→Mon, d2→Tue
        v_obs1 := v_d1 + 2;  v_obs2 := v_d2 + 2;
    elsif v_dow1 = 7 then    -- Sun: d1→Mon, d2→Tue
        v_obs1 := v_d1 + 1;  v_obs2 := v_d2 + 1;
    elsif v_dow1 = 5 then    -- Fri: d1 stays, d2(Sat)→Mon
        v_obs1 := v_d1;      v_obs2 := v_d2 + 2;
    else
        v_obs1 := v_d1;      v_obs2 := v_d2;
    end if;
    holiday_date := v_obs1;  name := 'New Year''s Day';          return next;
    holiday_date := v_obs2;  name := 'Day after New Year''s Day'; return next;

    -- === Waitangi Day (single Mondayisation) ===
    v_d1 := make_date(p_year, 2, 6);
    v_dow1 := extract(isodow from v_d1)::int;
    if v_dow1 = 6 then v_d1 := v_d1 + 2;
    elsif v_dow1 = 7 then v_d1 := v_d1 + 1; end if;
    holiday_date := v_d1;  name := 'Waitangi Day';               return next;

    -- === ANZAC Day (single Mondayisation) ===
    v_d1 := make_date(p_year, 4, 25);
    v_dow1 := extract(isodow from v_d1)::int;
    if v_dow1 = 6 then v_d1 := v_d1 + 2;
    elsif v_dow1 = 7 then v_d1 := v_d1 + 1; end if;
    holiday_date := v_d1;  name := 'ANZAC Day';                  return next;

    -- === King's Birthday (1st Monday in June) ===
    v_d1 := make_date(p_year, 6, 1);
    v_dow1 := extract(isodow from v_d1)::int;
    if v_dow1 > 1 then v_d1 := v_d1 + (8 - v_dow1); end if;
    holiday_date := v_d1;  name := 'King''s Birthday';           return next;

    -- === Matariki (gazetted dates) ===
    v_matariki := case p_year
        when 2022 then date '2022-06-24'
        when 2023 then date '2023-07-14'
        when 2024 then date '2024-06-28'
        when 2025 then date '2025-06-20'
        when 2026 then date '2026-07-10'
        when 2027 then date '2027-06-25'
        when 2028 then date '2028-07-14'
        when 2029 then date '2029-07-06'
        when 2030 then date '2030-06-21'
        when 2031 then date '2031-07-11'
        when 2032 then date '2032-07-02'
        when 2033 then date '2033-06-24'
        when 2034 then date '2034-07-07'
        when 2035 then date '2035-06-29'
        when 2036 then date '2036-07-18'
        when 2037 then date '2037-07-10'
        when 2038 then date '2038-06-25'
        when 2039 then date '2039-07-15'
        when 2040 then date '2040-07-06'
        when 2041 then date '2041-07-19'
        when 2042 then date '2042-07-11'
        when 2043 then date '2043-07-03'
        when 2044 then date '2044-06-24'
        when 2045 then date '2045-07-07'
        when 2046 then date '2046-06-29'
        when 2047 then date '2047-07-19'
        when 2048 then date '2048-07-03'
        when 2049 then date '2049-06-25'
        when 2050 then date '2050-07-15'
        when 2051 then date '2051-06-30'
        when 2052 then date '2052-06-21'
        else null
    end;
    if v_matariki is not null then
        holiday_date := v_matariki;  name := 'Matariki';  return next;
    end if;

    -- === Labour Day (4th Monday in October) ===
    v_d1 := make_date(p_year, 10, 1);
    v_dow1 := extract(isodow from v_d1)::int;
    if v_dow1 > 1 then v_d1 := v_d1 + (8 - v_dow1); end if;
    v_d1 := v_d1 + 21;  -- 4th Monday
    holiday_date := v_d1;  name := 'Labour Day';                 return next;

    -- === Christmas pair (Mondayise as pair) ===
    v_d1 := make_date(p_year, 12, 25);
    v_d2 := make_date(p_year, 12, 26);
    v_dow1 := extract(isodow from v_d1)::int;
    if v_dow1 = 6 then       -- Sat: d1→Mon, d2→Tue
        v_obs1 := v_d1 + 2;  v_obs2 := v_d2 + 2;
    elsif v_dow1 = 7 then    -- Sun: d1→Mon, d2→Tue
        v_obs1 := v_d1 + 1;  v_obs2 := v_d2 + 1;
    elsif v_dow1 = 5 then    -- Fri: d1 stays, d2(Sat)→Mon
        v_obs1 := v_d1;      v_obs2 := v_d2 + 2;
    else
        v_obs1 := v_d1;      v_obs2 := v_d2;
    end if;
    holiday_date := v_obs1;  name := 'Christmas Day';            return next;
    holiday_date := v_obs2;  name := 'Boxing Day';               return next;
end;
$$;

grant execute on function public.generate_nz_public_holidays(int) to authenticated;

--------------------------------------------------------------------------------
-- seed_public_holidays_for_year(p_org_id, p_year)
-- Populates the public_holidays table for one org+year from the generator.
-- Idempotent via ON CONFLICT.
--------------------------------------------------------------------------------

create or replace function public.seed_public_holidays_for_year(
    p_org_id bigint,
    p_year   int
)
returns int
language plpgsql security definer set search_path = public
as $$
declare
    v_count int := 0;
begin
    insert into public.public_holidays (organisation_id, holiday_date, name)
    select p_org_id, h.holiday_date, h.name
      from public.generate_nz_public_holidays(p_year) h
    on conflict (organisation_id, holiday_date) do nothing;

    get diagnostics v_count = row_count;
    return v_count;
end;
$$;

grant execute on function public.seed_public_holidays_for_year(bigint, int) to authenticated;
