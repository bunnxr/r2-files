// Short links: https://PUBLIC_HOST/<file name>  (for example r2.bunnxr.com/charlie.zip)
// The URL never changes whatever expiry you pick, so the expiry lives on the server.
// Records are tiny JSON objects kept in the bucket itself (hidden folder .links/), so nothing extra to set up:
//   .links/n/<name>   name  -> { key, exp, mode? }   (used when the link is opened)
//   .links/k/<hash>   file  -> { name, key, exp, dl?, x? } (the file's main link for the Share dialog;
//                                                     dl = its separate download link, if any;
//                                                     x = its other links, so they follow the file when it moves)
// The file key is a path: it may be in R2 or on Zenith ("zenith:/…"); the records always live in R2.
// exp is a unix time in seconds, or 0 for a link that never expires.
// mode: "view" = open in the browser, "download" = always download, none = browser decides.
import { HttpError, validKey, sanitizeName, isInternal } from "./util.js";
import { sys, store } from "./storage/index.js";

const enc = new TextEncoder();
const hex = (b) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
const nameObj = (n) => ".links/n/" + n;
const keyObj = async (k) => ".links/k/" + hex(await crypto.subtle.digest("SHA-256", enc.encode(k))).slice(0, 32);
const alive = (r) => !!r && (!r.exp || r.exp * 1000 > Date.now());
// Every link works on both LINK_HOST (bunnxr.com, via the shortener) and PUBLIC_HOST (r2.bunnxr.com);
// the address shown and copied uses LINK_HOST.
const urlFor = (c, name) => "https://" + (c.LINK_HOST || c.PUBLIC_HOST) + "/" + encodeURIComponent(name);

async function read(c, obj) {
  const text = await sys(c).read(obj);
  if (text === null) return null;
  try { return JSON.parse(text); } catch (e) { return null; }
}
async function write(c, obj, rec) {
  await sys(c).write(obj, JSON.stringify(rec), "application/json");
}
async function drop(c, obj) { await sys(c).remove(obj); }

export async function lookupLink(c, name) {
  if (!validKey(nameObj(name), "file")) return null;
  const r = await read(c, nameObj(name));
  const ok = r && typeof r.key === "string" && validKey(r.key, "file") && !r.key.startsWith(".trash/") && !isInternal(r.key);
  return ok ? r : null;
}

export async function linkInfo(c, key) {
  const k = await read(c, await keyObj(key));
  if (!k || !k.name) return { exists: false };
  const n = await lookupLink(c, k.name);
  if (!n || n.key !== key) return { exists: false };
  const out = { exists: true, active: alive(n), name: k.name, url: urlFor(c, k.name), exp: n.exp || 0, mode: n.mode || "auto", dl: null };
  if (k.dl && k.dl !== k.name) {
    const d = await lookupLink(c, k.dl);
    if (d && d.key === key) out.dl = { name: k.dl, url: urlFor(c, k.dl), exp: d.exp || 0, active: alive(d) };
  }
  return out;
}

// Does the shortener Worker already use this back-half on bunnxr.com? It looks names up in lower
// case and ignores names starting with "_", so the same rules apply here.
async function inShortener(c, name) {
  if (!c.SHORTENER_KV || !name || name.startsWith("_")) return false;
  try { return (await c.SHORTENER_KV.get(name.toLowerCase())) !== null; } catch (e) { return false; }
}
const shortenerTaken = (c, name) => new HttpError(409, (c.LINK_HOST || c.PUBLIC_HOST) + "/" + name + " already exists in your link shortener. Pick another address.");

// Addresses a link may never use: the browser asks every domain for /favicon.ico (served by worker.js)
const RESERVED = new Set(["favicon.ico"]);

// First unused address based on the file name: charlie.zip, then charlie-2.zip, charlie-3.zip …
// Existing links (even expired ones) are never taken over: each one is a separate link now.
async function freeName(c, key, suffix) {
  const file = sanitizeName(key.split("/").pop()).replace(/\s+/g, "-");
  const dot = file.lastIndexOf("."), stem = (dot > 0 ? file.slice(0, dot) : file) + (suffix || ""), ext = dot > 0 ? file.slice(dot) : "";
  for (let i = 1; i <= 25; i++) { // 25 keeps us under the Free plan's 50-subrequest cap
    const cand = i === 1 ? stem + ext : stem + "-" + i + ext;
    if (!RESERVED.has(cand.toLowerCase()) && !(await read(c, nameObj(cand))) && !(await inShortener(c, cand))) return cand;
  }
  throw new HttpError(409, "Too many links use this file name. Pick a custom address instead.");
}

// The main link is the one the Share dialog shows and re-uses. Creating a link never touches the
// others, so a file can have any number of links, each with its own address and validity.
// mode: "view" (open in the browser), "download", "both" (a view link plus a separate
// download link, e.g. charlie-download.pdf), or anything else = browser decides (old behaviour).
export async function createLink(c, key, seconds, mode) {
  if (!c.PUBLIC_HOST) throw new HttpError(400, "Set PUBLIC_HOST in the config to create short links.");
  const exp = seconds > 0 ? Math.floor(Date.now() / 1000) + seconds : 0;
  const ko = await keyObj(key);
  let name = null;
  const prev = await read(c, ko);
  if (prev && prev.name) { // keep the same URL for this file's main link whenever it is still ours
    const n = await lookupLink(c, prev.name);
    if ((!n || n.key === key) && !(await inShortener(c, prev.name))) name = prev.name;
  }
  if (!name) name = await freeName(c, key);
  const now = Math.floor(Date.now() / 1000);
  const rec = withMode({ key, exp, t: now }, mode === "both" ? "view" : mode);
  await write(c, nameObj(name), rec);
  const ptr = { name, key, exp, t: now };
  let dl = null;
  if (prev && prev.dl) ptr.dl = prev.dl; // remember the download companion even when not asked for now
  if (prev && Array.isArray(prev.x)) ptr.x = prev.x;
  if (mode === "both") {
    let dn = null;
    if (prev && prev.dl && prev.dl !== name) { const n = await lookupLink(c, prev.dl); if ((!n || n.key === key) && !(await inShortener(c, prev.dl))) dn = prev.dl; }
    if (!dn) dn = await freeName(c, key, "-download");
    await write(c, nameObj(dn), { key, exp, t: now, mode: "download" });
    ptr.dl = dn;
    dl = { name: dn, url: urlFor(c, dn) };
  }
  await write(c, ko, ptr);
  return { name, url: urlFor(c, name), exp, mode: rec.mode || "auto", dl };
}
const MODES = ["view", "download"];
function withMode(rec, mode) { if (MODES.includes(mode)) rec.mode = mode; else delete rec.mode; return rec; }

// "Remove link" in the Share dialog: the main link and its download companion
export async function removeLink(c, key) {
  const ko = await keyObj(key);
  const k = await read(c, ko);
  for (const nm of [k && k.name, k && k.dl]) {
    if (!nm) continue;
    const n = await lookupLink(c, nm);
    if (n && n.key === key) await drop(c, nameObj(nm));
  }
  if (k && Array.isArray(k.x) && k.x.length) await write(c, ko, { key, x: k.x }); else await drop(c, ko);
  return { ok: true };
}
// A link stops being its file's main link (renamed, re-pointed or deleted). The pointer to the
// download companion is kept, so "Both" re-uses charlie-download.pdf instead of making -2.
async function unsetMain(c, key, name) {
  const ko = await keyObj(key);
  const k = await read(c, ko);
  if (!k || k.name !== name) return;
  const rest = { key };
  if (k.dl && k.dl !== name) rest.dl = k.dl;
  if (Array.isArray(k.x) && k.x.length) rest.x = k.x;
  if (rest.dl || rest.x) await write(c, ko, rest); else await drop(c, ko);
}

// Remember a link on its file's pointer (field x), so the link follows the file when it is moved
const MAX_X = 40;
async function remember(c, key, name) {
  try {
    const ko = await keyObj(key);
    const k = (await read(c, ko)) || { key };
    const x = Array.isArray(k.x) ? k.x.filter((n) => n !== name) : [];
    x.push(name);
    k.x = x.slice(-MAX_X);
    await write(c, ko, k);
  } catch (e) { /* best effort: the link itself is saved */ }
}

// A file was moved (in R2, on Zenith or between the two): its links now open it at the new path.
// pairs: [{ from, to, keep }]; copies (keep) are skipped, the original keeps its links.
// Best effort, like notes: a failure never undoes the move.
export async function carryLinks(c, pairs) {
  if (!c.PUBLIC_HOST) return;
  for (const p of pairs) {
    if (p.keep || p.from === p.to) continue;
    try {
      const ko = await keyObj(p.from);
      const k = await read(c, ko);
      if (!k) continue;
      const names = [...new Set([k.name, k.dl].concat(Array.isArray(k.x) ? k.x : []))].filter((n) => typeof n === "string" && n);
      const moved = [];
      for (const nm of names) {
        const rec = await read(c, nameObj(nm));
        if (rec && rec.key === p.from) { rec.key = p.to; await write(c, nameObj(nm), rec); moved.push(nm); }
      }
      const ptr = Object.assign({}, k, { key: p.to });
      if (Array.isArray(k.x)) ptr.x = k.x.filter((n) => moved.includes(n));
      await write(c, await keyObj(p.to), ptr);
      await drop(c, ko);
    } catch (e) { /* best effort */ }
  }
}

// ---------------------------------------------------------------------
//  Links page: list every short link, change its expiry, address or file, delete it.
// ---------------------------------------------------------------------
const MAX_DAYS = 365;
const cleanName = (raw) => {
  const n = sanitizeName(String(raw ?? "").trim()).replace(/\s+/g, "-");
  if (!validKey(nameObj(n), "file") || n.length > 180 || RESERVED.has(n.toLowerCase())) throw new HttpError(400, "That link name is not allowed.");
  return n;
};
const goodTarget = (k) => validKey(k, "file") && !k.startsWith(".trash/") && !isInternal(k);

// One page of links. 1 list + 2 calls per link keeps a page under the Free plan's 50-subrequest cap.
export async function listLinks(c, after) {
  const p = await sys(c).listPage({ prefix: ".links/n/", maxKeys: 20, startAfter: after ? nameObj(after) : undefined });
  const keys = p.files.map((f) => f.key);
  const links = await Promise.all(keys.map(async (obj) => {
    const name = obj.slice(nameObj("").length);
    const rec = await read(c, obj).catch(() => null);
    if (!rec || typeof rec.key !== "string") return { name, url: urlFor(c, name), key: "", exp: 0, t: 0, active: false, missing: true, size: 0 };
    if (!alive(rec)) { await drop(c, obj).catch(() => {}); return null; } // expired links are deleted, not listed
    const h = await store(c).head(rec.key).catch(() => null); // the file may be in R2 or on Zenith
    const missing = !h || h.status === 404;
    const size = h && h.ok ? Number(h.headers.get("content-length")) || 0 : 0;
    return { name, url: urlFor(c, name), key: rec.key, exp: rec.exp || 0, t: rec.t || 0, active: alive(rec), missing, size, mode: rec.mode || "auto" };
  }));
  return { links: links.filter(Boolean), next: p.truncated && keys.length ? keys[keys.length - 1].slice(nameObj("").length) : "" };
}

// b: { name, exp?, newName?, key? }   exp: unix seconds, 0 = never
export async function updateLink(c, b) {
  const name = String(b.name ?? "");
  if (!validKey(nameObj(name), "file")) throw new HttpError(400, "Invalid link.");
  const rec = await read(c, nameObj(name));
  if (!rec || typeof rec.key !== "string") throw new HttpError(404, "This link no longer exists.");
  const now = Math.floor(Date.now() / 1000);
  const out = withMode({ key: rec.key, exp: rec.exp || 0, t: rec.t || now }, b.mode !== undefined ? b.mode : rec.mode);

  if (b.exp !== undefined) {
    const exp = Math.floor(Number(b.exp));
    if (!Number.isFinite(exp) || exp < 0 || (exp && exp <= now) || exp > now + MAX_DAYS * 86400) throw new HttpError(400, "Pick an expiry in the future, within " + MAX_DAYS + " days, or never.");
    out.exp = exp;
  }
  if (b.key !== undefined && b.key !== rec.key) {
    if (!goodTarget(b.key)) throw new HttpError(400, "Invalid file.");
    const h = await store(c).head(b.key);
    if (h.status === 404) throw new HttpError(404, "That file does not exist.");
    out.key = b.key;
  }
  let newName = name;
  if (b.newName !== undefined && b.newName !== name) {
    newName = cleanName(b.newName);
    if (newName !== name) {
      if (await inShortener(c, newName)) throw shortenerTaken(c, newName);
      const other = await read(c, nameObj(newName));
      if (other && alive(other)) throw new HttpError(409, "Another link already uses “" + newName + "”.");
    }
  }

  await write(c, nameObj(newName), out);
  if (newName !== name) await drop(c, nameObj(name));
  // A renamed or re-pointed link stops being its file's main link, so the next "Share link"
  // makes a fresh link for that file instead of changing this one.
  if (newName !== name || out.key !== rec.key) { await unsetMain(c, rec.key, name); await remember(c, out.key, newName); }
  return { name: newName, url: urlFor(c, newName), key: out.key, exp: out.exp, t: out.t, active: alive(out), mode: out.mode || "auto" };
}

// An extra, separate link for a file. name "" = pick one from the file name.
export async function addLink(c, b) {
  if (!c.PUBLIC_HOST) throw new HttpError(400, "Set PUBLIC_HOST in the config to create short links.");
  const key = String(b.key ?? "");
  if (!goodTarget(key)) throw new HttpError(400, "Invalid file.");
  const now = Math.floor(Date.now() / 1000);
  const exp = Math.floor(Number(b.exp) || 0);
  if (exp < 0 || (exp && exp <= now) || exp > now + MAX_DAYS * 86400) throw new HttpError(400, "Pick an expiry within " + MAX_DAYS + " days, or never.");
  const h = await store(c).head(key);
  if (h.status === 404) throw new HttpError(404, "That file does not exist.");
  let name;
  if (String(b.name ?? "").trim()) {
    name = cleanName(b.name);
    if (await inShortener(c, name)) throw shortenerTaken(c, name);
    if (await read(c, nameObj(name))) throw new HttpError(409, "Another link already uses “" + name + "”. Delete it first or pick another address.");
  } else name = await freeName(c, key, b.mode === "download" ? "-download" : "");
  const rec = withMode({ key, exp, t: now }, b.mode);
  await write(c, nameObj(name), rec);
  await remember(c, key, name);
  return { name, url: urlFor(c, name), key, exp, t: now, active: true, missing: false, size: Number(h.headers.get("content-length")) || 0, mode: rec.mode || "auto" };
}

// An expired link was opened: remove its record (the file's main-link pointer is left; it is
// harmless, and Share re-uses that address for the next link of the same file).
export async function dropExpired(c, name) {
  await drop(c, nameObj(name)).catch(() => {});
}

// Hourly cron (:30): delete expired links nobody opened. Works through the links a slice at a time
// (remembering where it stopped in .links/sweep.json) to stay under the 50-subrequest cap.
const SWEEP = ".links/sweep.json";
export async function sweepExpired(c) {
  const cur = (await read(c, SWEEP).catch(() => null)) || {};
  // 1 + 1 + 22 reads + up to 22 deletes + 1 = 47 subrequests
  const p = await sys(c).listPage({ prefix: ".links/n/", maxKeys: 22, startAfter: cur.after || undefined });
  const keys = p.files.map((f) => f.key);
  let deleted = 0;
  await Promise.all(keys.map(async (obj) => {
    const rec = await read(c, obj).catch(() => null);
    if (rec && !alive(rec)) { await drop(c, obj).catch(() => {}); deleted++; }
  }));
  // next run continues after this slice; at the end of the list it starts again from the top
  await write(c, SWEEP, { after: p.truncated && keys.length ? keys[keys.length - 1] : "", t: Date.now() });
  return { checked: keys.length, deleted };
}

export async function deleteLink(c, name) {
  if (!validKey(nameObj(String(name ?? "")), "file")) throw new HttpError(400, "Invalid link.");
  const rec = await read(c, nameObj(name));
  await drop(c, nameObj(name));
  if (rec && typeof rec.key === "string") await unsetMain(c, rec.key, name);
  return { ok: true };
}
