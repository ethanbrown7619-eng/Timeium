# sync-infusion-projects

Pulls projects from Infusion every ~30 minutes and upserts into `public.projects`
via the `upsert_projects_from_infusion` RPC.

## Deploy

```bash
supabase functions deploy sync-infusion-projects --project-ref kyfydyownbgwhquorchn
supabase secrets set \
  INFUSION_API_URL=https://api.infusion.example/v1/projects \
  INFUSION_API_KEY=xxx \
  --project-ref kyfydyownbgwhquorchn
```

`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are injected by Supabase
automatically.

## Schedule

In the Supabase dashboard → Database → Cron Jobs, add:

```
*/30 * * * *
select net.http_post(
  url := 'https://kyfydyownbgwhquorchn.supabase.co/functions/v1/sync-infusion-projects',
  headers := jsonb_build_object(
    'Authorization', 'Bearer ' || current_setting('app.settings.service_role_key', true)
  )
);
```

## Mapping

`index.ts` contains a defensive mapper (`jobNumber` or `job_number`, etc.) for
Infusion's real field names. Adjust the mapper once the real Infusion payload
shape is confirmed.
