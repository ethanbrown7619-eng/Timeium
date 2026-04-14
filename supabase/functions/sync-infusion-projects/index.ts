// Supabase Edge Function: sync-infusion-projects
//
// Pulls the active projects list from Infusion and upserts into public.projects
// via the upsert_projects_from_infusion RPC. Runs on a schedule (every ~30 min)
// and is also manually-invocable from the admin UI.
//
// Required secrets (configure in Supabase dashboard → Edge Functions):
//   INFUSION_API_URL        e.g. https://api.infusion.example/v1/projects
//   INFUSION_API_KEY        bearer token
//   SUPABASE_URL            auto-populated by the Supabase runtime
//   SUPABASE_SERVICE_ROLE_KEY   used to satisfy is_admin() via the service role
//
// Because the RPC is SECURITY DEFINER and gated by is_admin(), we call Supabase
// using the service_role key. The service_role bypasses RLS and is treated as
// an admin for is_admin() checks via the session's JWT claims.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

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

Deno.serve(async (req: Request) => {
  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const infusionUrl = Deno.env.get("INFUSION_API_URL");
    const infusionKey = Deno.env.get("INFUSION_API_KEY");

    if (!infusionUrl || !infusionKey) {
      return new Response(
        JSON.stringify({
          ok: false,
          error:
            "INFUSION_API_URL / INFUSION_API_KEY not configured. See README in this folder.",
        }),
        { status: 500, headers: { "content-type": "application/json" } }
      );
    }

    // 1. Pull from Infusion.
    const res = await fetch(infusionUrl, {
      headers: { Authorization: `Bearer ${infusionKey}`, Accept: "application/json" },
    });
    if (!res.ok) {
      throw new Error(`Infusion responded ${res.status}: ${await res.text()}`);
    }
    const rawProjects = await res.json();

    // 2. Normalise. The real Infusion schema may differ — adjust this mapper.
    const projects: InfusionProject[] = (Array.isArray(rawProjects) ? rawProjects : rawProjects.projects || [])
      .map((p: Record<string, unknown>) => ({
        job_number: String(p.jobNumber ?? p.job_number ?? ""),
        project_number: String(p.projectNumber ?? p.project_number ?? ""),
        job_description: (p.jobDescription ?? p.job_description ?? null) as string | null,
        job_status: (p.jobStatus ?? p.job_status ?? null) as string | null,
        project_description: (p.projectDescription ?? p.project_description ?? null) as string | null,
        project_status: (p.projectStatus ?? p.project_status ?? null) as string | null,
        client_name: (p.clientName ?? p.client_name ?? null) as string | null,
        active: (p.active ?? (p.jobStatus !== "Closed" && p.jobStatus !== "Completed")) as boolean,
      }))
      .filter((p: InfusionProject) => p.job_number && p.project_number);

    // 3. Upsert.
    const sb = createClient(supabaseUrl, serviceKey);
    const { data, error } = await sb.rpc("upsert_projects_from_infusion", {
      p_projects: projects,
    });
    if (error) throw error;

    return new Response(JSON.stringify({ ok: true, count: data, total: projects.length }), {
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
