import { HttpError, validKey, validPrefix, sanitizeName, isInternal } from "./util.js";
import { store, uniqueKey, driveOf } from "./storage/index.js";
import { dropNotes } from "./notes.js";
import { rfc3986 } from "./sigv4.js";

// ---------------------------------------------------------------------
//  API handlers. Every path may be in R2 or on Zenith; store(c) decides.
// ---------------------------------------------------------------------
async function uploadInit(c, b) {
  const prefix = typeof b.prefix === "string" ? b.prefix : "";
  if (!validPrefix(prefix)) throw new HttpError(400, "Invalid destination folder.");
  const size = Number(b.size);
  if (!Number.isInteger(size) || size < 0) throw new HttpError(400, "Invalid file size.");

  // sub-folders from a dropped directory: sanitise every segment
  const rel = typeof b.rel === "string" ? b.rel.split("/").filter(Boolean).slice(0, 20).map(sanitizeName).join("/") : "";
  if (prefix.startsWith(".trash/") || isInternal(prefix)) throw new HttpError(400, "That folder is reserved.");
  const dest = prefix + (rel ? rel + "/" : "");
  const name = sanitizeName(b.name);

  const st = store(c);
  const key = await uniqueKey(c, dest, name);
  const type = /^[\w.+-]+\/[\w.+-]+$/.test(String(b.type || "")) ? String(b.type) : "application/octet-stream";

  if (size === 0) {
    await st.put(key, "", { type });
    return { mode: "done", key };
  }

  // At most 10,000 parts, so the chunk grows for very large files; on Zenith it never exceeds 95 MiB
  const partSize = st.mp.partSize(key, size);
  const uploadId = await st.mp.create(key, type);
  return { mode: "multipart", key, uploadId, partSize, parts: Math.ceil(size / partSize) };
}

async function uploadComplete(c, b) {
  if (!validKey(b.key, "file") || isInternal(b.key) || typeof b.uploadId !== "string" || !b.uploadId) throw new HttpError(400, "Invalid request.");
  const parts = Array.isArray(b.parts) ? b.parts : [];
  if (!parts.length || parts.length > 10000) throw new HttpError(400, "Invalid part list.");
  const sorted = parts
    .map((p) => ({ n: Number(p.PartNumber), e: String(p.ETag || "") }))
    .sort((a, z) => a.n - z.n);
  if (sorted.some((p) => !Number.isInteger(p.n) || p.n < 1 || !p.e)) throw new HttpError(400, "Invalid part list.");

  await store(c).mp.complete(b.key, b.uploadId, sorted);
  return { ok: true, key: b.key };
}

// Where the client sends chunk n. dataBase is this Worker's chunk route, used for Zenith.
async function partTarget(c, b, dataBase) {
  const n = Number(b.partNumber);
  if (!validKey(b.key, "file") || isInternal(b.key) || typeof b.uploadId !== "string" || !b.uploadId || !Number.isInteger(n) || n < 1 || n > 10000) {
    throw new HttpError(400, "Invalid request.");
  }
  return { url: await store(c).mp.target(b.key, b.uploadId, n, dataBase) };
}

// PUT <dataBase>?key=&uploadId=&n=&e=&s=   one chunk for Zenith, streamed straight on (never buffered).
// The signed URL from partTarget is the permission; it works for one part of one upload, for a limited time.
// Answers like S3 does: 200 with the part's ETag in the ETag header.
async function uploadData(c, request, url) {
  const q = url.searchParams;
  const key = q.get("key") || "", uploadId = q.get("uploadId") || "", n = Number(q.get("n"));
  if (!validKey(key, "file") || isInternal(key) || driveOf(c, key) !== "zenith" || !uploadId || !Number.isInteger(n) || n < 1 || n > 10000) throw new HttpError(400, "Invalid request.");
  const st = store(c);
  if (!(await st.mp.verifyTarget(key, uploadId, n, q.get("e"), q.get("s")))) throw new HttpError(403, "This upload link is not valid or has expired.");
  const len = Number(request.headers.get("content-length"));
  if (!Number.isInteger(len) || len < 1) throw new HttpError(411, "The chunk needs a Content-Length.");
  if (len > st.maxPart(key)) throw new HttpError(413, "Chunks for " + st.label(key) + " must be 95 MB or smaller.");
  if (!request.body) throw new HttpError(400, "The chunk is empty.");
  const etag = await st.mp.part(key, uploadId, n, request.body, len);
  // no-transform: nothing on the way may rewrite the ETag the complete call needs
  return new Response(null, { status: 200, headers: { etag, "cache-control": "no-store, no-transform" } });
}

async function uploadAbort(c, b) {
  if (!validKey(b.key, "file") || isInternal(b.key) || typeof b.uploadId !== "string" || !b.uploadId) throw new HttpError(400, "Invalid request.");
  await store(c).mp.abort(b.key, b.uploadId);
  return { ok: true };
}

// Permanently deletes a folder, one slice per call (Zenith has no trash). The browser repeats the
// call until nothing is left. 1 list call + up to 30 deletes per request keeps us under the
// Free plan's 50-subrequest cap.
async function deleteFolderBatch(c, prefix) {
  if (!prefix || !validKey(prefix, "folder") || isInternal(prefix)) throw new HttpError(400, "Invalid folder.");
  const st = store(c);
  const p = await st.listPage({ prefix, maxKeys: 30 });
  const keys = p.files.map((f) => f.key).filter((k) => k.startsWith(prefix) && validKey(k, k.endsWith("/") ? "folder" : "file"));
  // Nothing left inside: remove the folder itself too (an empty directory on Zenith's disk)
  if (!keys.length) { try { await st.remove(prefix); } catch (e) { /* already gone */ } return { deleted: 0 }; }
  await Promise.all(keys.map((k) => st.remove(k)));
  await dropNotes(c, keys.filter((k) => !k.endsWith("/")));
  return { deleted: keys.length };
}

function contentDisposition(mode, key) {
  const name = key.split("/").pop();
  const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return (mode === "inline" ? "inline" : "attachment") + '; filename="' + ascii + "\"; filename*=UTF-8''" + rfc3986(name);
}


export { uploadInit, uploadComplete, partTarget, uploadData, uploadAbort, deleteFolderBatch, contentDisposition };
