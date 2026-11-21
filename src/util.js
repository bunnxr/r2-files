// ---------------------------------------------------------------------
//  Small helpers
// ---------------------------------------------------------------------
class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const escHtml = (s) => String(s).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
const safeColor = (v, fallback) => (/^#[0-9a-fA-F]{3,8}$/.test(v) ? v : fallback);

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

async function readJson(request) {
  try {
    const b = await request.json();
    if (b && typeof b === "object") return b;
  } catch (e) { /* fall through */ }
  throw new HttpError(400, "Invalid request body.");
}

const fmtBytes = (n) => {
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (n >= 1024 && i < 4) { n /= 1024; i++; }
  return (i === 0 ? n : Math.round(n * 10) / 10) + " " + u[i];
};

// ---------------------------------------------------------------------
//  Key validation and name sanitising (no path tricks)
// ---------------------------------------------------------------------
function validKey(k, kind) {
  if (typeof k !== "string" || !k || new TextEncoder().encode(k).length > 1024) return false;
  if (/[\u0000-\u001f\u007f\\]/.test(k) || k.startsWith("/")) return false;
  const isFolder = k.endsWith("/");
  if (kind === "file" && isFolder) return false;
  if (kind === "folder" && !isFolder) return false;
  const segs = k.split("/");
  if (isFolder) segs.pop();
  return segs.every((s) => s.length > 0 && s !== "." && s !== "..");
}
const validPrefix = (p) => p === "" || validKey(p, "folder");

function sanitizeName(raw) {
  let n = String(raw ?? "").normalize("NFC").replace(/[\u0000-\u001f\u007f\\/<>:"|?*]/g, "_").trim().replace(/[. ]+$/, "");
  if (!n || /^\.+$/.test(n)) n = "file";
  if (n.length > 180) {
    const dot = n.lastIndexOf(".");
    const ext = dot > 0 && n.length - dot <= 16 ? n.slice(dot) : "";
    n = n.slice(0, 180 - ext.length) + ext;
  }
  return n;
}


// ---------------------------------------------------------------------
//  Hidden housekeeping prefixes
//  Objects under these are never listed and can never be moved, copied,
//  deleted, trashed, shared or written through the API or the public host.
//    .links/   short-link records      .notes/  per-file notes
//    .system/  settings (upload password)
// ---------------------------------------------------------------------
const INTERNAL = [".links/", ".notes/", ".system/"];
const isInternal = (k) => typeof k === "string" && INTERNAL.some((p) => k.startsWith(p));

// ---------------------------------------------------------------------
//  Structured logging for Cloudflare Observability
//  One JSON object per line so the dashboard can filter on `event`,
//  e.g.  event:cli.verify.fail
// ---------------------------------------------------------------------
function logEvent(event, fields) {
  try {
    console.log(JSON.stringify(Object.assign({ event, time: new Date().toISOString() }, fields || {})));
  } catch (e) { /* logging must never break a request */ }
}

// File categories (used for the storage breakdown and the sidebar views)
const TYPE_EXT = {
  image: "jpg jpeg png gif webp avif svg bmp heic heif ico tif tiff",
  video: "mp4 mov m4v webm mkv avi wmv",
  audio: "mp3 wav flac aac m4a ogg opus",
  archive: "zip rar 7z tar gz tgz bz2 xz",
  doc: "pdf doc docx odt rtf txt md pages ppt pptx key xls xlsx csv tsv ods numbers",
};
const TYPES = ["image", "video", "audio", "doc", "archive", "other", "trash"];
function typeOf(key) {
  if (key.startsWith(".trash/")) return "trash";
  const n = key.split("/").pop();
  const i = n.lastIndexOf(".");
  const e = i > 0 ? n.slice(i + 1).toLowerCase() : "";
  for (const t of Object.keys(TYPE_EXT)) if (e && (" " + TYPE_EXT[t] + " ").includes(" " + e + " ")) return t;
  return "other";
}

// Files a browser can show by itself. A "view" link serves these inline with this content type,
// so they open in the tab instead of downloading (even if they were uploaded as octet-stream).
const VIEW_MIME = {
  pdf: "application/pdf",
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp", avif: "image/avif", svg: "image/svg+xml", bmp: "image/bmp", ico: "image/x-icon",
  mp4: "video/mp4", m4v: "video/mp4", webm: "video/webm", mov: "video/quicktime", ogv: "video/ogg",
  mp3: "audio/mpeg", m4a: "audio/mp4", aac: "audio/aac", wav: "audio/wav", ogg: "audio/ogg", opus: "audio/ogg", flac: "audio/flac",
  txt: "text/plain; charset=utf-8", md: "text/plain; charset=utf-8", log: "text/plain; charset=utf-8", csv: "text/plain; charset=utf-8", srt: "text/plain; charset=utf-8", vtt: "text/vtt; charset=utf-8",
  json: "application/json; charset=utf-8", xml: "text/plain; charset=utf-8", html: "text/html; charset=utf-8", htm: "text/html; charset=utf-8",
};
const viewMime = (name) => { const i = String(name).lastIndexOf("."); return i > 0 ? VIEW_MIME[name.slice(i + 1).toLowerCase()] || "" : ""; };

export { TYPES, typeOf, HttpError, escHtml, safeColor, json, readJson, fmtBytes, validKey, validPrefix, sanitizeName, INTERNAL, isInternal, logEvent, viewMime };
