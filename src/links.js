// Short links: https://PUBLIC_HOST/<file name>  (for example r2.bunnxr.com/charlie.zip)
// The URL never changes whatever expiry you pick, so the expiry lives on the server.
// Records are tiny JSON objects kept in the bucket itself (hidden folder .links/), so nothing extra to set up:
//   .links/n/<name>   name  -> { key, exp }      (used when the link is opened)
//   .links/k/<hash>   file  -> { name, key, exp } (used to show the current link of a file)
// exp is a unix time in seconds, or 0 for a link that never expires.
import { HttpError, validKey, sanitizeName } from "./util.js";
import { r2, r2Error } from "./r2.js";

const enc = new TextEncoder();
const hex = (b) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
const nameObj = (n) => ".links/n/" + n;
const keyObj = async (k) => ".links/k/" + hex(await crypto.subtle.digest("SHA-256", enc.encode(k))).slice(0, 32);
const alive = (r) => !!r && (!r.exp || r.exp * 1000 > Date.now());
const urlFor = (c, name) => "https://" + c.PUBLIC_HOST + "/" + encodeURIComponent(name);

async function read(c, obj) {
  const res = await r2(c, "GET", obj);
  if (res.status === 404) return null;
  if (!res.ok) throw new HttpError(502, r2Error(res));
  try { return JSON.parse(res.text); } catch (e) { return null; }
}
async function write(c, obj, rec) {
  const res = await r2(c, "PUT", obj, { headers: { "content-type": "application/json" }, body: JSON.stringify(rec) });
  if (!res.ok) throw new HttpError(502, r2Error(res));
}
async function drop(c, obj) { await r2(c, "DELETE", obj); }

export async function lookupLink(c, name) {
  if (!validKey(nameObj(name), "file")) return null;
  const r = await read(c, nameObj(name));
  const ok = r && typeof r.key === "string" && validKey(r.key, "file") && !r.key.startsWith(".trash/") && !(r.key.startsWith(".links/") || r.key.startsWith(".notes/"));
  return ok ? r : null;
}

export async function linkInfo(c, key) {
  const k = await read(c, await keyObj(key));
  if (!k || !k.name) return { exists: false };
  const n = await lookupLink(c, k.name);
  if (!n || n.key !== key) return { exists: false };
  return { exists: true, active: alive(n), name: k.name, url: urlFor(c, k.name), exp: n.exp || 0 };
}

export async function createLink(c, key, seconds) {
  if (!c.PUBLIC_HOST) throw new HttpError(400, "Set PUBLIC_HOST in the config to create short links.");
  const exp = seconds > 0 ? Math.floor(Date.now() / 1000) + seconds : 0;
  const ko = await keyObj(key);
  let name = null;
  const prev = await read(c, ko);
  if (prev && prev.name) { // keep the same URL for this file whenever it is still ours
    const n = await lookupLink(c, prev.name);
    if (!n || n.key === key || !alive(n)) name = prev.name;
  }
  if (!name) {
    const base = sanitizeName(key.split("/").pop()).replace(/\s+/g, "-");
    const dot = base.lastIndexOf("."), stem = dot > 0 ? base.slice(0, dot) : base, ext = dot > 0 ? base.slice(dot) : "";
    for (let i = 1; i <= 20 && !name; i++) { // charlie.zip, then charlie-2.zip if another file already uses that name
      const cand = i === 1 ? base : stem + "-" + i + ext;
      const n = await lookupLink(c, cand);
      if (!n || n.key === key || !alive(n)) name = cand;
    }
    if (!name) throw new HttpError(409, "Too many links use this file name. Rename the file first.");
  }
  const rec = { key, exp, t: Math.floor(Date.now() / 1000) };
  await write(c, nameObj(name), rec);
  await write(c, ko, Object.assign({ name }, rec));
  return { name, url: urlFor(c, name), exp };
}

export async function removeLink(c, key) {
  const ko = await keyObj(key);
  const k = await read(c, ko);
  if (k && k.name) { const n = await lookupLink(c, k.name); if (n && n.key === key) await drop(c, nameObj(k.name)); }
  await drop(c, ko);
  return { ok: true };
}
