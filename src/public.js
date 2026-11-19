// Public files and expiring share links, served on PUBLIC_HOST (for example r2.bunnxr.com).
//   https://HOST/<folder>/<file>                 works for files inside a PUBLIC_FOLDERS folder
//   https://HOST/<folder>/<file>?e=<unix>&s=<sig>  works for ANY file until it expires
// The Worker checks the rules, then streams the file from R2 (range requests work, so video seeks).
import { validKey } from "./util.js";
import { presign, encPath } from "./sigv4.js";
import { contentDisposition } from "./uploads.js";

const enc = new TextEncoder();
const b64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64u = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (ch) => ch.charCodeAt(0));

// Links are signed with a key derived from SECRET_ACCESS_KEY (changing that secret invalidates all links)
async function shareKey(c) {
  const root = await crypto.subtle.importKey("raw", enc.encode(c.SECRET_ACCESS_KEY), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const raw = await crypto.subtle.sign("HMAC", root, enc.encode("r2-file-manager/share-link/v1"));
  return crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}
const signShare = async (c, key, exp) => b64u(await crypto.subtle.sign("HMAC", await shareKey(c), enc.encode(key + "\n" + exp)));
async function verifyShare(c, key, exp, sig) {
  const e = Number(exp);
  if (!Number.isInteger(e) || e * 1000 < Date.now()) return "expired";
  try {
    return (await crypto.subtle.verify("HMAC", await shareKey(c), unb64u(sig), enc.encode(key + "\n" + e))) ? "ok" : "bad";
  } catch (err) { return "bad"; }
}

export const isPublicKey = (c, key) => c.PUBLIC_FOLDER_LIST.some((p) => key.startsWith(p));

// Link for the "Copy link" button: on PUBLIC_HOST when configured, otherwise a plain R2 signed URL
export async function shareUrl(c, key, seconds) {
  const exp = Math.floor(Date.now() / 1000) + seconds;
  if (c.PUBLIC_HOST) {
    return { url: "https://" + c.PUBLIC_HOST + "/" + encPath(key) + "?e=" + exp + "&s=" + (await signShare(c, key, exp)), expires: exp };
  }
  return { url: await presign(c, "GET", key, { expires: seconds }), expires: exp };
}

const plain = (text, status) => new Response(text, { status, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" } });

export async function servePublic(request, c, url) {
  if (request.method !== "GET" && request.method !== "HEAD") return new Response("Method not allowed", { status: 405, headers: { allow: "GET, HEAD" } });
  let key;
  try { key = decodeURIComponent(url.pathname.slice(1)); } catch (e) { return plain("Not found", 404); }
  if (!validKey(key, "file") || key.startsWith(".trash/")) return plain("Not found", 404);

  const e = url.searchParams.get("e"), s = url.searchParams.get("s");
  const signed = !!(e && s);
  if (signed) {
    const v = await verifyShare(c, key, e, s);
    if (v !== "ok") return plain(v === "expired" ? "This link has expired." : "This link is not valid.", 403);
  } else if (!isPublicKey(c, key)) return plain("Not found", 404);

  const query = {};
  if (url.searchParams.get("dl") === "1") query["response-content-disposition"] = contentDisposition("attachment", key);
  const upstream = await presign(c, request.method, key, { query, expires: 300 });
  const h = {};
  for (const n of ["range", "if-none-match", "if-modified-since", "if-match", "if-range"]) { const v = request.headers.get(n); if (v) h[n] = v; }
  let res;
  try { res = await fetch(upstream, { method: request.method, headers: h }); } catch (err) { return plain("Storage is unavailable.", 502); }
  if (res.status === 404) return plain("Not found", 404);
  if (res.status >= 400 && res.status !== 412 && res.status !== 416) return plain("Storage error.", 502);

  const out = new Headers();
  for (const n of ["content-type", "content-length", "content-range", "accept-ranges", "etag", "last-modified", "content-disposition"]) { const v = res.headers.get(n); if (v) out.set(n, v); }
  out.set("cache-control", signed ? "private, max-age=0, must-revalidate" : "public, max-age=300");
  out.set("x-content-type-options", "nosniff");
  out.set("referrer-policy", "no-referrer");
  out.set("access-control-allow-origin", "*");
  // HTML and SVG shown directly from this host must not be able to run scripts
  if (/^(text\/html|image\/svg\+xml|application\/xhtml)/i.test(out.get("content-type") || "")) out.set("content-security-policy", "sandbox; default-src 'none'; img-src * data:; style-src 'unsafe-inline'");
  return new Response(request.method === "HEAD" ? null : res.body, { status: res.status, headers: out });
}
