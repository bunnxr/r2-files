// R2 File Manager: Worker entry point (routing). Static files live in /public.
import { getConfig, configProblems } from "./config.js";
import { HttpError, json, readJson, safeColor, validKey, validPrefix, sanitizeName, TYPES, typeOf, isInternal, logEvent } from "./util.js";
import { store, bucketUsage, extraDrives } from "./storage/index.js";
import { verifyAccess } from "./access.js";
import { uploadInit, uploadComplete, partTarget, uploadData, uploadAbort, deleteFolderBatch, contentDisposition } from "./uploads.js";
import { securityPolicy, notConfiguredPage } from "./pages.js";
import { servePublic, shareUrl, proxyRead } from "./public.js";
import { createLink, linkInfo, removeLink, listLinks, updateLink, deleteLink, addLink, sweepExpired } from "./links.js";
import { readNotes, setNote, dropNotes } from "./notes.js";
import * as ops from "./fileops.js";
import { fetchToR2 } from "./urlfetch.js";
import { readAuth, saveAuth, rotateIfDue } from "./upauth.js";
import { INTERNAL_HOST, handleInternal } from "./internal.js";
import { PREFIX as CLI_PREFIX, serveScript, handleCli } from "./cli.js";

// ---------------------------------------------------------------------
//  Request router
// ---------------------------------------------------------------------
async function handle(request, env, ctx) {
  const c = getConfig(env);
  const url = new URL(request.url);
  const isApi = url.pathname.startsWith("/api/");

  const host = url.hostname.toLowerCase();

  // The installer host comes first: it only ever serves the two scripts from
  // /public/install, needs no R2 and no login, so it answers even while the
  // CONFIG block is still incomplete.
  if (c.UPLOAD_HOST && host === c.UPLOAD_HOST) return serveScript(request, env, url, c);

  const isPublicHost = !!c.PUBLIC_HOST && host === c.PUBLIC_HOST;
  // LINK_HOST (bunnxr.com) is routed to the shortener Worker, never to this one; requests for it only
  // arrive here through the shortener's service binding, for names the shortener does not have.
  const isLinkHost = !!c.PUBLIC_HOST && !!c.LINK_HOST && c.LINK_HOST !== c.PUBLIC_HOST && host === c.LINK_HOST;
  const problems = configProblems(c);
  if (problems.length) {
    if (isPublicHost || isLinkHost) return new Response("Not configured yet.", { status: 503 });
    return isApi ? json({ error: "Not configured yet: edit the CONFIG block." }, 503) : notConfiguredPage(problems);
  }
  // The public hostname only ever serves files (public folders and signed share links): no UI, no API, no login
  // Tab icon for shared files: browsers ask the domain for /favicon.ico when they show a PDF,
  // video or image directly, so links on bunnxr.com and r2.bunnxr.com show the drive's logo.
  if ((isPublicHost || isLinkHost) && url.pathname === "/favicon.ico" && env.ASSETS) {
    const res = await env.ASSETS.fetch(new Request(url.origin + "/favicon.ico"));
    if (res.ok) return new Response(res.body, { headers: { "content-type": "image/x-icon", "cache-control": "public, max-age=86400" } });
  }
  if (isPublicHost) return servePublic(request, c, url, { ctx });
  if (isLinkHost) return servePublic(request, c, url, { shortOnly: true, ctx }); // bunnxr.com: short links only, no public folders
  // The shortener's "R2 files" folder, through its service binding (see src/internal.js)
  if (host === INTERNAL_HOST) return handleInternal(request, c, url);

  // Terminal routes: protected by the upload password instead of Access
  // (Access has a bypass policy for /cli/*), so they run before verifyAccess.
  if (url.pathname.startsWith(CLI_PREFIX)) return handleCli(request, env, c, ctx, url);

  if (!(await verifyAccess(request, c))) {
    return isApi ? json({ error: "Access denied." }, 403) : new Response("Access denied", { status: 403 });
  }

  if (!isApi) {
    if (request.method !== "GET" && request.method !== "HEAD") return new Response("Method not allowed", { status: 405 });
    if (url.pathname === "/manifest.webmanifest") {
      const icon = (src, sizes, extra) => Object.assign({ src, sizes, type: "image/png" }, extra);
      return new Response(JSON.stringify({ name: c.SITE_TITLE, short_name: c.SITE_TITLE.slice(0, 12), start_url: "/", scope: "/", display: "standalone", background_color: "#fbf8f3", theme_color: safeColor(c.ACCENT, "#0f766e"), icons: [icon("/icon-192.png", "192x192"), icon("/icon-512.png", "512x512"), icon("/icon-maskable-512.png", "512x512", { purpose: "maskable" })] }), { headers: { "content-type": "application/manifest+json", "cache-control": "no-store" } });
    }
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

  // Paths in every route below may be in R2 or on Zenith ("zenith:/…"): src/storage/index.js decides.
  switch (request.method + " " + url.pathname) {
    case "GET /api/list": {
      const prefix = url.searchParams.get("prefix") ?? "";
      if (!validPrefix(prefix) || isInternal(prefix)) throw new HttpError(400, "Invalid folder path.");
      const r = await store(c).list({ prefix, delimiter: "/", maxPages: 20 });
      return json({ prefix, folders: r.folders.filter((f) => f !== ".trash/" && !isInternal(f)), files: r.files.filter((f) => f.key !== prefix && !isInternal(f.key)), truncated: r.truncated });
    }
    case "GET /api/config":
      return json({ title: c.SITE_TITLE, accent: safeColor(c.ACCENT, "#0f766e"), parallel: c.PARALLEL_UPLOADS, retries: c.CHUNK_RETRIES, view: c.DEFAULT_VIEW, publicHost: c.PUBLIC_HOST, linkHost: c.LINK_HOST || c.PUBLIC_HOST, publicFolders: c.PUBLIC_FOLDER_LIST, trashDays: c.TRASH_DAYS, drives: extraDrives(c) });
    case "GET /api/usage": {
      const u = await bucketUsage(c);
      return json({ used: u.used, count: u.count, partial: u.partial, byType: u.byType });
    }
    case "GET /api/browse": {
      const type = url.searchParams.get("type") || "recent";
      if (type !== "recent" && !TYPES.includes(type)) throw new HttpError(400, "Unknown file type.");
      const u = await bucketUsage(c);
      const all = u.files.filter((f) => !f.key.endsWith("/") && (type === "recent" ? typeOf(f.key) !== "trash" : typeOf(f.key) === type) && !isInternal(f.key));
      all.sort((a, z) => (a.modified < z.modified ? 1 : a.modified > z.modified ? -1 : 0));
      const limit = type === "recent" ? 100 : 500;
      return json({ type, total: all.length, files: all.slice(0, limit), truncated: all.length > limit || u.partial });
    }
    case "POST /api/mkdir": {
      const b = await readJson(request);
      const prefix = typeof b.prefix === "string" ? b.prefix : "";
      if (!validPrefix(prefix) || isInternal(prefix)) throw new HttpError(400, "Invalid folder path.");
      const key = prefix + sanitizeName(b.name) + "/";
      if (!validKey(key, "folder")) throw new HttpError(400, "That folder name is not allowed.");
      await store(c).mkdir(key);
      return json({ ok: true, key });
    }
    case "POST /api/upload/init":
      return json(await uploadInit(c, await readJson(request)));
    case "POST /api/upload/part":
      return json(await partTarget(c, await readJson(request), "/api/upload/data"));
    case "PUT /api/upload/data": // a chunk for Zenith, sent to the signed URL from /api/upload/part
      return uploadData(c, request, url);
    case "POST /api/upload/complete": {
      const b = await readJson(request);
      try {
        const r = await uploadComplete(c, b);
        logEvent("upload.complete", { key: r.key, size: Number(b.size) || null, via: "web" });
        return json(r);
      } catch (e) {
        logEvent("upload.error", { key: typeof b.key === "string" ? b.key : "", via: "web", error: String(e && e.message ? e.message : e) });
        throw e;
      }
    }
    case "POST /api/upload/abort":
      return json(await uploadAbort(c, await readJson(request)));
    case "POST /api/delete": {
      const b = await readJson(request);
      if (!validKey(b.key, "file") || isInternal(b.key)) throw new HttpError(400, "Invalid file.");
      await store(c).remove(b.key);
      await dropNotes(c, [b.key]);
      return json({ ok: true });
    }
    case "POST /api/delete-folder": // permanent; used for folders on Zenith, which has no trash
      return json(await deleteFolderBatch(c, (await readJson(request)).prefix));
    case "POST /api/url": {
      const b = await readJson(request);
      if (!validKey(b.key, "file") || isInternal(b.key)) throw new HttpError(400, "Invalid file.");
      const u = await store(c).openUrl(b.key, b.mode, contentDisposition(b.mode, b.key));
      return json({ url: u, expiresIn: c.URL_EXPIRY_SECONDS });
    }
    case "POST /api/share": {
      const b = await readJson(request);
      const seconds = Math.floor(Number(b.seconds));
      if (!validKey(b.key, "file") || b.key.startsWith(".trash/") || isInternal(b.key)) throw new HttpError(400, "Invalid file.");
      if (!(seconds >= 60 && seconds <= 604800)) throw new HttpError(400, "Links can last between 1 minute and 7 days.");
      return json(await shareUrl(c, b.key, seconds));
    }
    case "GET /api/read": {
      const key = url.searchParams.get("key");
      if (!validKey(key, "file") || isInternal(key)) throw new HttpError(400, "Invalid file.");
      return proxyRead(c, request, key, url);
    }
    case "POST /api/link": {
      const b = await readJson(request);
      const seconds = Math.floor(Number(b.seconds));
      if (!validKey(b.key, "file") || b.key.startsWith(".trash/") || isInternal(b.key)) throw new HttpError(400, "Invalid file.");
      if (!(seconds === 0 || (seconds >= 60 && seconds <= 604800))) throw new HttpError(400, "Choose a link length of up to 7 days, or never.");
      return json(await createLink(c, b.key, seconds, typeof b.mode === "string" ? b.mode : ""));
    }
    case "POST /api/link-info": {
      const b = await readJson(request);
      if (!validKey(b.key, "file") || isInternal(b.key)) throw new HttpError(400, "Invalid file.");
      return json(c.PUBLIC_HOST ? await linkInfo(c, b.key) : { exists: false });
    }
    case "POST /api/link-remove": {
      const b = await readJson(request);
      if (!validKey(b.key, "file") || isInternal(b.key)) throw new HttpError(400, "Invalid file.");
      return json(await removeLink(c, b.key));
    }
    case "GET /api/links":
      return json(c.PUBLIC_HOST ? await listLinks(c, url.searchParams.get("after") || "") : { links: [], next: "", off: true });
    case "POST /api/link-update":
      return json(await updateLink(c, await readJson(request)));
    case "POST /api/link-add":
      return json(await addLink(c, await readJson(request)));
    case "POST /api/link-delete":
      return json(await deleteLink(c, (await readJson(request)).name));
    case "GET /api/notes":
      return json({ notes: await readNotes(c) });
    case "POST /api/note": {
      const b = await readJson(request);
      if (!validKey(b.key, "file") || isInternal(b.key)) throw new HttpError(400, "Invalid file.");
      return json(await setNote(c, b.key, b.text));
    }
    case "POST /api/new-text":
      return json(await ops.newText(c, await readJson(request)));
    case "GET /api/largest": {
      const u = await bucketUsage(c);
      const files = u.files.filter((f) => !f.key.endsWith("/") && !isInternal(f.key)).sort((a, z) => z.size - a.size).slice(0, 25).map((f) => ({ key: f.key, size: f.size, modified: f.modified }));
      return json({ files, partial: u.partial });
    }
    case "POST /api/move":
      return json(await ops.moveBatch(c, await readJson(request)));
    // Move or copy one file between R2 and Zenith: start, then parts (several at once), then finish
    case "POST /api/xfer":
      return json(await ops.xferStart(c, await readJson(request)));
    case "POST /api/xfer/part":
      return json(await ops.xferPart(c, await readJson(request)));
    case "POST /api/xfer/finish":
      return json(await ops.xferFinish(c, await readJson(request)));
    case "POST /api/trash":
      return json(await ops.trashBatch(c, await readJson(request)));
    case "POST /api/trash-folder":
      return json(await ops.trashFolderBatch(c, await readJson(request)));
    case "POST /api/restore":
      return json(await ops.restoreBatch(c, await readJson(request)));
    case "POST /api/empty-trash":
      return json(await ops.emptyTrashBatch(c));
    case "POST /api/save":
      return json(await ops.saveText(c, await readJson(request)));
    case "POST /api/upload/parts":
      return json(await ops.listParts(c, await readJson(request)));
    case "POST /api/fetch-url":
      return fetchToR2(c, ctx, await readJson(request));
    // Upload-password settings. Behind the normal Access login, like every
    // other /api/ route: these never accept the CLI password.
    case "GET /api/settings/upload-password": {
      const a = await readAuth(c);
      return json({ password: a.password, auto: a.auto, rotatedAt: a.rotatedAt });
    }
    case "POST /api/settings/upload-password": {
      const b = await readJson(request);
      const patch = {};
      if (b.password !== undefined) patch.password = String(b.password);
      if (b.auto !== undefined) patch.auto = String(b.auto);
      if (!Object.keys(patch).length) throw new HttpError(400, "Nothing to save.");
      const a = await saveAuth(c, patch);
      return json({ password: a.password, auto: a.auto, rotatedAt: a.rotatedAt });
    }
    default:
      return json({ error: "Not found." }, 404);
  }
}

export default {
  // Cron (see [triggers] in wrangler.toml). Rotation happens on the first run
  // at or after the 6-day mark, so it can be up to 24 hours late.
  async scheduled(event, env, ctx) {
    try {
      const c = getConfig(env);
      const problems = configProblems(c);
      if (problems.length) { logEvent("cron.run", { decision: "skipped", reason: "not configured yet" }); return; }
      if (event.cron === "30 * * * *") {
        if (c.PUBLIC_HOST) { const r = await sweepExpired(c); if (r.deleted) logEvent("links.expired.deleted", r); }
        return;
      }
      await rotateIfDue(c);
    } catch (e) {
      console.error("[file-manager] cron", e && e.stack ? e.stack : e);
      logEvent("cron.run", { decision: "skipped", reason: "error", error: String(e && e.message ? e.message : e) });
    }
  },

  async fetch(request, env, ctx) {
    try {
      return await handle(request, env, ctx);
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      if (status >= 500) console.error("[file-manager]", e && e.stack ? e.stack : e);
      return json({ error: e instanceof HttpError ? e.message : "Unexpected server error. Check the Worker logs." }, status);
    }
  },
};
