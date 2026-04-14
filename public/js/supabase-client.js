// Supabase client bootstrap.
// Loads supabase-js from jsDelivr (no build step) and reads Supabase URL/anon
// key from /config.json (served by the Cloudflare Worker).

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

let _client = null;
let _config = null;

export async function getConfig() {
  if (_config) return _config;
  const res = await fetch("/config.json", { cache: "no-store" });
  if (!res.ok) throw new Error("Failed to load /config.json");
  _config = await res.json();
  if (!_config.supabaseUrl || !_config.supabaseAnonKey) {
    throw new Error(
      "Supabase config missing. Set SUPABASE_URL and SUPABASE_ANON_KEY in wrangler.toml."
    );
  }
  return _config;
}

export async function getSupabase() {
  if (_client) return _client;
  const cfg = await getConfig();
  _client = createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
    },
  });
  return _client;
}
