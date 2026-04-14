# sync-infusion-projects

Pulls active projects from Infusion and upserts them into `public.projects`,
one organisation at a time, via the `upsert_projects_from_infusion` RPC.

## Invocation modes

| Body | Behaviour |
|---|---|
| `{}` (or empty) | Fan-out: fetches once from Infusion and upserts into **every active organisation**. |
| `{ "org_id": 42 }` | Targeted: fetches from Infusion and upserts into org 42 only. |
| `{ "org_id": 42, "projects": [ … ] }` | Test-mode: skips the Infusion fetch and upserts the given array into org 42 directly. Useful for local development. |

The function runs as the `service_role`, which `resolve_org_id()` treats as a
developer — so passing `p_org_id` explicitly is always allowed.

## Deploy

```bash
supabase functions deploy sync-infusion-projects \
  --project-ref kyfydyownbgwhquorchn

supabase secrets set \
  INFUSION_API_URL=https://api.infusion.example/v1/projects \
  INFUSION_API_KEY=xxx \
  --project-ref kyfydyownbgwhquorchn
```

`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are injected by Supabase
automatically.

## Schedule

In **Supabase → Database → Cron Jobs**, add:

```
*/30 * * * *
select net.http_post(
  url := 'https://kyfydyownbgwhquorchn.supabase.co/functions/v1/sync-infusion-projects',
  headers := jsonb_build_object(
    'Authorization', 'Bearer ' || current_setting('app.settings.service_role_key', true),
    'Content-Type',  'application/json'
  ),
  body := '{}'::jsonb
);
```

## Mapping

`index.ts` contains a defensive mapper (`jobNumber` or `job_number`, etc.) for
Infusion's real field names. Confirm the real payload shape and tighten the
mapper once you have a sample response.
