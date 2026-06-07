// Route the landing page based on auth state.
import { getSupabase } from "/js/supabase-client.js";
import { routeAfterAuth } from "/js/shared.js";

const sb = await getSupabase();
const { data: { session } } = await sb.auth.getSession();
if (!session) {
  location.replace("/signin.html");
} else {
  await routeAfterAuth(sb);
}
