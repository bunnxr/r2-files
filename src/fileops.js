// Move, copy, trash, restore, save-text and multipart helpers. S3 has no rename or move,
// so every move is "copy, then delete". Paths may be in R2 or on Zenith (src/storage/index.js);
// the trash exists in R2 only, because files on Zenith are deleted permanently.
import { HttpError, validKey, validPrefix, sanitizeName, isInternal } from "./util.js";
import { store, uniqueKey, sameDrive, driveOf, MiB } from "./storage/index.js";
import { carryNotes, dropNotes } from "./notes.js";
import { carryLinks } from "./links.js";

const dirOf = (k) => k.slice(0, k.lastIndexOf("/") + 1);
const baseOf = (k) => k.slice(k.lastIndexOf("/") + 1);
const items = (v, max) => {
  if (!Array.isArray(v) || !v.length || v.length > max) throw new HttpError(400, "Send between 1 and " + max + " files at a time.");
  return v;
};
const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
const okId = (s) => typeof s === "string" && /^[a-z0-9]{4,20}$/.test(s);
const fileKey = (k) => validKey(k, "file") && !k.startsWith(".trash/") && !isInternal(k);
const okDest = (p) => validPrefix(p) && !p.startsWith(".trash/") && !isInternal(p);
const r2Only = (c, k) => { if (driveOf(c, k) !== "r2") throw new HttpError(400, "Files on Zenith have no trash: they are deleted permanently."); };

export async function copyObject(c, from, to) {
  await store(c).copy(from, to);
}

async function moveOne(c, key, destFolder, mode) {
  if (!fileKey(key)) throw new HttpError(400, "Invalid file.");
  if (!sameDrive(key, destFolder)) throw new HttpError(400, "Moving between drives goes through the transfer route.");
  if (mode === "move" && dirOf(key) === destFolder) return { from: key, to: key };
  const to = await uniqueKey(c, destFolder, baseOf(key));
  await copyObject(c, key, to);
  if (mode === "move") await store(c).remove(key);
  return { from: key, to };
}

export async function moveBatch(c, b) {
  const keys = items(b.keys, 8);
  const dest = typeof b.dest === "string" ? b.dest : "";
  if (!okDest(dest)) throw new HttpError(400, "Invalid destination folder.");
  const mode = b.mode === "copy" ? "copy" : "move";
  const out = { done: [], errors: [] }, pairs = [];
  for (const key of keys) {
    try { const r = await moveOne(c, key, dest, mode); out.done.push(r); pairs.push({ from: r.from, to: r.to, keep: mode === "copy" }); } catch (e) { out.errors.push({ key, error: e.message }); }
  }
  await carryNotes(c, pairs);
  await carryLinks(c, pairs); // a moved file keeps its short links
  return out;
}

// ---------------------------------------------------------------------
//  Copy or move ONE file between R2 and Zenith, streamed through the Worker
//  (nothing is held in memory). Small files go in one call. Bigger files
//  become a multipart upload on the destination, and the browser calls this
//  again with the `job` it got back until `done`, two parts per call, so each
//  request stays far below the 50-subrequest cap. Any failure aborts the
//  upload, so no half-finished parts are left behind on either side.
//    b: { from, dest, mode: "move" | "copy" }            first call
//    b: { job: { from, to, mode, uploadId, size, partSize, etags } }  next calls
//  Answer: { done: true, from, to } or { done: false, job, copied }
// ---------------------------------------------------------------------
const XFER_ONE_SHOT = 95 * MiB; // up to this size, a single GET and PUT
const XFER_PART = 64 * MiB;
const XFER_PARTS_PER_CALL = 2;

async function finishXfer(c, from, to, mode) {
  if (mode === "move") await store(c).remove(from);
  const pairs = [{ from, to, keep: mode === "copy" }];
  await carryNotes(c, pairs);
  await carryLinks(c, pairs);
  return { done: true, from, to };
}

export async function xferStep(c, b) {
  const st = store(c);
  if (!b.job) {
    const from = b.from, dest = typeof b.dest === "string" ? b.dest : "", mode = b.mode === "copy" ? "copy" : "move";
    if (!fileKey(from)) throw new HttpError(400, "Invalid file.");
    if (!okDest(dest)) throw new HttpError(400, "Invalid destination folder.");
    if (sameDrive(from, dest)) throw new HttpError(400, "Both are on the same drive: use a normal move.");
    const src = await st.stat(from);
    if (!src) throw new HttpError(404, "File not found: " + baseOf(from));
    const type = src.type || "application/octet-stream";
    const to = await uniqueKey(c, dest, baseOf(from));
    if (src.size <= XFER_ONE_SHOT) {
      const res = await st.get(from);
      if (!res.ok || !res.body) throw new HttpError(502, st.label(from) + " error " + res.status + " while reading " + baseOf(from));
      await st.put(to, res.body, { type, length: src.size });
      return finishXfer(c, from, to, mode);
    }
    let partSize = Math.ceil(Math.max(XFER_PART, Math.ceil(src.size / 10000)) / MiB) * MiB;
    if (partSize > st.maxPart(to)) throw new HttpError(413, "That file is too large to copy to " + st.label(to) + ".");
    const uploadId = await st.mp.create(to, type);
    return { done: false, copied: 0, job: { from, to, mode, uploadId, size: src.size, partSize, etags: [] } };
  }

  const j = b.job;
  const ok = j && fileKey(j.from) && fileKey(j.to) && !sameDrive(j.from, j.to) && typeof j.uploadId === "string" && j.uploadId &&
    Number.isInteger(j.size) && j.size > 0 && Number.isInteger(j.partSize) && j.partSize >= 5 * MiB && j.partSize <= st.maxPart(j.to) &&
    Array.isArray(j.etags) && j.etags.every((e) => typeof e === "string" && e) && (j.mode === "move" || j.mode === "copy");
  if (!ok) throw new HttpError(400, "Invalid transfer.");
  const parts = Math.ceil(j.size / j.partSize);
  try {
    for (let s = 0; s < XFER_PARTS_PER_CALL && j.etags.length < parts; s++) {
      const n = j.etags.length + 1, off = (n - 1) * j.partSize, end = Math.min(off + j.partSize, j.size) - 1;
      const res = await st.get(j.from, { headers: { range: "bytes=" + off + "-" + end } });
      const total = Number(((res.headers.get("content-range") || "").split("/")[1]) || NaN);
      if (res.status !== 206 || !res.body) throw new HttpError(502, st.label(j.from) + " error " + res.status + " while reading " + baseOf(j.from));
      // Files on Zenith can change at any time (SMB): stop if this one did
      if (total !== j.size) throw new HttpError(409, baseOf(j.from) + " changed while it was being copied. Try again.");
      j.etags.push(await st.mp.part(j.to, j.uploadId, n, res.body, end - off + 1));
    }
    if (j.etags.length < parts) return { done: false, copied: j.etags.length * j.partSize, job: j };
    await st.mp.complete(j.to, j.uploadId, j.etags.map((e, i) => ({ n: i + 1, e })));
  } catch (e) {
    try { await st.mp.abort(j.to, j.uploadId); } catch (x) { /* ignore */ }
    throw e;
  }
  return finishXfer(c, j.from, j.to, j.mode);
}

async function trashOne(c, key, id) {
  r2Only(c, key);
  const to = ".trash/" + id + "/" + key;
  if (!validKey(to, "file")) throw new HttpError(400, "The path is too long to move to the trash.");
  await copyObject(c, key, to);
  await store(c).remove(key);
  return to;
}

export async function trashBatch(c, b) {
  const keys = items(b.keys, 12);
  const id = okId(b.id) ? b.id : newId();
  const out = { id, done: 0, errors: [] }, pairs = [];
  for (const key of keys) {
    try { if (!fileKey(key)) throw new HttpError(400, "Invalid file."); pairs.push({ from: key, to: await trashOne(c, key, id) }); out.done++; } catch (e) { out.errors.push({ key, error: e.message }); }
  }
  await carryNotes(c, pairs);
  return out;
}

// One step of "delete folder": the browser repeats this until nothing is left
export async function trashFolderBatch(c, b) {
  const prefix = b.prefix;
  if (!validKey(prefix, "folder") || prefix.startsWith(".trash/") || isInternal(prefix)) throw new HttpError(400, "Invalid folder.");
  r2Only(c, prefix);
  const id = okId(b.id) ? b.id : newId();
  const st = store(c);
  const p = await st.listPage({ prefix, maxKeys: 12 });
  const keys = p.files.map((f) => f.key).filter((k) => k.startsWith(prefix));
  const out = { id, listed: keys.length, moved: 0, errors: [] }, pairs = [];
  for (const key of keys) {
    try {
      if (key.endsWith("/")) await st.remove(key); // empty-folder markers are not worth keeping
      else pairs.push({ from: key, to: await trashOne(c, key, id) });
      out.moved++;
    } catch (e) { out.errors.push({ key, error: e.message }); }
  }
  await carryNotes(c, pairs);
  return out;
}

export async function restoreBatch(c, b) {
  const keys = items(b.keys, 8);
  const out = { done: [], errors: [] }, pairs = [];
  for (const key of keys) {
    try {
      if (!validKey(key, "file") || !key.startsWith(".trash/")) throw new HttpError(400, "Not a trashed file.");
      const orig = key.replace(/^\.trash\/[^/]+\//, "");
      if (orig === key || !validKey(orig, "file")) throw new HttpError(400, "Invalid trashed file.");
      r2Only(c, orig);
      const to = await uniqueKey(c, dirOf(orig), baseOf(orig));
      await copyObject(c, key, to);
      await store(c).remove(key);
      out.done.push({ from: key, to }); pairs.push({ from: key, to });
    } catch (e) { out.errors.push({ key, error: e.message }); }
  }
  await carryNotes(c, pairs);
  return out;
}

export async function emptyTrashBatch(c) {
  const st = store(c);
  const p = await st.listPage({ prefix: ".trash/", maxKeys: 30 });
  const keys = p.files.map((f) => f.key);
  await Promise.all(keys.map((k) => st.remove(k)));
  await dropNotes(c, keys);
  return { deleted: keys.length };
}

const TEXT_TYPES = { md: "text/markdown", json: "application/json", csv: "text/csv", html: "text/html", htm: "text/html", css: "text/css", js: "text/javascript", mjs: "text/javascript", xml: "application/xml", yml: "text/yaml", yaml: "text/yaml" };
export async function saveText(c, b) {
  if (!fileKey(b.key) || typeof b.text !== "string") throw new HttpError(400, "Invalid request.");
  const body = new TextEncoder().encode(b.text);
  if (body.length > 2 * 1024 ** 2) throw new HttpError(413, "Text files over 2 MB cannot be edited here.");
  const ext = b.key.includes(".") ? b.key.split(".").pop().toLowerCase() : "";
  await store(c).put(b.key, body, { type: (TEXT_TYPES[ext] || "text/plain") + "; charset=utf-8" });
  return { ok: true, size: body.length };
}

// Which chunks of an unfinished multipart upload the storage already has (used to resume uploads)
export async function listParts(c, b) {
  if (!validKey(b.key, "file") || isInternal(b.key) || typeof b.uploadId !== "string" || !b.uploadId) throw new HttpError(400, "Invalid request.");
  return { parts: await store(c).mp.list(b.key, b.uploadId) };
}

// "New text file": creates a file that does not exist yet (never overwrites)
export async function newText(c, b) {
  const prefix = typeof b.prefix === "string" ? b.prefix : "";
  if (!okDest(prefix)) throw new HttpError(400, "Invalid folder.");
  let name = sanitizeName(b.name);
  if (!name.includes(".")) name += ".txt";
  const body = new TextEncoder().encode(typeof b.text === "string" ? b.text : "");
  if (body.length > 2 * 1024 ** 2) throw new HttpError(413, "Text files over 2 MB cannot be created here.");
  const key = await uniqueKey(c, prefix, name);
  const ext = name.split(".").pop().toLowerCase();
  await store(c).put(key, body, { type: (TEXT_TYPES[ext] || "text/plain") + "; charset=utf-8" });
  return { ok: true, key };
}
