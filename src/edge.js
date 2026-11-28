// =====================================================================
//  Edge cache for shared files: settings, cache keys, filling, and the cache log.
//
//  Shared files (short links, public folders, signed links) up to a size limit are kept in
//  Cloudflare's cache (caches.default) of each data centre, under a key that carries the file's ETag:
//    https://PUBLIC_HOST/__edge/<encoded path>?v=<etag>
//  One fixed origin for every host (r2.bunnxr.com, bunnxr.com, and the app itself), so a file viewed
//  through either link host is cached once, and the app can check and preload the same entry.
//  public.js reads from the cache; everything that writes to it is here.
//
//  The cache cannot be listed or measured, and Cloudflare evicts rarely used files by itself. So each
//  fill is written to a log in the bucket (.system/edge-log/, one empty object per fill with the
//  details in its custom metadata). The Cache page shows that log: what was put in the cache, where,
//  and when. Entries older than the cache lifetime (30 days) are pruned by the hourly cron.
//
//  Settings (Settings → Edge cache) live in .system/edge-cache.json: { on, max }. Without that file
//  EDGE_CACHE_MAX_BYTES in src/config.js decides (0 = off).
// =====================================================================
import { HttpError, validKey, isInternal } from "./util.js";
import { store, sys } from "./storage/index.js";

export const EDGE_TTL = 2592000; // 30 days; a new version of a file has a new ETag, so a new key
export const EDGE_MAX = 512 * 1024 ** 2; // the largest object the cache holds on the Free and Pro plans
const SETTINGS = ".system/edge-cache.json";
const LOG = ".system/edge-log/";
const MIB = 1024 ** 2;

// ---------------------------------------------------------------------
//  Settings. Read on every shared-file request, so kept in this isolate for 30 seconds:
//  a change made in Settings takes up to half a minute to reach every data centre.
// ---------------------------------------------------------------------
let memo = null; // { at, cfg, val }
const clampMax = (v) => {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n >= MIB ? Math.min(n, EDGE_MAX) : null;
};
export async function edgeSettings(c, fresh) {
  if (!fresh && memo && memo.cfg === c.EDGE_CACHE_MAX_BYTES && Date.now() - memo.at < 30000) return memo.val;
  let val = { on: c.EDGE_CACHE_MAX_BYTES > 0, max: clampMax(c.EDGE_CACHE_MAX_BYTES) || EDGE_MAX, saved: false };
  try {
    const t = await sys(c).read(SETTINGS);
    if (t) { const j = JSON.parse(t); val = { on: j.on !== false, max: clampMax(j.max) || val.max, saved: true }; }
  } catch (e) { /* no or unreadable settings: the config decides */ }
  memo = { at: Date.now(), cfg: c.EDGE_CACHE_MAX_BYTES, val };
  return val;
}
export async function saveEdgeSettings(c, b) {
  const cur = await edgeSettings(c, true);
  const next = { on: b.on !== undefined ? !!b.on : cur.on, max: b.max !== undefined ? clampMax(b.max) : cur.max };
  if (!next.max) throw new HttpError(400, "Pick a size between 1 MB and 512 MB.");
  await sys(c).write(SETTINGS, JSON.stringify(next), "application/json");
  memo = null;
  return edgeSettings(c, true);
}
// The size limit in bytes for this request; 0 = the cache is off
export async function edgeLimit(c) {
  const s = await edgeSettings(c);
  return s.on ? s.max : 0;
}

export const edgeKey = (c, request, key, etag) =>
  (c.PUBLIC_HOST ? "https://" + c.PUBLIC_HOST : new URL(request.url).origin) + "/__edge/" + encodeURIComponent(key) + "?v=" + encodeURIComponent(etag);
const coloOf = (request) => (request && request.cf && typeof request.cf.colo === "string" ? request.cf.colo : "");

// ---------------------------------------------------------------------
//  Filling: a second, full read of the file (not tee(), which would hold the file in memory while a
//  slow viewer downloads it), checked to be the same version, put in the cache, then logged.
//  One fill per file per isolate at a time.
// ---------------------------------------------------------------------
const filling = new Set();
export async function fillEdge(c, key, ckey, etag, { colo, via }) {
  if (filling.has(ckey)) return false;
  filling.add(ckey);
  try {
    const r = await store(c).get(key, { method: "GET" });
    if (r.status !== 200 || !r.body || (r.headers.get("etag") || "") !== etag) {
      if (r.body) await r.body.cancel().catch(() => {});
      return false;
    }
    const h = new Headers();
    for (const n of ["content-type", "content-length", "etag", "last-modified"]) { const v = r.headers.get(n); if (v) h.set(n, v); }
    h.set("cache-control", "public, max-age=" + EDGE_TTL);
    await caches.default.put(ckey, new Response(r.body, { status: 200, headers: h }));
    await logFill(c, { key, size: Number(h.get("content-length")) || 0, etag, colo, via }).catch(() => {});
    return true;
  } catch (e) {
    return false; // the viewer was served already; the cache just stays empty
  } finally {
    filling.delete(ckey);
  }
}
// After a miss: fill in the background (ctx.waitUntil), at most once per file per isolate
export function scheduleFill(c, ctx, request, key, ckey, etag) {
  if (filling.has(ckey)) return;
  try { ctx.waitUntil(fillEdge(c, key, ckey, etag, { colo: coloOf(request), via: "view" })); } catch (e) { /* no fill */ }
}

// ---------------------------------------------------------------------
//  The cache log (needs the R2 binding: listing with custom metadata is a binding feature).
//  Names start with an inverted timestamp, so the newest entry lists first, and everything after
//  the 30-day mark is older than the cache itself and can go.
// ---------------------------------------------------------------------
const INV = 9999999999999;
const logName = (t) => LOG + String(INV - t).padStart(13, "0") + "-" + crypto.randomUUID().slice(0, 8);
async function logFill(c, { key, size, etag, colo, via }) {
  if (!c.R2) return;
  await c.R2.put(logName(Date.now()), "", { customMetadata: { k: key, s: String(size), e: etag, c: colo || "", v: via || "view", t: String(Date.now()) } });
}
// One page of the log, newest first: { entries: [{ key, size, etag, colo, via, t }], cursor }
export async function readEdgeLog(c, cursor) {
  if (!c.R2) return { entries: [], cursor: "", off: "The cache log needs the R2 binding ([[r2_buckets]] in wrangler.toml)." };
  const r = await c.R2.list({ prefix: LOG, limit: 500, cursor: cursor || undefined, include: ["customMetadata"] });
  const entries = r.objects.map((o) => {
    const m = o.customMetadata || {};
    return { key: m.k || "", size: Number(m.s) || 0, etag: m.e || "", colo: m.c || "", via: m.v || "view", t: Number(m.t) || 0 };
  }).filter((e) => e.key);
  return { entries, cursor: r.truncated ? r.cursor : "" };
}
// Deletes log entries: all of them, or (olderThan, in ms) the ones older than that. Up to 5,000 per call.
export async function clearEdgeLog(c, olderThan) {
  if (!c.R2) return { deleted: 0, more: false };
  const startAfter = olderThan ? LOG + String(INV - (Date.now() - olderThan)).padStart(13, "0") : undefined;
  let deleted = 0, cursor, more = false;
  for (let i = 0; i < 5; i++) {
    const r = await c.R2.list({ prefix: LOG, limit: 1000, cursor, startAfter: cursor ? undefined : startAfter });
    if (r.objects.length) { await c.R2.delete(r.objects.map((o) => o.key)); deleted += r.objects.length; }
    more = r.truncated;
    if (!more) break;
    cursor = r.cursor;
  }
  return { deleted, more };
}
// Hourly cron: entries older than the cache lifetime describe nothing that can still be cached
export const pruneEdgeLog = (c) => clearEdgeLog(c, EDGE_TTL * 1000);

// ---------------------------------------------------------------------
//  The app's Cache tools: is this file cached in the data centre near me, and preload it there
// ---------------------------------------------------------------------
async function probe(c, request, key) {
  if (typeof key !== "string" || !validKey(key, "file") || isInternal(key) || key.startsWith(".trash/")) throw new HttpError(400, "Invalid file.");
  const colo = coloOf(request);
  const head = await store(c).head(key);
  if (head.status === 404) throw new HttpError(404, "File not found.");
  if (!head.ok) throw new HttpError(502, "Could not read the file (" + head.status + ").");
  const etag = head.headers.get("etag") || "", size = Number(head.headers.get("content-length")) || 0;
  const limit = await edgeLimit(c);
  const base = { key, size, colo, limit, cacheable: false, cached: false };
  if (!limit) return Object.assign(base, { reason: "The edge cache is off (Settings → Edge cache)." });
  if (!c.PUBLIC_HOST) return Object.assign(base, { reason: "Shared links are off (PUBLIC_HOST is empty), so nothing is cached." });
  if (typeof caches === "undefined") return Object.assign(base, { reason: "The cache is not available here." });
  if (!etag) return Object.assign(base, { reason: "This file has no ETag, so it is never cached." });
  if (!size) return Object.assign(base, { reason: "Empty files are not cached." });
  if (size > limit) return Object.assign(base, { reason: "Larger than the cache limit (" + Math.round(limit / MIB) + " MB)." });
  const ckey = edgeKey(c, request, key, etag);
  const hit = await caches.default.match(new Request(ckey));
  if (hit && hit.body) hit.body.cancel().catch(() => {});
  return Object.assign(base, { cacheable: true, cached: !!hit, ckey, etag });
}
const pub = (p) => ({ key: p.key, size: p.size, colo: p.colo, limit: p.limit, cacheable: p.cacheable, cached: p.cached, reason: p.reason || "" });
export async function edgeStatus(c, request, key) { return pub(await probe(c, request, key)); }
// Fills the cache of the data centre this request runs in. Waits for the fill, so a big file takes a while.
export async function edgeWarm(c, request, key) {
  const p = await probe(c, request, key);
  if (!p.cacheable) throw new HttpError(400, p.reason);
  if (p.cached) return Object.assign(pub(p), { already: true });
  const ok = await fillEdge(c, key, p.ckey, p.etag, { colo: p.colo, via: "preload" });
  if (!ok) throw new HttpError(502, "Could not put the file in the cache. Try again in a moment.");
  return Object.assign(pub(p), { cached: true });
}
