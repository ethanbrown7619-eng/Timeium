// Supabase Edge Function: sync-infusion-projects
//
// Pulls the active projects list from Infusion and upserts into public.projects
// via the upsert_projects_from_infusion RPC — scoped per organisation.
//
// The function supports two invocation modes:
//   1. POST {} (no body)           — fan out: sync every active org
//   2. POST { "org_id": 42 }       — targeted: sync one org only
//   3. POST { "org_id": 42,        — in-band seed (mostly for local dev / testing):
//             "projects": [...] }    skip the Infusion fetch and upsert directly.
//
// Runs as the service_role so it satisfies is_developer() inside resolve_org_id,
// which lets it pass p_org_id explicitly.
//
// Required secrets (Supabase dashboard → Edge Functions):
//   INFUSION_API_URL             e.g. https://api.infusion.example/v1/projects
//   INFUSION_API_KEY             bearer token
//   SUPABASE_URL                 auto-populated
//   SUPABASE_SERVICE_ROLE_KEY    auto-populated

import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

interface InfusionProject {
  job_number: string;
  project_number: string;
  job_description?: string | null;
  job_status?: string | null;
  project_description?: string | null;
  project_status?: string | null;
  client_name?: string | null;
  active?: boolean;
}

interface InvocationBody {
  org_id?: number;
  projects?: InfusionProject[];
}

function normaliseInfusionPayload(raw: unknown): InfusionProject[] {
  const arr = Array.isArray(raw)
    ? raw
    : Array.isArray((raw as { projects?: unknown[] })?.projects)
      ? (raw as { projects: unknown[] }).projects
      : [];
  return (arr as Array<Record<string, unknown>>)
    .map((p) => ({
      job_number:           String(p.jobNumber           ?? p.job_number           ?? ""),
      project_number:       String(p.projectNumber       ?? p.project_number       ?? ""),
      job_description:      (p.jobDescription            ?? p.job_description      ?? null) as string | null,
      job_status:           (p.jobStatus                 ?? p.job_status           ?? null) as string | null,
      project_description:  (p.projectDescription        ?? p.project_description  ?? null) as string | null,
      project_status:       (p.projectStatus             ?? p.project_status       ?? null) as string | null,
      client_name:          (p.clientName                ?? p.client_name          ?? null) as string | null,
      active:
        (p.active as boolean | undefined) ??
        (p.jobStatus !== "Closed" && p.jobStatus !== "Completed"),
    }))
    .filter((p) => p.job_number && p.project_number);
}

async function fetchFromInfusion(): Promise<InfusionProject[]> {
  const url = Deno.env.get("INFUSION_API_URL");
  const key = Deno.env.get("INFUSION_API_KEY");
  if (!url || !key) {
    throw new Error(
      "INFUSION_API_URL / INFUSION_API_KEY not configured. See README.md in this folder."
    );
  }
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(`Infusion responded ${res.status}: ${await res.text()}`);
  }
  return normaliseInfusionPayload(await res.json());
}

async function syncOrg(
  sb: SupabaseClient,
  orgId: number,
  projects: InfusionProject[]
): Promise<number> {
  const { data, error } = await sb.rpc("upsert_projects_from_infusion", {
    p_org_id: orgId,
    p_projects: projects,
  });
  if (error) throw error;
  return Number(data) || 0;
}

Deno.serve(async (req: Request) => {
  try {
    const sb = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const body: InvocationBody = req.body ? await req.json().catch(() => ({})) : {};
    const results: Array<{ organisation_id: number; count: number }> = [];

    if (body.org_id && body.projects) {
      // Test-mode: skip Infusion, seed directly.
      const count = await syncOrg(sb, body.org_id, body.projects);
      results.push({ organisation_id: body.org_id, count });
    } else {
      // Pull once from Infusion, reuse for all target orgs.
      const projects = await fetchFromInfusion();

      let targetOrgIds: number[];
      if (body.org_id) {
        targetOrgIds = [body.org_id];
      } else {
        const { data: orgs, error } = await sb
          .from("organisations")
          .select("id")
          .eq("active", true)
          .order("id");
        if (error) throw error;
        targetOrgIds = (orgs || []).map((o) => o.id);
      }

      for (const orgId of targetOrgIds) {
        const count = await syncOrg(sb, orgId, projects);
        results.push({ organisation_id: orgId, count });
      }
    }

    return new Response(JSON.stringify({ ok: true, results }), {
      headers: { "content-type": "application/json" },
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return new Response(JSON.stringify({ ok: false, error: message }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  }
});
