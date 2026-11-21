// Per-file notes. All notes live in one small hidden file in the bucket: .notes/index.json = { "<file key>": "note" }.
// Moving, copying, trashing and restoring a file carries its note along (best effort, never blocks the operation).
import { HttpError } from "./util.js";
import { r2, r2Error } from "./r2.js";

const OBJ = ".notes/index.json";
const MAX_NOTE = 2000, MAX_INDEX = 2_000_000;

export async function readNotes(c) {
  const res = await r2(c, "GET", OBJ);
  if (res.status === 404) return {};
  if (!res.ok) throw new HttpError(502, r2Error(res));
  try { const o = JSON.parse(res.text); return o && typeof o === "object" && !Array.isArray(o) ? o : {}; } catch (e) { return {}; }
}
async function writeNotes(c, o) {
  const body = JSON.stringify(o);
  if (body.length > MAX_INDEX) throw new HttpError(413, "There are too many notes. Remove some first.");
  const res = await r2(c, "PUT", OBJ, { headers: { "content-type": "application/json" }, body });
  if (!res.ok) throw new HttpError(502, r2Error(res));
}

export async function setNote(c, key, text) {
  const o = await readNotes(c);
  const t = String(text ?? "").trim().slice(0, MAX_NOTE);
  if (t) o[key] = t; else delete o[key];
  await writeNotes(c, o);
  return { ok: true, text: t };
}

// pairs: [{ from, to, keep }]  keep = true for copies (the original keeps its note too)
export async function carryNotes(c, pairs) {
  if (!pairs.length) return;
  try {
    const o = await readNotes(c);
    let dirty = false;
    for (const p of pairs) {
      if (o[p.from] === undefined || p.from === p.to) continue;
      o[p.to] = o[p.from];
      if (!p.keep) delete o[p.from];
      dirty = true;
    }
    if (dirty) await writeNotes(c, o);
  } catch (e) { /* notes are best effort */ }
}

export async function dropNotes(c, keys) {
  if (!keys.length) return;
  try {
    const o = await readNotes(c);
    let dirty = false;
    for (const k of keys) if (o[k] !== undefined) { delete o[k]; dirty = true; }
    if (dirty) await writeNotes(c, o);
  } catch (e) { /* ignore */ }
}
