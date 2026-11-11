// R2 File Manager: Worker entry point (routing). Static files live in /public.
import { getConfig, configProblems } from "./config.js";
import { HttpError, json, readJson, safeColor, validKey, validPrefix, sanitizeName, TYPES, typeOf } from "./util.js";
import { presign } from "./sigv4.js";
import { r2, listAll, bucketUsage, r2Error } from "./r2.js";
import { verifyAccess } from "./access.js";
import { uploadInit, uploadComplete, deleteFolderBatch, contentDisposition } from "./uploads.js";
import { securityPolicy, notConfiguredPage } from "./pages.js";

// ---------------------------------------------------------------------
//  Request router
// ---------------------------------------------------------------------
async function handle(request, env) {
  const c = getConfig(env);
  const url = new URL(request.url);
  const isApi = url.pathname.startsWith("/api/");

  const problems = configProblems(c);
  if (problems.length) return isApi ? json({ error: "Not configured yet: edit the CONFIG block." }, 503) : notConfiguredPage(problems);

  if (!(await verifyAccess(request, c))) {
    return isApi ? json({ error: "Access denied." }, 403) : new Response("Access denied", { status: 403 });
  }

  if (!isApi) {
    if (request.method !== "GET" && request.method !== "HEAD") return new Response("Method not allowed", { status: 405 });
    if (!env.ASSETS) return new Response("Static assets binding missing. Check the [assets] section in wrangler.toml.", { status: 500 });
    const res = await env.ASSETS.fetch(request);
    const h = new Headers(res.headers);
    h.set("content-security-policy", securityPolicy(c));
    h.set("x-content-type-options", "nosniff");
    h.set("referrer-policy", "no-referrer");
    h.set("cache-control", "no-store");
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
  }

  if (request.method === "POST") {
    const origin = request.headers.get("Origin");
    if (origin && origin !== url.origin) throw new HttpError(403, "Cross-origin requests are not allowed.");
  }

  switch (request.method + " " + url.pathname) {
    case "GET /api/list": {
      const prefix = url.searchParams.get("prefix") ?? "";
      if (!validPrefix(prefix)) throw new HttpError(400, "Invalid folder path.");
      const r = await listAll(c, { prefix, delimiter: "/", maxPages: 20 });
      return json({ prefix, folders: r.folders, files: r.files.filter((f) => f.key !== prefix), truncated: r.truncated });
    }
    case "GET /api/config":
      return json({ title: c.SITE_TITLE, accent: safeColor(c.ACCENT, "#0d6efd"), parallel: c.PARALLEL_UPLOADS, retries: c.CHUNK_RETRIES, view: c.DEFAULT_VIEW });
    case "GET /api/usage": {
      const u = await bucketUsage(c);
      return json({ used: u.used, count: u.count, partial: u.partial, byType: u.byType });
    }
    case "GET /api/browse": {
      const type = url.searchParams.get("type") || "recent";
      if (type !== "recent" && !TYPES.includes(type)) throw new HttpError(400, "Unknown file type.");
      const u = await bucketUsage(c);
      const all = u.files.filter((f) => !f.key.endsWith("/") && (type === "recent" || typeOf(f.key) === type));
      all.sort((a, z) => (a.modified < z.modified ? 1 : a.modified > z.modified ? -1 : 0));
      const limit = type === "recent" ? 100 : 500;
      return json({ type, total: all.length, files: all.slice(0, limit), truncated: all.length > limit || u.partial });
    }
    case "POST /api/mkdir": {
      const b = await readJson(request);
      const prefix = typeof b.prefix === "string" ? b.prefix : "";
      if (!validPrefix(prefix)) throw new HttpError(400, "Invalid folder path.");
      const key = prefix + sanitizeName(b.name) + "/";
      if (!validKey(key, "folder")) throw new HttpError(400, "That folder name is not allowed.");
      const res = await r2(c, "PUT", key, { body: "" });
      if (!res.ok) throw new HttpError(502, r2Error(res));
      return json({ ok: true, key });
    }
    case "POST /api/upload/init":
      return json(await uploadInit(c, await readJson(request)));
    case "POST /api/upload/part": {
      const b = await readJson(request);
      const n = Number(b.partNumber);
      if (!validKey(b.key, "file") || typeof b.uploadId !== "string" || !b.uploadId || !Number.isInteger(n) || n < 1 || n > 10000) {
        throw new HttpError(400, "Invalid request.");
      }
      return json({ url: await presign(c, "PUT", b.key, { query: { partNumber: String(n), uploadId: b.uploadId } }) });
    }
    case "POST /api/upload/complete":
      return json(await uploadComplete(c, await readJson(request)));
    case "POST /api/upload/abort": {
      const b = await readJson(request);
      if (!validKey(b.key, "file") || typeof b.uploadId !== "string" || !b.uploadId) throw new HttpError(400, "Invalid request.");
      await r2(c, "DELETE", b.key, { query: { uploadId: b.uploadId } });
      return json({ ok: true });
    }
    case "POST /api/delete": {
      const b = await readJson(request);
      if (!validKey(b.key, "file")) throw new HttpError(400, "Invalid file.");
      const res = await r2(c, "DELETE", b.key);
      if (!res.ok && res.status !== 404) throw new HttpError(502, r2Error(res));
      return json({ ok: true });
    }
    case "POST /api/delete-folder":
      return json(await deleteFolderBatch(c, (await readJson(request)).prefix));
    case "POST /api/url": {
      const b = await readJson(request);
      if (!validKey(b.key, "file")) throw new HttpError(400, "Invalid file.");
      const u = await presign(c, "GET", b.key, { query: { "response-content-disposition": contentDisposition(b.mode, b.key) } });
      return json({ url: u, expiresIn: c.URL_EXPIRY_SECONDS });
    }
    default:
      return json({ error: "Not found." }, 404);
  }
}

export default {
  async fetch(request, env) {
    try {
      return await handle(request, env);
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      if (status >= 500) console.error("[file-manager]", e && e.stack ? e.stack : e);
      return json({ error: e instanceof HttpError ? e.message : "Unexpected server error. Check the Worker logs." }, status);
    }
  },
};
