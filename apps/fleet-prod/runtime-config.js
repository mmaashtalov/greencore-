// This file is deployment input, not a credential store.
// Replace both placeholders during deployment. Supabase publishable keys are intentionally client-visible.
window.__FLEET_PROD_CONFIG__ = Object.freeze({
  supabaseUrl: '__SUPABASE_URL__',
  publishableKey: '__SUPABASE_PUBLISHABLE_KEY__'
});
