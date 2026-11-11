import { HttpError, validKey, validPrefix, sanitizeName } from "./util.js";
import { r2, xmlEsc, xmlTag, r2Error, parseList, uniqueKey } from "./r2.js";
import { rfc3986 } from "./sigv4.js";

// ---------------------------------------------------------------------
//  API handlers
// ---------------------------------------------------------------------
async function uploadInit(c, b) {
  const prefix = typeof b.prefix === "string" ? b.prefix : "";
  if (!validPrefix(prefix)) throw new HttpError(400, "Invalid destination folder.");
  const size = Number(b.size);
  if (!Number.isInteger(size) || size < 0) throw new HttpError(400, "Invalid file size.");

  // sub-folders from a dropped directory: sanitise every segment
  const rel = typeof b.rel === "string" ? b.rel.split("/").filter(Boolean).slice(0, 20).map(sanitizeName).join("/") : "";
  const dest = prefix + (rel ? rel + "/" : "");
  const name = sanitizeName(b.name);


  const key = await uniqueKey(c, dest, name);
  const type = /^[\w.+-]+\/[\w.+-]+$/.test(String(b.type || "")) ? String(b.type) : "application/octet-stream";

  if (size === 0) {
    const res = await r2(c, "PUT", key, { headers: { "content-type": type }, body: "" });
    if (!res.ok) throw new HttpError(502, r2Error(res));
    return { mode: "done", key };
  }

  const res = await r2(c, "POST", key, { query: { uploads: "" }, headers: { "content-type": type } });
  const uploadId = xmlTag(res.text, "UploadId");
  if (!res.ok || !uploadId) throw new HttpError(502, r2Error(res));

  // R2 allows at most 10,000 parts, so enlarge the chunk for very large files
  let partSize = Math.max(c.CHUNK_SIZE, Math.ceil(size / 10000));
  partSize = Math.ceil(partSize / 1048576) * 1048576;
  return { mode: "multipart", key, uploadId, partSize, parts: Math.ceil(size / partSize) };
}

async function uploadComplete(c, b) {
  if (!validKey(b.key, "file") || typeof b.uploadId !== "string" || !b.uploadId) throw new HttpError(400, "Invalid request.");
  const parts = Array.isArray(b.parts) ? b.parts : [];
  if (!parts.length || parts.length > 10000) throw new HttpError(400, "Invalid part list.");
  const sorted = parts
    .map((p) => ({ n: Number(p.PartNumber), e: String(p.ETag || "") }))
    .sort((a, z) => a.n - z.n);
  if (sorted.some((p) => !Number.isInteger(p.n) || p.n < 1 || !p.e)) throw new HttpError(400, "Invalid part list.");

  const xml = "<CompleteMultipartUpload>" + sorted.map((p) => "<Part><PartNumber>" + p.n + "</PartNumber><ETag>" + xmlEsc(p.e) + "</ETag></Part>").join("") + "</CompleteMultipartUpload>";
  const res = await r2(c, "POST", b.key, { query: { uploadId: b.uploadId }, body: xml });
  if (!res.ok || /<Error>/.test(res.text)) throw new HttpError(502, r2Error(res));

  return { ok: true, key: b.key };
}

async function deleteFolderBatch(c, prefix) {
  if (!prefix || !validKey(prefix, "folder")) throw new HttpError(400, "Invalid folder.");
  // 1 list call + up to 30 deletes per request keeps us under the Free plan's 50-subrequest cap;
  // the browser repeats this call until nothing is left.
  const res = await r2(c, "GET", "", { query: { "list-type": "2", "max-keys": "30", prefix } });
  if (!res.ok) throw new HttpError(502, r2Error(res));
  const keys = parseList(res.text).files.map((f) => f.key).filter((k) => k.startsWith(prefix) && validKey(k, k.endsWith("/") ? "folder" : "file"));
  const results = await Promise.all(keys.map((k) => r2(c, "DELETE", k)));
  const bad = results.find((r) => !r.ok && r.status !== 404);
  if (bad) throw new HttpError(502, r2Error(bad));
  return { deleted: keys.length };
}

function contentDisposition(mode, key) {
  const name = key.split("/").pop();
  const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return (mode === "inline" ? "inline" : "attachment") + '; filename="' + ascii + "\"; filename*=UTF-8''" + rfc3986(name);
}


export { uploadInit, uploadComplete, deleteFolderBatch, contentDisposition };
