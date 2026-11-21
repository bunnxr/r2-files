// Short links: https://PUBLIC_HOST/<file name>  (for example r2.bunnxr.com/charlie.zip)
// The URL never changes whatever expiry you pick, so the expiry lives on the server.
// Records are tiny JSON objects kept in the bucket itself (hidden folder .links/), so nothing extra to set up:
//   .links/n/<name>   name  -> { key, exp }      (used when the link is opened)
//   .links/k/<hash>   file  -> { name, key, exp } (used to show the current link of a file)
// exp is a unix time in seconds, or 0 for a link that never expires.
import { HttpError, validKey, sanitizeName } from "./util.js";
import { r2, r2Error, parseList } from "./r2.js";

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

// First unused address based on the file name: charlie.zip, then charlie-2.zip, charlie-3.zip …
// Existing links (even expired ones) are never taken over: each one is a separate link now.
async function freeName(c, key) {
  const base = sanitizeName(key.split("/").pop()).replace(/\s+/g, "-");
  const dot = base.lastIndexOf("."), stem = dot > 0 ? base.slice(0, dot) : base, ext = dot > 0 ? base.slice(dot) : "";
  for (let i = 1; i <= 30; i++) { // 30 keeps us under the Free plan's 50-subrequest cap
    const cand = i === 1 ? base : stem + "-" + i + ext;
    if (!(await read(c, nameObj(cand)))) return cand;
  }
  throw new HttpError(409, "Too many links use this file name. Pick a custom address instead.");
}

// The main link is the one the Share dialog shows and re-uses. Creating a link never touches the
// others, so a file can have any number of links, each with its own address and validity.
export async function createLink(c, key, seconds) {
  if (!c.PUBLIC_HOST) throw new HttpError(400, "Set PUBLIC_HOST in the config to create short links.");
  const exp = seconds > 0 ? Math.floor(Date.now() / 1000) + seconds : 0;
  const ko = await keyObj(key);
  let name = null;
  const prev = await read(c, ko);
  if (prev && prev.name) { // keep the same URL for this file's main link whenever it is still ours
    const n = await lookupLink(c, prev.name);
    if (!n || n.key === key) name = prev.name;
  }
  if (!name) name = await freeName(c, key);
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

// ---------------------------------------------------------------------
//  Links page: list every short link, change its expiry, address or file, delete it.
// ---------------------------------------------------------------------
const MAX_DAYS = 365;
const cleanName = (raw) => {
  const n = sanitizeName(String(raw ?? "").trim()).replace(/\s+/g, "-");
  if (!validKey(nameObj(n), "file") || n.length > 180) throw new HttpError(400, "That link name is not allowed.");
  return n;
};
const goodTarget = (k) => validKey(k, "file") && !k.startsWith(".trash/") && !k.startsWith(".links/") && !k.startsWith(".notes/");

// One page of links. 1 list + 2 calls per link keeps a page under the Free plan's 50-subrequest cap.
export async function listLinks(c, after) {
  const query = { "list-type": "2", "max-keys": "20", prefix: ".links/n/" };
  if (after) query["start-after"] = nameObj(after);
  const res = await r2(c, "GET", "", { query });
  if (!res.ok) throw new HttpError(502, r2Error(res));
  const p = parseList(res.text);
  const keys = p.files.map((f) => f.key);
  const links = await Promise.all(keys.map(async (obj) => {
    const name = obj.slice(nameObj("").length);
    const rec = await read(c, obj).catch(() => null);
    if (!rec || typeof rec.key !== "string") return { name, url: urlFor(c, name), key: "", exp: 0, t: 0, active: false, missing: true, size: 0 };
    const h = await r2(c, "HEAD", rec.key).catch(() => null);
    const missing = !h || h.status === 404;
    const size = h && h.ok ? Number(h.headers.get("content-length")) || 0 : 0;
    return { name, url: urlFor(c, name), key: rec.key, exp: rec.exp || 0, t: rec.t || 0, active: alive(rec), missing, size };
  }));
  return { links, next: p.truncated && keys.length ? keys[keys.length - 1].slice(nameObj("").length) : "" };
}

// b: { name, exp?, newName?, key? }   exp: unix seconds, 0 = never
export async function updateLink(c, b) {
  const name = String(b.name ?? "");
  if (!validKey(nameObj(name), "file")) throw new HttpError(400, "Invalid link.");
  const rec = await read(c, nameObj(name));
  if (!rec || typeof rec.key !== "string") throw new HttpError(404, "This link no longer exists.");
  const now = Math.floor(Date.now() / 1000);
  const out = { key: rec.key, exp: rec.exp || 0, t: rec.t || now };

  if (b.exp !== undefined) {
    const exp = Math.floor(Number(b.exp));
    if (!Number.isFinite(exp) || exp < 0 || exp > now + MAX_DAYS * 86400) throw new HttpError(400, "Pick an expiry within " + MAX_DAYS + " days, or never.");
    out.exp = exp;
  }
  if (b.key !== undefined && b.key !== rec.key) {
    if (!goodTarget(b.key)) throw new HttpError(400, "Invalid file.");
    const h = await r2(c, "HEAD", b.key);
    if (h.status === 404) throw new HttpError(404, "That file does not exist.");
    out.key = b.key;
  }
  let newName = name;
  if (b.newName !== undefined && b.newName !== name) {
    newName = cleanName(b.newName);
    if (newName !== name) {
      const other = await read(c, nameObj(newName));
      if (other && alive(other)) throw new HttpError(409, "Another link already uses “" + newName + "”.");
    }
  }

  await write(c, nameObj(newName), out);
  if (newName !== name) await drop(c, nameObj(name));
  // A renamed or re-pointed link stops being its file's main link, so the next "Share link"
  // makes a fresh link for that file instead of changing this one.
  if (newName !== name || out.key !== rec.key) {
    const ko = await keyObj(rec.key);
    const k = await read(c, ko);
    if (k && k.name === name) await drop(c, ko);
  }
  return { name: newName, url: urlFor(c, newName), key: out.key, exp: out.exp, t: out.t, active: alive(out) };
}

// An extra, separate link for a file. name "" = pick one from the file name.
export async function addLink(c, b) {
  if (!c.PUBLIC_HOST) throw new HttpError(400, "Set PUBLIC_HOST in the config to create short links.");
  const key = String(b.key ?? "");
  if (!goodTarget(key)) throw new HttpError(400, "Invalid file.");
  const now = Math.floor(Date.now() / 1000);
  const exp = Math.floor(Number(b.exp) || 0);
  if (exp < 0 || (exp && exp <= now) || exp > now + MAX_DAYS * 86400) throw new HttpError(400, "Pick an expiry within " + MAX_DAYS + " days, or never.");
  const h = await r2(c, "HEAD", key);
  if (h.status === 404) throw new HttpError(404, "That file does not exist.");
  let name;
  if (String(b.name ?? "").trim()) {
    name = cleanName(b.name);
    if (await read(c, nameObj(name))) throw new HttpError(409, "Another link already uses “" + name + "”. Delete it first or pick another address.");
  } else name = await freeName(c, key);
  const rec = { key, exp, t: now };
  await write(c, nameObj(name), rec);
  return { name, url: urlFor(c, name), key, exp, t: now, active: true, missing: false, size: Number(h.headers.get("content-length")) || 0 };
}

export async function deleteLink(c, name) {
  if (!validKey(nameObj(String(name ?? "")), "file")) throw new HttpError(400, "Invalid link.");
  const rec = await read(c, nameObj(name));
  await drop(c, nameObj(name));
  if (rec && typeof rec.key === "string") {
    const ko = await keyObj(rec.key);
    const k = await read(c, ko);
    if (k && k.name === name) await drop(c, ko);
  }
  return { ok: true };
}
