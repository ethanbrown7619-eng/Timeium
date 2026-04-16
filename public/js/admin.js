// Temporium admin page — placeholder for future admin-only surfaces (tasks,
// holidays, timesheet reports). Departments + staff management moved to
// /staff.html.

import { getSupabase } from "/js/supabase-client.js";
import { notice, renderTopbar, requireAdmin } from "/js/shared.js";

const sb = await getSupabase();
const ctx = await requireAdmin(sb);
let currentOrgId = ctx.currentOrgId;

renderTopbar({
  session: ctx.session,
  isDeveloper: ctx.isDeveloper,
  adminRow: ctx.adminRow,
  orgs: ctx.orgs,
  currentOrgId,
  onOrgChange: (id) => {
    currentOrgId = id;
    localStorage.setItem("temporium-dev-org-id", String(id));
  },
  active: "admin",
});

if (!currentOrgId) {
  notice(
    "No organisation on this account — contact a developer.",
    "error",
    { sticky: true }
  );
}
