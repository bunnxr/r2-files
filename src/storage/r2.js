// The R2 driver: R2's S3 API, reached with short-lived presigned URLs (src/sigv4.js).
// This is exactly how the app has always talked to R2; only the code moved here.
//
// With the bucket binding (c.R2, [[r2_buckets]] in wrangler.toml), reading a file (get and head)
// goes through the binding instead: it stays inside Cloudflare's network, which is much faster for
// shared links than the public S3 endpoint. Listing, copies and multipart uploads stay on the S3 API.
import { presign } from "../sigv4.js";
import { makeDriver } from "./s3.js";

export function r2Driver(c) {
  const d = makeDriver({
    id: "r2",
    label: "R2",
    root: "",
    bucket: c.BUCKET,
    unreachable: "Could not reach R2. Check ENDPOINT and ACCOUNT_ID.",
    // signHeaders: false leaves the caller's headers out of the signature (used when passing on a
    // browser's Range / If-* headers while streaming a file).
    async send(method, key, { query, headers, body, signHeaders = true }) {
      const url = await presign(c, method, key, { query, headers: signHeaders ? headers : undefined, expires: 300 });
      return fetch(url, { method, headers, body });
    },
  });

  // Browsers and the terminal clients send each chunk straight to R2 at a presigned URL
  d.partUrl = (key, uploadId, n) => presign(c, "PUT", key, { query: { partNumber: String(n), uploadId } });
  // A direct, expiring R2 link (seconds: how long it works, default URL_EXPIRY_SECONDS)
  d.signedGet = (key, query, seconds) => presign(c, "GET", key, { query, expires: seconds });
  if (c.R2) useBinding(d, c.R2);
  return d;
}

// ---------------------------------------------------------------------
//  Reads through the bucket binding. head() and get() answer with the same shapes as the S3
//  versions in s3.js, so their callers (streamObject in public.js, the transfers in fileops.js
//  that read Content-Range) work unchanged:
//    head(key)                    -> { ok, status, text: "", headers }
//    get(key, { method, headers, query }) -> a Response like S3 GetObject (200, 206, 304, 404, 412)
//  A request with If-Range, a HEAD with a Range, or any error from the binding (for example a
//  range it cannot satisfy) goes to the S3 API instead, which answers it as it always has.
// ---------------------------------------------------------------------
// Content type and the other stored HTTP metadata, plus ETag, Last-Modified and Accept-Ranges
function objectHeaders(obj, query) {
  const h = new Headers();
  obj.writeHttpMetadata(h);
  h.set("etag", obj.httpEtag);
  h.set("last-modified", obj.uploaded.toUTCString());
  h.set("accept-ranges", "bytes");
  // S3 sets Content-Disposition from ?response-content-disposition; do the same
  if (query && query["response-content-disposition"]) h.set("content-disposition", query["response-content-disposition"]);
  return h;
}

// The If-* headers a failed condition answers with 304 (the browser's copy is current);
// the others (If-Match, If-Unmodified-Since) answer with 412, as S3 does.
const NOT_MODIFIED = ["if-none-match", "if-modified-since"];
const CONDITIONS = ["if-match", "if-none-match", "if-modified-since", "if-unmodified-since"];

function useBinding(d, bucket) {
  const s3head = d.head, s3get = d.get;

  d.head = async (key) => {
    let obj;
    try { obj = await bucket.head(key); } catch (e) { return s3head(key); }
    if (!obj) return { ok: false, status: 404, text: "", headers: new Headers() };
    const h = objectHeaders(obj);
    h.set("content-length", String(obj.size));
    return { ok: true, status: 200, text: "", headers: h };
  };

  d.get = async (key, opts = {}) => {
    const { method = "GET", headers, query } = opts;
    const given = new Headers(headers || {});
    const range = given.get("range");
    if (given.has("if-range") || (method === "HEAD" && range)) return s3get(key, opts);
    const onlyIf = new Headers();
    for (const n of CONDITIONS) { const v = given.get(n); if (v) onlyIf.set(n, v); }
    const conditional = [...onlyIf.keys()].length > 0;

    let obj;
    try {
      if (method === "HEAD") {
        obj = await bucket.head(key);
        // head() has no conditions: answer If-None-Match here, leave the rest to S3
        if (obj && conditional) {
          if (onlyIf.get("if-none-match") && onlyIf.get("if-none-match").split(",").map((s) => s.trim()).some((t) => t === "*" || t === obj.httpEtag)) {
            return new Response(null, { status: 304, headers: objectHeaders(obj, query) });
          }
          return s3get(key, opts);
        }
      } else {
        const o = {};
        if (range) o.range = new Headers({ range });
        if (conditional) o.onlyIf = onlyIf;
        obj = await bucket.get(key, o);
      }
    } catch (e) {
      return s3get(key, opts);
    }

    if (!obj) return new Response("Not found", { status: 404 });
    const h = objectHeaders(obj, query);
    // A failed condition: R2 hands back the object's metadata without a body
    if (method !== "HEAD" && !obj.body) {
      const status = NOT_MODIFIED.some((n) => onlyIf.has(n)) ? 304 : 412;
      return new Response(null, { status, headers: h });
    }
    if (method === "HEAD") {
      h.set("content-length", String(obj.size));
      return new Response(null, { status: 200, headers: h });
    }
    if (range && obj.range) {
      // obj.range is { offset, length } or { suffix } (the last n bytes)
      const size = obj.size, r = obj.range;
      let start, len;
      if (r.suffix !== undefined) { len = Math.min(r.suffix, size); start = size - len; }
      else { start = r.offset || 0; len = r.length !== undefined ? r.length : size - start; }
      h.set("content-range", "bytes " + start + "-" + (start + len - 1) + "/" + size);
      h.set("content-length", String(len));
      return new Response(obj.body, { status: 206, headers: h });
    }
    h.set("content-length", String(obj.size));
    return new Response(obj.body, { status: 200, headers: h });
  };
}
