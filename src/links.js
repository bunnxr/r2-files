// Short links: https://PUBLIC_HOST/<file name>  (for example r2.bunnxr.com/charlie.zip)
// The URL never changes whatever expiry you pick, so the expiry lives on the server.
// Records are tiny JSON objects kept in the bucket itself (hidden folder .links/), so nothing extra to set up:
//   .links/n/<name>   name  -> { key, exp, mode? }   (used when the link is opened)
//   .links/k/<hash>   file  -> { name, key, exp, dl? } (the file's main link for the Share dialog;
//                                                     dl = its separate download link, if any)
// exp is a unix time in seconds, or 0 for a link that never expires.
// mode: "view" = open in the browser, "download" = always download, none = browser decides.
import { HttpError, validKey, sanitizeName, isInternal } from "./util.js";
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

// First unused address based on the file name: charlie.zip, then charlie-2.zip, charlie-3.zip …
// Existing links (even expired ones) are never taken over: each one is a separate link now.
async function freeName(c, key, suffix) {
  const file = sanitizeName(key.split("/").pop()).replace(/\s+/g, "-");
  const dot = file.lastIndexOf("."), stem = (dot > 0 ? file.slice(0, dot) : file) + (suffix || ""), ext = dot > 0 ? file.slice(dot) : "";
  for (let i = 1; i <= 25; i++) { // 25 keeps us under the Free plan's 50-subrequest cap
    const cand = i === 1 ? stem + ext : stem + "-" + i + ext;
    if (!(await read(c, nameObj(cand)))) return cand;
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
    if (!n || n.key === key) name = prev.name;
  }
  if (!name) name = await freeName(c, key);
  const now = Math.floor(Date.now() / 1000);
  const rec = withMode({ key, exp, t: now }, mode === "both" ? "view" : mode);
  await write(c, nameObj(name), rec);
  const ptr = { name, key, exp, t: now };
  let dl = null;
  if (prev && prev.dl) ptr.dl = prev.dl; // remember the download companion even when not asked for now
  if (mode === "both") {
    let dn = null;
    if (prev && prev.dl && prev.dl !== name) { const n = await lookupLink(c, prev.dl); if (!n || n.key === key) dn = prev.dl; }
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
  await drop(c, ko);
  return { ok: true };
}
// A link stops being its file's main link (renamed, re-pointed or deleted). The pointer to the
// download companion is kept, so "Both" re-uses charlie-download.pdf instead of making -2.
async function unsetMain(c, key, name) {
  const ko = await keyObj(key);
  const k = await read(c, ko);
  if (!k || k.name !== name) return;
  if (k.dl && k.dl !== name) await write(c, ko, { key, dl: k.dl }); else await drop(c, ko);
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
const goodTarget = (k) => validKey(k, "file") && !k.startsWith(".trash/") && !isInternal(k);

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
    return { name, url: urlFor(c, name), key: rec.key, exp: rec.exp || 0, t: rec.t || 0, active: alive(rec), missing, size, mode: rec.mode || "auto" };
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
  const out = withMode({ key: rec.key, exp: rec.exp || 0, t: rec.t || now }, b.mode !== undefined ? b.mode : rec.mode);

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
  if (newName !== name || out.key !== rec.key) await unsetMain(c, rec.key, name);
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
  const h = await r2(c, "HEAD", key);
  if (h.status === 404) throw new HttpError(404, "That file does not exist.");
  let name;
  if (String(b.name ?? "").trim()) {
    name = cleanName(b.name);
    if (await read(c, nameObj(name))) throw new HttpError(409, "Another link already uses “" + name + "”. Delete it first or pick another address.");
  } else name = await freeName(c, key, b.mode === "download" ? "-download" : "");
  const rec = withMode({ key, exp, t: now }, b.mode);
  await write(c, nameObj(name), rec);
  return { name, url: urlFor(c, name), key, exp, t: now, active: true, missing: false, size: Number(h.headers.get("content-length")) || 0, mode: rec.mode || "auto" };
}

export async function deleteLink(c, name) {
  if (!validKey(nameObj(String(name ?? "")), "file")) throw new HttpError(400, "Invalid link.");
  const rec = await read(c, nameObj(name));
  await drop(c, nameObj(name));
  if (rec && typeof rec.key === "string") await unsetMain(c, rec.key, name);
  return { ok: true };
}
