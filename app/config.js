// Fill these in once the Supabase project exists (Project -> Settings -> API).
// SUPABASE_ANON_KEY is safe to keep here: it's the public, read-only key, and
// db/schema.sql locks it to SELECT only, no writes, via row-level security.
// Never put the service_role key from that same page in this file or anywhere
// in the app, it's the one key that must stay private.
window.TALA_CONFIG = {
  SUPABASE_URL: "",       // e.g. "https://xxxxxxxxxxxx.supabase.co"
  SUPABASE_ANON_KEY: "",  // the "anon public" key, not "service_role"
};
