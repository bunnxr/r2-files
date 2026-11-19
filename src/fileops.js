// Move, copy, trash, restore, save-text and multipart helpers. R2 has no rename or move,
// so every move is "copy, then delete" using the S3 API.
import { HttpError, validKey, validPrefix } from "./util.js";
import { r2, xmlEsc, xmlTag, r2Error, parseList, uniqueKey } from "./r2.js";
import { encPath } from "./sigv4.js";

const COPY_SINGLE_MAX = 4 * 1024 ** 3; // CopyObject up to 4 GiB; bigger files are copied in 1 GiB parts
const COPY_PART = 1024 ** 3;
const dirOf = (k) => k.slice(0, k.lastIndexOf("/") + 1);
const baseOf = (k) => k.slice(k.lastIndexOf("/") + 1);
const items = (v, max) => {
  if (!Array.isArray(v) || !v.length || v.length > max) throw new HttpError(400, "Send between 1 and " + max + " files at a time.");
  return v;
};
const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
const okId = (s) => typeof s === "string" && /^[a-z0-9]{4,20}$/.test(s);
const fileKey = (k) => validKey(k, "file") && !k.startsWith(".trash/");

async function remove(c, key) {
  const res = await r2(c, "DELETE", key);
  if (!res.ok && res.status !== 404) throw new HttpError(502, r2Error(res));
}

export async function copyObject(c, from, to) {
  const head = await r2(c, "HEAD", from);
  if (head.status === 404) throw new HttpError(404, "File not found: " + baseOf(from));
  if (!head.ok) throw new HttpError(502, "R2 error " + head.status + " while reading " + baseOf(from));
  const size = Number(head.headers.get("content-length") || 0);
  const src = "/" + c.BUCKET + "/" + encPath(from); // x-amz-copy-source must be URL-encoded
  if (size <= COPY_SINGLE_MAX) {
    const res = await r2(c, "PUT", to, { headers: { "x-amz-copy-source": src } });
    if (!res.ok || /<Error>/.test(res.text)) throw new HttpError(502, r2Error(res));
    return;
  }
  const type = head.headers.get("content-type") || "application/octet-stream";
  const init = await r2(c, "POST", to, { query: { uploads: "" }, headers: { "content-type": type } });
  const uploadId = xmlTag(init.text, "UploadId");
  if (!init.ok || !uploadId) throw new HttpError(502, r2Error(init));
  try {
    const etags = [];
    for (let n = 1, off = 0; off < size; n++, off += COPY_PART) {
      const end = Math.min(off + COPY_PART, size) - 1;
      const r = await r2(c, "PUT", to, { query: { partNumber: String(n), uploadId }, headers: { "x-amz-copy-source": src, "x-amz-copy-source-range": "bytes=" + off + "-" + end } });
      if (!r.ok) throw new HttpError(502, r2Error(r));
      etags.push({ n, e: xmlTag(r.text, "ETag") });
    }
    const xml = "<CompleteMultipartUpload>" + etags.map((p) => "<Part><PartNumber>" + p.n + "</PartNumber><ETag>" + xmlEsc(p.e) + "</ETag></Part>").join("") + "</CompleteMultipartUpload>";
    const done = await r2(c, "POST", to, { query: { uploadId }, body: xml });
    if (!done.ok || /<Error>/.test(done.text)) throw new HttpError(502, r2Error(done));
  } catch (e) {
    await r2(c, "DELETE", to, { query: { uploadId } });
    throw e;
  }
}

async function moveOne(c, key, destFolder, mode) {
  if (!fileKey(key)) throw new HttpError(400, "Invalid file.");
  if (mode === "move" && dirOf(key) === destFolder) return { from: key, to: key };
  const to = await uniqueKey(c, destFolder, baseOf(key));
  await copyObject(c, key, to);
  if (mode === "move") await remove(c, key);
  return { from: key, to };
}

export async function moveBatch(c, b) {
  const keys = items(b.keys, 8);
  const dest = typeof b.dest === "string" ? b.dest : "";
  if (!validPrefix(dest) || dest.startsWith(".trash/")) throw new HttpError(400, "Invalid destination folder.");
  const mode = b.mode === "copy" ? "copy" : "move";
  const out = { done: [], errors: [] };
  for (const key of keys) {
    try { out.done.push(await moveOne(c, key, dest, mode)); } catch (e) { out.errors.push({ key, error: e.message }); }
  }
  return out;
}

async function trashOne(c, key, id) {
  const to = ".trash/" + id + "/" + key;
  if (!validKey(to, "file")) throw new HttpError(400, "The path is too long to move to the trash.");
  await copyObject(c, key, to);
  await remove(c, key);
}

export async function trashBatch(c, b) {
  const keys = items(b.keys, 12);
  const id = okId(b.id) ? b.id : newId();
  const out = { id, done: 0, errors: [] };
  for (const key of keys) {
    try { if (!fileKey(key)) throw new HttpError(400, "Invalid file."); await trashOne(c, key, id); out.done++; } catch (e) { out.errors.push({ key, error: e.message }); }
  }
  return out;
}

// One step of "delete folder": the browser repeats this until nothing is left
export async function trashFolderBatch(c, b) {
  const prefix = b.prefix;
  if (!validKey(prefix, "folder") || prefix.startsWith(".trash/")) throw new HttpError(400, "Invalid folder.");
  const id = okId(b.id) ? b.id : newId();
  const res = await r2(c, "GET", "", { query: { "list-type": "2", "max-keys": "12", prefix } });
  if (!res.ok) throw new HttpError(502, r2Error(res));
  const keys = parseList(res.text).files.map((f) => f.key).filter((k) => k.startsWith(prefix));
  const out = { id, listed: keys.length, moved: 0, errors: [] };
  for (const key of keys) {
    try {
      if (key.endsWith("/")) await remove(c, key); // empty-folder markers are not worth keeping
      else await trashOne(c, key, id);
      out.moved++;
    } catch (e) { out.errors.push({ key, error: e.message }); }
  }
  return out;
}

export async function restoreBatch(c, b) {
  const keys = items(b.keys, 8);
  const out = { done: [], errors: [] };
  for (const key of keys) {
    try {
      if (!validKey(key, "file") || !key.startsWith(".trash/")) throw new HttpError(400, "Not a trashed file.");
      const orig = key.replace(/^\.trash\/[^/]+\//, "");
      if (orig === key || !validKey(orig, "file")) throw new HttpError(400, "Invalid trashed file.");
      const to = await uniqueKey(c, dirOf(orig), baseOf(orig));
      await copyObject(c, key, to);
      await remove(c, key);
      out.done.push({ from: key, to });
    } catch (e) { out.errors.push({ key, error: e.message }); }
  }
  return out;
}

export async function emptyTrashBatch(c) {
  const res = await r2(c, "GET", "", { query: { "list-type": "2", "max-keys": "30", prefix: ".trash/" } });
  if (!res.ok) throw new HttpError(502, r2Error(res));
  const keys = parseList(res.text).files.map((f) => f.key);
  await Promise.all(keys.map((k) => remove(c, k)));
  return { deleted: keys.length };
}

const TEXT_TYPES = { md: "text/markdown", json: "application/json", csv: "text/csv", html: "text/html", htm: "text/html", css: "text/css", js: "text/javascript", mjs: "text/javascript", xml: "application/xml", yml: "text/yaml", yaml: "text/yaml" };
export async function saveText(c, b) {
  if (!fileKey(b.key) || typeof b.text !== "string") throw new HttpError(400, "Invalid request.");
  const body = new TextEncoder().encode(b.text);
  if (body.length > 2 * 1024 ** 2) throw new HttpError(413, "Text files over 2 MB cannot be edited here.");
  const ext = b.key.includes(".") ? b.key.split(".").pop().toLowerCase() : "";
  const res = await r2(c, "PUT", b.key, { headers: { "content-type": (TEXT_TYPES[ext] || "text/plain") + "; charset=utf-8" }, body });
  if (!res.ok) throw new HttpError(502, r2Error(res));
  return { ok: true, size: body.length };
}

// Which chunks of an unfinished multipart upload R2 already has (used to resume uploads)
export async function listParts(c, b) {
  if (!validKey(b.key, "file") || typeof b.uploadId !== "string" || !b.uploadId) throw new HttpError(400, "Invalid request.");
  const parts = [];
  let marker = 0;
  for (let i = 0; i < 10; i++) {
    const res = await r2(c, "GET", b.key, { query: { uploadId: b.uploadId, "max-parts": "1000", "part-number-marker": String(marker) } });
    if (res.status === 404 || /NoSuchUpload/.test(res.text)) throw new HttpError(404, "That upload no longer exists.");
    if (!res.ok) throw new HttpError(502, r2Error(res));
    for (const m of res.text.matchAll(/<Part>([\s\S]*?)<\/Part>/g)) parts.push({ n: Number(xmlTag(m[1], "PartNumber")), etag: xmlTag(m[1], "ETag"), size: Number(xmlTag(m[1], "Size")) });
    if (xmlTag(res.text, "IsTruncated") !== "true") break;
    marker = Number(xmlTag(res.text, "NextPartNumberMarker")) || parts[parts.length - 1].n;
  }
  return { parts };
}
