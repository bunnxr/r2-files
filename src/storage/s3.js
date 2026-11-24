// Shared S3 operations. Both storage drivers (R2 and Zenith) speak the S3 API; they differ only in
// how a request is signed and sent, which each driver passes in as `send`. Every S3 detail (query
// parameters, XML bodies, headers) lives in this folder: nothing outside src/storage/ builds S3 calls.
//
// Keys given to a driver are the driver's own keys ("photos/a.jpg"), never the app-wide paths
// ("zenith:/photos/a.jpg"); src/storage/index.js translates between the two.
import { HttpError } from "../util.js";
import { encPath } from "../sigv4.js";

const MiB = 1024 ** 2;

// ---------------------------------------------------------------------
//  XML. Workers have no DOMParser. S3 answers with a handful of flat shapes
//  (ListObjectsV2, InitiateMultipartUploadResult, ListParts, CopyObjectResult,
//  Error), so a few regular expressions read them.
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

function parseList(xml) {
  const files = [];
  const folders = [];
  for (const m of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
    files.push({ key: xmlTag(m[1], "Key"), size: Number(xmlTag(m[1], "Size")) || 0, modified: xmlTag(m[1], "LastModified") });
  }
  for (const m of xml.matchAll(/<CommonPrefixes>([\s\S]*?)<\/CommonPrefixes>/g)) folders.push(xmlTag(m[1], "Prefix"));
  return { files, folders, truncated: xmlTag(xml, "IsTruncated") === "true", next: xmlTag(xml, "NextContinuationToken") };
}

const completeXml = (parts) => "<CompleteMultipartUpload>" + parts.map((p) => "<Part><PartNumber>" + p.n + "</PartNumber><ETag>" + xmlEsc(p.e) + "</ETag></Part>").join("") + "</CompleteMultipartUpload>";

// A stream of known length. S3 needs a Content-Length on every PUT, and a stream handed on
// from another request does not always carry one, so it is passed through a FixedLengthStream.
function sized(body, length) {
  if (!(body instanceof ReadableStream) || !Number.isFinite(length)) return body;
  const { readable, writable } = new FixedLengthStream(length);
  body.pipeTo(writable).catch(() => { /* the PUT fails and reports it */ });
  return readable;
}

const COPY_SINGLE_MAX = 4 * 1024 ** 3; // CopyObject up to 4 GiB; bigger files are copied in 1 GiB parts
const COPY_PART = 1024 ** 3;
const baseOf = (k) => k.slice(k.lastIndexOf("/") + 1);

// o: { id, label, root, bucket, unreachable, send(method, key, { query, headers, body, signHeaders }),
//      maxPart (largest part a client may send), hideKey(key) (driver housekeeping to leave out of listings) }
export function makeDriver(o) {
  const hide = o.hideKey || (() => false);
  const d = {
    id: o.id, label: o.label, root: o.root, bucket: o.bucket, maxPart: o.maxPart || Infinity,

    // Low level: the raw Response, or a 502 when the storage cannot be reached at all
    async raw(method, key, opts) {
      try { return await o.send(method, key, opts || {}); } catch (e) { throw new HttpError(502, o.unreachable); }
    },
    // Low level: always reads the body (as text)
    async call(method, key, opts) {
      const res = await d.raw(method, key, opts);
      const text = method === "HEAD" ? "" : await res.text();
      return { ok: res.ok, status: res.status, text, headers: res.headers };
    },
    error(res) {
      const code = xmlTag(res.text, "Code");
      const msg = xmlTag(res.text, "Message");
      return o.label + " error " + res.status + (code ? " (" + code + ")" : "") + (msg ? ": " + msg : "");
    },

    // ---- listing
    async listPage({ prefix, delimiter, maxKeys = 1000, token, startAfter } = {}) {
      const query = { "list-type": "2", "max-keys": String(maxKeys) };
      if (prefix) query.prefix = prefix;
      if (delimiter) query.delimiter = delimiter;
      if (token) query["continuation-token"] = token;
      if (startAfter) query["start-after"] = startAfter;
      const res = await d.call("GET", "", { query });
      if (!res.ok) throw new HttpError(502, d.error(res));
      const p = parseList(res.text);
      p.files = p.files.filter((f) => !hide(f.key));
      p.folders = p.folders.filter((f) => !hide(f));
      return p;
    },
    // Follows ContinuationToken pages: { files, folders, truncated } (truncated = stopped at maxPages)
    async list({ prefix, delimiter, maxPages }) {
      const out = { files: [], folders: [], truncated: false };
      let token = "";
      for (let i = 0; i < maxPages; i++) {
        const p = await d.listPage({ prefix, delimiter, token });
        out.files.push(...p.files);
        out.folders.push(...p.folders);
        if (!p.truncated || !p.next) return out;
        token = p.next;
      }
      out.truncated = true;
      return out;
    },

    // ---- single objects
    head: (key) => d.call("HEAD", key),
    // A HEAD that fails carries no body, so S3's reason (AccessDenied, SignatureDoesNotMatch …) is lost.
    // Only after such a failure: ask again with a 1-byte GET to read the reason for the error message.
    async explain(key, status, doing) {
      let why = "";
      try {
        const r = await d.call("GET", key, { headers: { range: "bytes=0-0" } });
        const code = xmlTag(r.text, "Code"), msg = xmlTag(r.text, "Message");
        if (code) why = " (" + code + (msg ? ": " + msg : "") + ")";
      } catch (e) { /* keep the short message */ }
      return o.label + " error " + status + " " + doing + why + ".";
    },
    // null when there is no such object. Files dropped onto Zenith over SMB may have no stored
    // content type, so `type` can be "".
    async stat(key) {
      const h = await d.head(key);
      if (h.status === 404) return null;
      if (!h.ok) throw new HttpError(502, await d.explain(key, h.status, "while reading " + baseOf(key)));
      return { size: Number(h.headers.get("content-length") || 0), type: h.headers.get("content-type") || "", modified: h.headers.get("last-modified") || "", etag: h.headers.get("etag") || "" };
    },
    // Streams the object; the caller's conditional / Range headers are passed on as they are
    get: (key, { method = "GET", headers, query } = {}) => d.raw(method, key, { query, headers, signHeaders: false }),
    async put(key, body, { type, length } = {}) {
      const res = await d.call("PUT", key, { headers: type ? { "content-type": type } : undefined, body: sized(body, length) });
      if (!res.ok) throw new HttpError(502, d.error(res));
    },
    async remove(key) {
      const res = await d.call("DELETE", key);
      if (!res.ok && res.status !== 404) throw new HttpError(502, d.error(res));
    },
    // Copy inside this storage (S3 has no rename or move)
    async copy(from, to) {
      const head = await d.head(from);
      if (head.status === 404) throw new HttpError(404, "File not found: " + baseOf(from));
      if (!head.ok) throw new HttpError(502, await d.explain(from, head.status, "while reading " + baseOf(from)));
      const size = Number(head.headers.get("content-length") || 0);
      const src = "/" + o.bucket + "/" + encPath(from); // x-amz-copy-source must be URL-encoded
      if (size <= COPY_SINGLE_MAX) {
        const res = await d.call("PUT", to, { headers: { "x-amz-copy-source": src } });
        if (!res.ok || /<Error>/.test(res.text)) throw new HttpError(502, d.error(res));
        return;
      }
      const type = head.headers.get("content-type") || "application/octet-stream";
      const uploadId = await d.mpCreate(to, type);
      try {
        const etags = [];
        for (let n = 1, off = 0; off < size; n++, off += COPY_PART) {
          const end = Math.min(off + COPY_PART, size) - 1;
          const r = await d.call("PUT", to, { query: { partNumber: String(n), uploadId }, headers: { "x-amz-copy-source": src, "x-amz-copy-source-range": "bytes=" + off + "-" + end } });
          if (!r.ok) throw new HttpError(502, d.error(r));
          etags.push({ n, e: xmlTag(r.text, "ETag") });
        }
        await d.mpComplete(to, uploadId, etags);
      } catch (e) {
        await d.call("DELETE", to, { query: { uploadId } });
        throw e;
      }
    },

    // ---- multipart uploads
    async mpCreate(key, type) {
      const res = await d.call("POST", key, { query: { uploads: "" }, headers: { "content-type": type } });
      const uploadId = xmlTag(res.text, "UploadId");
      if (!res.ok || !uploadId) throw new HttpError(502, d.error(res));
      return uploadId;
    },
    // Sends one part from the server itself and returns its ETag exactly as S3 gave it
    async mpPart(key, uploadId, n, body, length) {
      const res = await d.call("PUT", key, { query: { partNumber: String(n), uploadId }, body: sized(body, length) });
      if (!res.ok) throw new HttpError(502, d.error(res));
      const etag = res.headers.get("etag") || "";
      if (!etag) throw new HttpError(502, o.label + " did not return an ETag for part " + n + ".");
      return etag;
    },
    // Which parts an unfinished upload already has (used to resume uploads)
    async mpList(key, uploadId) {
      const parts = [];
      let marker = 0;
      for (let i = 0; i < 10; i++) {
        const res = await d.call("GET", key, { query: { uploadId, "max-parts": "1000", "part-number-marker": String(marker) } });
        if (res.status === 404 || /NoSuchUpload/.test(res.text)) throw new HttpError(404, "That upload no longer exists.");
        if (!res.ok) throw new HttpError(502, d.error(res));
        for (const m of res.text.matchAll(/<Part>([\s\S]*?)<\/Part>/g)) parts.push({ n: Number(xmlTag(m[1], "PartNumber")), etag: xmlTag(m[1], "ETag"), size: Number(xmlTag(m[1], "Size")) });
        if (xmlTag(res.text, "IsTruncated") !== "true") break;
        marker = Number(xmlTag(res.text, "NextPartNumberMarker")) || parts[parts.length - 1].n;
      }
      return parts;
    },
    // parts: [{ n, e }] sorted by n
    async mpComplete(key, uploadId, parts) {
      const res = await d.call("POST", key, { query: { uploadId }, body: completeXml(parts) });
      if (!res.ok || /<Error>/.test(res.text)) throw new HttpError(502, d.error(res));
    },
    // Throws away an unfinished upload and every part already sent for it
    async mpAbort(key, uploadId) {
      await d.call("DELETE", key, { query: { uploadId } });
    },
    // Part size for a file of `size` bytes: at least `chunk`, whole MiB (the terminal clients seek by
    // MiB), at most 10,000 parts, and never above what this storage accepts in one request.
    partSize(size, chunk) {
      let ps = Math.max(chunk, Math.ceil(size / 10000));
      ps = Math.ceil(ps / MiB) * MiB;
      if (ps > d.maxPart) {
        if (Math.ceil(size / 10000) > d.maxPart) throw new HttpError(413, "That file is too large for " + o.label + ": the limit is " + Math.floor((d.maxPart * 10000) / 1024 ** 3) + " GB.");
        ps = d.maxPart;
      }
      return ps;
    },
  };
  return d;
}

export { MiB, xmlEsc, xmlTag, parseList };
