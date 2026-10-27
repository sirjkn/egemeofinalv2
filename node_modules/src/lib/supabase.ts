import { createClient } from "@supabase/supabase-js";
import { projectId, publicAnonKey } from "../../utils/supabase/info";
import { pgClient, PG_MODE_KEY } from "./pg-client";

// Real Supabase client
const supabaseClient = createClient(
  `https://${projectId}.supabase.co`,
  publicAnonKey,
);

// Return the correct client based on the active database mode.
// In "cpanel" mode every supabase.from()/rpc()/auth/storage call is
// transparently routed to the Node.js server proxy instead.
function getClient() {
  if (typeof localStorage !== "undefined" && localStorage.getItem(PG_MODE_KEY) === "cpanel") {
    return pgClient as any;
  }
  return supabaseClient;
}

// Proxy object — delegates every property access to the current client at call time.
// This means the mode can be switched at runtime without refreshing the page.
export const supabase = new Proxy({} as typeof supabaseClient, {
  get(_target, prop) {
    return (getClient() as any)[prop];
  },
});
