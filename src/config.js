// =====================================================================
//  R2 FILE MANAGER: configuration
//  Keep real secrets OUT of git: set them in the dashboard under
//  Settings > Variables and Secrets (they override these values).
// =====================================================================

// ---------------------------------------------------------------------
//  CONFIG: the ONLY place you need to edit.
//  Each value is read as  env.NAME ?? CONFIG.NAME , so a Worker secret or
//  variable with the same name (Settings > Variables and Secrets)
//  overrides what you paste here. Dashboard values for numbers must be
//  plain numbers (e.g. 8589934592), not expressions like 8 * 1024 ** 3.
// ---------------------------------------------------------------------
const CONFIG = {
  // ---- R2 credentials (used server-side only, never sent to the browser)
  ACCESS_KEY_ID: "PASTE_YOUR_ACCESS_KEY_ID",         // R2 API token: Access Key ID
  SECRET_ACCESS_KEY: "PASTE_YOUR_SECRET_ACCESS_KEY", // R2 API token: Secret Access Key
  ACCOUNT_ID: "PASTE_YOUR_ACCOUNT_ID",               // Cloudflare account ID (R2 overview page)
  ENDPOINT: "https://<ACCOUNT_ID>.r2.cloudflarestorage.com", // S3 endpoint; <ACCOUNT_ID> is filled in automatically
  BUCKET: "fast",                                    // R2 bucket name
  REGION: "auto",                                    // leave as "auto" for R2

  // ---- Upload behaviour
  CHUNK_SIZE: 50 * 1024 ** 2,       // multipart chunk size in bytes (min 5 MiB; raised automatically for huge files)
  PARALLEL_UPLOADS: 4,              // chunks uploaded at the same time per file
  CHUNK_RETRIES: 3,                 // tries per chunk before the upload fails
  URL_EXPIRY_SECONDS: 3600,         // lifetime of presigned upload/download URLs (max 604800)

  // ---- Look and feel
  SITE_TITLE: "My Files",           // shown in the header and browser tab
  ACCENT: "#0d6efd",                // accent colour (hex): buttons, links, highlights
  DEFAULT_VIEW: "list",             // "list" (table) or "grid" (cards); the visitor's choice is remembered

  // ---- Optional extra protection (leave empty to skip)
  ACCESS_TEAM_DOMAIN: "",           // e.g. "myteam.cloudflareaccess.com"; verifies the Access login token too
  ACCESS_AUD: "",                   // the Application Audience (AUD) tag of your Access application
};

// ---------------------------------------------------------------------
//  Config loading
// ---------------------------------------------------------------------
const NUM_KEYS = ["CHUNK_SIZE", "PARALLEL_UPLOADS", "CHUNK_RETRIES", "URL_EXPIRY_SECONDS"];

function getConfig(env) {
  const c = {};
  for (const k of Object.keys(CONFIG)) {
    const e = env && env[k];
    // env.NAME ?? CONFIG.NAME (ignoring non-text bindings that happen to share a name)
    const v = typeof e === "string" || typeof e === "number" ? e : CONFIG[k];
    c[k] = typeof CONFIG[k] === "number" ? Number(v) : String(v).trim();
  }
  c.ENDPOINT = c.ENDPOINT.replace("<ACCOUNT_ID>", c.ACCOUNT_ID).replace(/\/+$/, "");
  c.CHUNK_SIZE = Math.max(5 * 1024 ** 2, c.CHUNK_SIZE);
  c.PARALLEL_UPLOADS = Math.min(16, Math.max(1, Math.floor(c.PARALLEL_UPLOADS)));
  c.CHUNK_RETRIES = Math.min(10, Math.max(1, Math.floor(c.CHUNK_RETRIES)));
  c.URL_EXPIRY_SECONDS = Math.min(604800, Math.max(60, Math.floor(c.URL_EXPIRY_SECONDS)));
  c.DEFAULT_VIEW = c.DEFAULT_VIEW === "list" ? "list" : "grid";
  return c;
}

function configProblems(c) {
  const p = [];
  const placeholder = (v) => !v || /^PASTE_/i.test(v) || v.includes("<ACCOUNT_ID>");
  if (placeholder(c.ACCESS_KEY_ID)) p.push("ACCESS_KEY_ID is still the placeholder");
  if (placeholder(c.SECRET_ACCESS_KEY)) p.push("SECRET_ACCESS_KEY is still the placeholder");
  if (placeholder(c.ACCOUNT_ID)) p.push("ACCOUNT_ID is still the placeholder");
  if (!c.BUCKET) p.push("BUCKET is empty");
  if (!/^https:\/\/[^/\s]+$/.test(c.ENDPOINT)) p.push("ENDPOINT must look like https://YOUR_ACCOUNT_ID.r2.cloudflarestorage.com");
  for (const k of NUM_KEYS) if (!Number.isFinite(c[k]) || c[k] <= 0) p.push(k + " must be a positive number");
  return p;
}


export { CONFIG, getConfig, configProblems };
