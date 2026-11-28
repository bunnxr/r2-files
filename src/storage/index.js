// =====================================================================
//  Storage: the one interface every other module uses.
//
//  The app works with PATHS. A path that starts with "zenith:/" lives on
//  Zenith (the self-hosted S3 server); every other path lives in R2:
//
//    "photos/a.jpg"          R2,     key "photos/a.jpg"
//    "zenith:/photos/a.jpg"  Zenith, key "photos/a.jpg"
//
//  resolve() below is the only place that decision is made. Every method of
//  store(c) takes and returns paths, so callers never see which storage a
//  file is on (unless they ask, with driveOf). File and folder names made in
//  the app can never contain ":" (sanitizeName), so no R2 folder can clash
//  with the "zenith:/" prefix.
//
//  Internal records (.links/, .notes/, .system/) always live in R2: see sys(c).
// =====================================================================
import { HttpError, validKey, isInternal, typeOf } from "../util.js";
import { r2Driver } from "./r2.js";
import { zenithDriver, zenithPartUrl, verifyZenithPart, ZENITH_ROOT, ZENITH_MAX_PART } from "./zenith.js";

const made = new WeakMap(); // drivers per config object (one config per request)
function drivers(c) {
  let d = made.get(c);
  if (!d) { d = { r2: r2Driver(c), zenith: c.ZENITH ? zenithDriver(c) : null }; made.set(c, d); }
  return d;
}

// path -> { d: driver, key: the driver's own key }
export function resolve(c, path) {
  if (typeof path === "string" && path.startsWith(ZENITH_ROOT)) {
    const z = drivers(c).zenith;
    if (!z) throw new HttpError(503, "Zenith is not set up: the ZENITH_ENDPOINT, ZENITH_BUCKET, ZENITH_KEY and ZENITH_SECRET secrets are needed.");
    return { d: z, key: path.slice(ZENITH_ROOT.length) };
  }
  return { d: drivers(c).r2, key: path };
}
export const driveOf = (c, path) => resolve(c, path).d.id; // "r2" or "zenith"
export const sameDrive = (a, b) => (a.startsWith(ZENITH_ROOT) ? "zenith" : "r2") === (b.startsWith(ZENITH_ROOT) ? "zenith" : "r2");
// Drives other than R2, for the web app (shown as cards next to the R2 files)
export const extraDrives = (c) => (c.ZENITH ? [{ id: "zenith", label: "Zenith", root: ZENITH_ROOT }] : []);
// R2 paths that look like another drive's root are never shown or reachable as R2 files
const shadowed = (k) => k.startsWith(ZENITH_ROOT);

export function store(c) {
  const at = (path) => resolve(c, path);
  // driver keys -> paths; on R2, entries that look like "zenith:/…" are dropped (see shadowed)
  const files = (d, list) => list.map((f) => ({ key: d.root + f.key, size: f.size, modified: f.modified })).filter((f) => d.root !== "" || !shadowed(f.key));
  const folders = (d, list) => list.map((f) => d.root + f).filter((f) => d.root !== "" || !shadowed(f));
  return {
    // { files: [{ key, size, modified }], folders: [path], truncated } with paths, not driver keys
    async list({ prefix = "", delimiter, maxPages = 1 }) {
      const { d, key } = at(prefix);
      const r = await d.list({ prefix: key, delimiter, maxPages });
      return { files: files(d, r.files), folders: folders(d, r.folders), truncated: r.truncated };
    },
    // One page, without following ContinuationToken (batch jobs that work through a folder a slice at a time)
    async listPage({ prefix = "", maxKeys, startAfter }) {
      const { d, key } = at(prefix);
      const p = await d.listPage({ prefix: key, maxKeys, startAfter: startAfter ? at(startAfter).key : undefined });
      return { files: files(d, p.files), truncated: p.truncated };
    },
    head: async (path) => { const { d, key } = at(path); return d.head(key); }, // { ok, status, headers }
    stat: async (path) => { const { d, key } = at(path); return d.stat(key); },
    // Streams a file. opts: { method: "GET" | "HEAD", headers (Range, If-*), query (response-content-disposition) }
    get: async (path, opts) => { const { d, key } = at(path); return d.get(key, opts); },
    put: async (path, body, opts) => { const { d, key } = at(path); return d.put(key, body, opts); },
    remove: async (path) => { const { d, key } = at(path); return d.remove(key); },
    mkdir: async (prefix) => { const { d, key } = at(prefix); return d.put(key, ""); }, // "folder/" marker object
    // Copy within one drive (server-side). Between drives see xferStep in fileops.js.
    async copy(from, to) {
      if (!sameDrive(from, to)) throw new HttpError(400, "Copying between drives goes through the transfer route.");
      const a = at(from), b = at(to);
      return a.d.copy(a.key, b.key);
    },
    label: (path) => at(path).d.label,
    maxPart: (path) => at(path).d.maxPart,

    // ---- multipart uploads
    mp: {
      create: async (path, type) => { const { d, key } = at(path); return d.mpCreate(key, type); },
      part: async (path, uploadId, n, body, length) => { const { d, key } = at(path); return d.mpPart(key, uploadId, n, body, length); },
      list: async (path, uploadId) => { const { d, key } = at(path); return d.mpList(key, uploadId); },
      complete: async (path, uploadId, parts) => { const { d, key } = at(path); return d.mpComplete(key, uploadId, parts); },
      abort: async (path, uploadId) => { const { d, key } = at(path); return d.mpAbort(key, uploadId); },
      partSize: (path, size) => at(path).d.partSize(size, c.CHUNK_SIZE),
      // Where a client PUTs chunk n. R2: a presigned R2 URL. Zenith: this Worker (dataBase), at a
      // signed URL, because nothing outside the Worker can reach Zenith.
      target(path, uploadId, n, dataBase) {
        const { d, key } = at(path);
        return d.id === "r2" ? d.partUrl(key, uploadId, n) : zenithPartUrl(c, dataBase, path, uploadId, n);
      },
      verifyTarget: (path, uploadId, n, exp, sig) => verifyZenithPart(c, path, uploadId, n, exp, sig),
    },

    // A URL the web app can open to download (mode "download") or show (mode "inline") a file.
    // R2: a direct presigned link (as always). Zenith: the Worker's own /api/read, which streams it.
    async openUrl(path, mode, disposition) {
      const { d, key } = at(path);
      if (d.id === "r2") return d.signedGet(key, { "response-content-disposition": disposition });
      return "/api/read?key=" + encodeURIComponent(path) + (mode === "inline" ? "&inline=1" : "&dl=1");
    },
    // A direct expiring R2 link, used for share links only when PUBLIC_HOST is off
    async signedLink(path, seconds) {
      const { d, key } = at(path);
      if (d.id !== "r2") throw new HttpError(400, "Set PUBLIC_HOST in the config to share files from Zenith.");
      return d.signedGet(key, undefined, seconds);
    },
  };
}

// First free path for `name` inside folder `prefix`: name, then "name (1).ext", "name (2).ext" …
export async function uniqueKey(c, prefix, name) {
  const dot = name.lastIndexOf(".");
  const base = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  for (let i = 0; i < 8; i++) {
    const path = prefix + (i ? base + " (" + i + ")" + ext : name);
    if (!validKey(path, "file")) throw new HttpError(400, "That file name or folder path is not allowed.");
    const { d, key } = resolve(c, path);
    const res = await d.head(key);
    if (res.status === 404) return path;
    if (res.status !== 200) throw new HttpError(502, await d.explain(key, res.status, "while checking the file name"));
  }
  throw new HttpError(409, "Too many files with the same name. Rename the file and try again.");
}

// Sum of all R2 object sizes (the Storage figure, the type views and Largest files are R2 only).
// Capped at 40 list calls (40,000 objects) to stay inside the Workers Free 50-subrequest limit;
// if the cap is hit the figure is a lower bound.
export async function bucketUsage(c) {
  const r = await drivers(c).r2.list({ prefix: "", delimiter: "", maxPages: 40 });
  r.files = r.files.filter((f) => !shadowed(f.key));
  const byType = {};
  let count = 0;
  for (const f of r.files) {
    if (f.key.endsWith("/") || isInternal(f.key)) continue; // folder markers and internal link records
    count++;
    const t = typeOf(f.key);
    const e = byType[t] || (byType[t] = { count: 0, size: 0 });
    e.count++;
    e.size += f.size;
  }
  return { used: r.files.reduce((n, f) => n + f.size, 0), count, partial: r.truncated, byType, files: r.files };
}

// ---------------------------------------------------------------------
//  System records: small JSON objects the app keeps for itself, always in R2
//  (short links, notes, the upload password). Never Zenith.
// ---------------------------------------------------------------------
// With the bucket binding (c.R2) records are read, written and removed through it (no signed S3 call
// for every short-link lookup); listing them (listPage) always uses the S3 API.
export function sys(c) {
  const d = drivers(c).r2, b = c.R2;
  const failed = (e) => new HttpError(502, "R2 error: " + (e && e.message ? e.message : e));
  return {
    // The text of the record, or null when it does not exist
    async read(obj) {
      if (b) {
        let o;
        try { o = await b.get(obj); } catch (e) { throw failed(e); }
        return o ? await o.text() : null;
      }
      const res = await d.call("GET", obj);
      if (res.status === 404) return null;
      if (!res.ok) throw new HttpError(502, d.error(res));
      return res.text;
    },
    async write(obj, body, type) {
      if (b) {
        try { await b.put(obj, body, { httpMetadata: { contentType: type || "application/json" } }); } catch (e) { throw failed(e); }
        return;
      }
      const res = await d.call("PUT", obj, { headers: { "content-type": type || "application/json" }, body });
      if (!res.ok) throw new HttpError(502, d.error(res));
    },
    remove: (obj) => (b ? b.delete(obj) : d.call("DELETE", obj)),
    listPage: (o) => d.listPage(o),
  };
}

export { ZENITH_ROOT, ZENITH_MAX_PART };
export { MiB } from "./s3.js";
