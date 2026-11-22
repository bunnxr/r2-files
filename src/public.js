// Everything served on PUBLIC_HOST (for example r2.bunnxr.com):
//   https://HOST/<name>                          short link (see links.js), optionally expiring
//   https://HOST/<folder>/<file>                 files inside a PUBLIC_FOLDERS folder
//   https://HOST/<folder>/<file>?e=<unix>&s=<sig>  older signed links (still honoured)
// The Worker checks the rules, then streams the file from R2 (range requests work, so video seeks).
import { validKey, isInternal, viewMime } from "./util.js";
import { presign, encPath } from "./sigv4.js";
import { contentDisposition } from "./uploads.js";
import { lookupLink, dropExpired } from "./links.js";

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

// Streams one object from R2 to the client. Used for public files and for the same-origin /api/read.
// view: show in the browser (inline, with a content type the browser understands)
async function streamObject(c, request, key, { dl, view, cache, cors }) {
  const query = {};
  const vmime = view && !dl ? viewMime(key.split("/").pop()) : "";
  if (dl) query["response-content-disposition"] = contentDisposition("attachment", key);
  else if (vmime) query["response-content-disposition"] = contentDisposition("inline", key);
  const upstream = await presign(c, request.method === "HEAD" ? "HEAD" : "GET", key, { query, expires: 300 });
  const h = {};
  for (const n of ["range", "if-none-match", "if-modified-since", "if-match", "if-range"]) { const v = request.headers.get(n); if (v) h[n] = v; }
  let res;
  try { res = await fetch(upstream, { method: request.method === "HEAD" ? "HEAD" : "GET", headers: h }); } catch (err) { return plain("Storage is unavailable.", 502); }
  if (res.status === 404) return plain("Not found", 404);
  if (res.status >= 400 && res.status !== 412 && res.status !== 416) return plain("Storage error.", 502);
  const out = new Headers();
  for (const n of ["content-type", "content-length", "content-range", "accept-ranges", "etag", "last-modified", "content-disposition"]) { const v = res.headers.get(n); if (v) out.set(n, v); }
  if (vmime) out.set("content-type", vmime);
  out.set("cache-control", cache);
  out.set("x-content-type-options", "nosniff");
  out.set("referrer-policy", "no-referrer");
  if (cors) out.set("access-control-allow-origin", "*");
  // HTML and SVG shown directly from the public host must not be able to run scripts
  if (cors && /^(text\/html|image\/svg\+xml|application\/xhtml)/i.test(out.get("content-type") || "")) out.set("content-security-policy", "sandbox; default-src 'none'; img-src * data:; style-src 'unsafe-inline'");
  return new Response(request.method === "HEAD" ? null : res.body, { status: res.status, headers: out });
}

// Same-origin read for the app itself (zip browsing, text viewer, zipping). No CORS on the bucket is needed for this.
export const proxyRead = (c, request, key) => streamObject(c, request, key, { dl: false, cache: "no-store", cors: false });

// ---------------------------------------------------------------------
//  Viewer page for short links opened in a tab: the site's logo as the tab icon and the file name as the
//  title. The page itself is empty apart from the file, shown full size (video / audio player,
//  image, PDF or text). The bunny logo matches public/favicon.ico and the app header.
// ---------------------------------------------------------------------
// The bunny (as in the shortener): deep teal on light tabs, brighter teal on dark ones; the ear twitches.
const BUNNY_ICON = "data:image/svg+xml," + encodeURIComponent("<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 40 40' fill='none' stroke='#0f766e' stroke-width='3.2' stroke-linecap='round'><style>@media (prefers-color-scheme:dark){svg{stroke:#4fd1bf}}.e{transform-box:fill-box;transform-origin:50% 100%;animation:t 7s 2.5s infinite}@keyframes t{0%,90%,100%{transform:rotate(0)}93%{transform:rotate(11deg)}96%{transform:rotate(-4deg)}}</style><path d='M15 24C9 14 11 3 16 4C20 5 19 15 19 24'/><path class='e' d='M25 24C31 14 29 3 24 4C20 5 21 15 21 24'/><rect x='9' y='24' width='22' height='11' rx='5.5'/></svg>");
const escHtml = (s) => String(s).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));

// Plays the bunny's ear twitch in the tab icon (Chrome / Edge don't animate tab icons themselves) by
// swapping the icon frame by frame; same bunny, colours and timing as the app (public/app.js, tabBunny).
const TAB_TWITCH = "(function(){var l=document.querySelector('link[rel=icon]');if(!l||matchMedia('(prefers-reduced-motion: reduce)').matches)return;" +
  "var dk=matchMedia('(prefers-color-scheme: dark)');" +
  "function ic(a){return 'data:image/svg+xml,'+encodeURIComponent(\"<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 40 40' fill='none' stroke='\"+(dk.matches?'#4fd1bf':'#0f766e')+\"' stroke-width='3.2' stroke-linecap='round'><path d='M15 24C9 14 11 3 16 4C20 5 19 15 19 24'/><path transform='rotate(\"+a+\" 25.2 24)' d='M25 24C31 14 29 3 24 4C20 5 21 15 21 24'/><rect x='9' y='24' width='22' height='11' rx='5.5'/></svg>\")}" +
  "var K=[[0,0],[210,11],[420,-4],[700,0]];function ang(t){for(var i=1;i<K.length;i++)if(t<=K[i][0])return K[i-1][1]+(K[i][1]-K[i-1][1])*(t-K[i-1][0])/(K[i][0]-K[i-1][0]);return 0}" +
  "function tw(){var s=performance.now();(function f(){var t=performance.now()-s;l.href=ic(ang(t).toFixed(1));if(t<700)setTimeout(f,40)})()}" +
  "l.href=ic(0);dk.addEventListener('change',function(){l.href=ic(0)});setTimeout(function lp(){tw();setTimeout(lp,3000)},1000)})();";

// Sub-requests a view-only file may be loaded by (from the viewer page). "empty" covers the
// follow-up range requests some built-in viewers make (e.g. large PDFs).
const VIEW_DESTS = new Set(["video", "audio", "image", "iframe", "embed", "object", "empty"]);

// guard: view-only link. Hides the download / picture-in-picture options, turns off right-click and
// the long-press menu, and hides the PDF toolbar (Chrome / Edge honour #toolbar=0).
function viewerPage(key, cache, guard) {
  const name = key.split("/").pop(), mime = viewMime(name);
  if (!mime || /^text\/html/.test(mime)) return null; // HTML files show themselves (sandboxed)
  const n = escHtml(name);
  const media = guard ? ' controlslist="nodownload noremoteplayback noplaybackrate" disablepictureinpicture disableremoteplayback' : '';
  let body;
  if (mime.startsWith("video/")) body = '<video src="?raw=1" controls autoplay playsinline preload="metadata"' + media + '></video>';
  else if (mime.startsWith("audio/")) body = '<audio src="?raw=1" controls autoplay preload="metadata"' + media + '></audio>';
  else if (mime.startsWith("image/")) body = '<img src="?raw=1" alt="' + n + '"' + (guard ? ' draggable="false"' : '') + '>';
  else body = '<iframe src="?raw=1' + (guard && mime === "application/pdf" ? '#toolbar=0&amp;navpanes=0' : '') + '" title="' + n + '"></iframe>'; // PDF, text, JSON …
  const nonce = crypto.randomUUID().replace(/-/g, "");
  const script = '<script nonce="' + nonce + '">' + TAB_TWITCH + (guard ? 'addEventListener("contextmenu",function(e){e.preventDefault()});addEventListener("dragstart",function(e){e.preventDefault()});addEventListener("keydown",function(e){if((e.ctrlKey||e.metaKey)&&(e.key==="s"||e.key==="S"))e.preventDefault()})' : '') + '</script>';
  const html = '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>' + n + '</title><link rel="icon" type="image/svg+xml" href="' + BUNNY_ICON + '"><link rel="alternate icon" href="/favicon.ico">' +
    '<meta name="robots" content="noindex"><meta name="theme-color" content="#121514"><style>' +
    'html,body{height:100%;margin:0}body{display:flex;flex-direction:column;background:#121514;color:#e9ecea;font:500 14px/1.4 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}' +
    'main{flex:1;min-height:0;display:flex;align-items:center;justify-content:center}' +
    'video,img{max-width:100%;max-height:100%;display:block}iframe{width:100%;height:100%;border:0;background:#fff}' +
    'audio{width:min(420px,90vw)}' +
    (guard ? 'video,img,audio{-webkit-touch-callout:none;-webkit-user-select:none;user-select:none}img{pointer-events:none}' : '') +
    '</style>' + script + '</head><body><main>' + body + '</main></body></html>';
  return new Response(html, { headers: {
    "content-type": "text/html; charset=utf-8", "cache-control": guard ? "private, no-store" : cache, "x-content-type-options": "nosniff", "referrer-policy": "no-referrer",
    "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; media-src 'self'; frame-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; script-src 'nonce-" + nonce + "'",
    "vary": "Sec-Fetch-Dest, Sec-Fetch-Site",
  } });
}

// shortOnly: on LINK_HOST (bunnxr.com, reached through the shortener) only short links are served
export async function servePublic(request, c, url, { shortOnly } = {}) {
  if (request.method !== "GET" && request.method !== "HEAD") return new Response("Method not allowed", { status: 405, headers: { allow: "GET, HEAD" } });
  let path;
  try { path = decodeURIComponent(url.pathname.slice(1)); } catch (e) { return plain("Not found", 404); }
  if (!path) return plain("Not found", 404);
  const dl = url.searchParams.get("dl") === "1";

  if (path.indexOf("/") < 0) { // short link: https://HOST/charlie.zip
    const rec = await lookupLink(c, path);
    if (!rec) return plain("This link does not exist or has expired.", 404);
    if (rec.exp && rec.exp * 1000 < Date.now()) { await dropExpired(c, path); return plain("This link has expired.", 410); }
    const cache = rec.exp ? "private, max-age=0, must-revalidate" : "public, max-age=300";
    const raw = url.searchParams.has("raw");

    // View links are view-only: the file is handed out only to the viewer page's own player / image / frame
    // (a same-site sub-request), never to a tab, a download (?dl=1 is ignored), another site, curl or a bot.
    // This stops casual saving; it cannot stop someone determined (developer tools, screen recording).
    if (rec.mode === "view") {
      const dest = request.headers.get("sec-fetch-dest") || "", site = request.headers.get("sec-fetch-site") || "";
      if (dest === "document") {
        const page = viewerPage(rec.key, cache, true);
        if (page) return page;
        // not something a browser can show by itself (e.g. an HTML file): serve it as is, sandboxed
      } else if ((site !== "same-origin" && site !== "none") || !VIEW_DESTS.has(dest)) { // "none": requests made by the browser itself (built-in PDF viewer)
        return plain("This file can only be viewed in the browser, at its link.", 403);
      }
      const res = await streamObject(c, request, rec.key, { dl: false, view: true, cors: true, cache: "private, no-store" }); // cors: true also keeps HTML / SVG sandboxed
      res.headers.set("vary", "Sec-Fetch-Dest, Sec-Fetch-Site");
      return res;
    }

    // Someone opened a viewable link in a browser tab: wrap the file in a small page of our own, so the tab
    // carries the site's logo and the file name. The page loads the file itself from ?raw=1. Everything else
    // (video players, <img> embeds, iframes, curl, link-preview bots, ?dl=1) still gets the bare file.
    if (!dl && !raw && rec.mode !== "download" && request.method === "GET" && request.headers.get("sec-fetch-dest") === "document") {
      const page = viewerPage(rec.key, cache);
      if (page) return page;
    }
    // mode "download" always downloads; "view" opens in the browser (?dl=1 still downloads); no mode = browser decides
    const res = await streamObject(c, request, rec.key, { dl: dl || rec.mode === "download", view: rec.mode === "view" || raw, cors: true, cache });
    res.headers.set("vary", "Sec-Fetch-Dest"); // same URL serves the viewer page to tabs, so caches must keep them apart
    return res;
  }

  if (shortOnly) return plain("Not found", 404);
  const key = path;
  if (!validKey(key, "file") || key.startsWith(".trash/") || isInternal(key)) return plain("Not found", 404);
  const e = url.searchParams.get("e"), s = url.searchParams.get("s");
  const signed = !!(e && s);
  if (signed) {
    const v = await verifyShare(c, key, e, s);
    if (v !== "ok") return plain(v === "expired" ? "This link has expired." : "This link is not valid.", 403);
  } else if (!isPublicKey(c, key)) return plain("Not found", 404);
  return streamObject(c, request, key, { dl, cors: true, cache: signed ? "private, max-age=0, must-revalidate" : "public, max-age=300" });
}
