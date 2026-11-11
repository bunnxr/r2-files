import { presign } from "./sigv4.js";
import { HttpError, validKey, typeOf } from "./util.js";

// Server-side call to R2 (uses a short-lived presigned URL). Always reads the body.
async function r2(c, method, key, { query, headers, body } = {}) {
  const url = await presign(c, method, key, { query, headers, expires: 300 });
  let res;
  try {
    res = await fetch(url, { method, headers, body });
  } catch (e) {
    throw new HttpError(502, "Could not reach R2. Check ENDPOINT and ACCOUNT_ID.");
  }
  const text = method === "HEAD" ? "" : await res.text();
  return { ok: res.ok, status: res.status, text, headers: res.headers };
}


// ---------------------------------------------------------------------
//  R2 helpers: XML parsing, listing, usage
// ---------------------------------------------------------------------
const unxml = (s) => s
  .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
  .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
  .replace(/&amp;/g, "&");
const xmlEsc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const xmlTag = (s, t) => {
  const m = s.match(new RegExp("<" + t + ">([\\s\\S]*?)</" + t + ">"));
  return m ? unxml(m[1]) : "";
};
const r2Error = (res) => {
  const code = xmlTag(res.text, "Code");
  const msg = xmlTag(res.text, "Message");
  return "R2 error " + res.status + (code ? " (" + code + ")" : "") + (msg ? ": " + msg : "");
};

function parseList(xml) {
  const files = [];
  const folders = [];
  for (const m of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
    files.push({ key: xmlTag(m[1], "Key"), size: Number(xmlTag(m[1], "Size")) || 0, modified: xmlTag(m[1], "LastModified") });
  }
  for (const m of xml.matchAll(/<CommonPrefixes>([\s\S]*?)<\/CommonPrefixes>/g)) folders.push(xmlTag(m[1], "Prefix"));
  return { files, folders, truncated: xmlTag(xml, "IsTruncated") === "true", next: xmlTag(xml, "NextContinuationToken") };
}

async function listAll(c, { prefix, delimiter, maxPages }) {
  const out = { files: [], folders: [], truncated: false };
  let token = "";
  for (let i = 0; i < maxPages; i++) {
    const query = { "list-type": "2", "max-keys": "1000" };
    if (prefix) query.prefix = prefix;
    if (delimiter) query.delimiter = delimiter;
    if (token) query["continuation-token"] = token;
    const res = await r2(c, "GET", "", { query });
    if (!res.ok) throw new HttpError(502, r2Error(res));
    const p = parseList(res.text);
    out.files.push(...p.files);
    out.folders.push(...p.folders);
    if (!p.truncated || !p.next) return out;
    token = p.next;
  }
  out.truncated = true;
  return out;
}

// Sum of all object sizes. Capped at 40 list calls (40,000 objects) to stay inside
// the Workers Free 50-subrequest limit; if the cap is hit the figure is a lower bound.
async function bucketUsage(c) {
  const r = await listAll(c, { prefix: "", delimiter: "", maxPages: 40 });
  const byType = {};
  let count = 0;
  for (const f of r.files) {
    if (f.key.endsWith("/")) continue; // folder markers
    count++;
    const t = typeOf(f.key);
    const e = byType[t] || (byType[t] = { count: 0, size: 0 });
    e.count++;
    e.size += f.size;
  }
  return { used: r.files.reduce((n, f) => n + f.size, 0), count, partial: r.truncated, byType, files: r.files };
}

async function uniqueKey(c, prefix, name) {
  const dot = name.lastIndexOf(".");
  const base = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  for (let i = 0; i < 8; i++) {
    const key = prefix + (i ? base + " (" + i + ")" + ext : name);
    if (!validKey(key, "file")) throw new HttpError(400, "That file name or folder path is not allowed.");
    const res = await r2(c, "HEAD", key);
    if (res.status === 404) return key;
    if (res.status !== 200) throw new HttpError(502, "R2 error " + res.status + " while checking the file name.");
  }
  throw new HttpError(409, "Too many files with the same name. Rename the file and try again.");
}


export { r2, xmlEsc, xmlTag, r2Error, parseList, listAll, bucketUsage, uniqueKey };
