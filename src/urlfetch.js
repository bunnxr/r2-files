// "Upload from URL": the Worker downloads a link and streams it into storage (R2, or Zenith when the
// destination folder is on Zenith) as a multipart upload.
// Progress is sent back to the browser as newline-delimited JSON.
import { HttpError, validPrefix, sanitizeName, isInternal } from "./util.js";
import { store, uniqueKey } from "./storage/index.js";

const MiB = 1024 ** 2;
const te = new TextEncoder();

function checkUrl(raw) {
  let u;
  try { u = new URL(String(raw)); } catch (e) { throw new HttpError(400, "That does not look like a web address."); }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new HttpError(400, "Only http and https links are supported.");
  const h = u.hostname.toLowerCase();
  const v4 = h.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  const priv = v4 && (+v4[1] === 10 || +v4[1] === 127 || +v4[1] === 0 || (+v4[1] === 169 && +v4[2] === 254) || (+v4[1] === 172 && +v4[2] >= 16 && +v4[2] <= 31) || (+v4[1] === 192 && +v4[2] === 168));
  if (h === "localhost" || h.endsWith(".local") || h.endsWith(".internal") || h.includes(":") || priv) throw new HttpError(400, "That address is not allowed.");
  return u;
}

function nameFor(u, res, wanted) {
  if (wanted) return sanitizeName(wanted);
  const cd = res.headers.get("content-disposition") || "";
  const star = cd.match(/filename\*=UTF-8''([^;]+)/i), plain = cd.match(/filename="?([^";]+)"?/i);
  try {
    if (star) return sanitizeName(decodeURIComponent(star[1]));
    if (plain) return sanitizeName(plain[1]);
    const last = decodeURIComponent(u.pathname.split("/").filter(Boolean).pop() || "");
    if (last) return sanitizeName(last);
  } catch (e) { /* fall through */ }
  return "download";
}

export function fetchToR2(c, ctx, b) {
  const u = checkUrl(b.url);
  const prefix = typeof b.prefix === "string" ? b.prefix : "";
  if (!validPrefix(prefix) || prefix.startsWith(".trash/") || isInternal(prefix)) throw new HttpError(400, "Invalid destination folder.");

  const { readable, writable } = new TransformStream();
  const w = writable.getWriter();
  const send = (o) => w.write(te.encode(JSON.stringify(o) + "\n"));

  const st = store(c);
  ctx.waitUntil((async () => {
    let key = "", uploadId = "";
    try {
      const res = await fetch(u.toString(), { redirect: "follow", headers: { "user-agent": "r2-file-manager" } });
      if (!res.ok || !res.body) throw new Error("The server answered with HTTP " + res.status + ".");
      const size = Number(res.headers.get("content-length")) || 0;
      key = await uniqueKey(c, prefix, nameFor(u, res, b.name));
      const type = (res.headers.get("content-type") || "").split(";")[0].trim();
      const ctype = /^[\w.+-]+\/[\w.+-]+$/.test(type) ? type : "application/octet-stream";
      await send({ stage: "start", key, size });

      const partSize = size ? Math.min(48 * MiB, Math.max(16 * MiB, Math.ceil(size / 40))) : 32 * MiB;
      uploadId = await st.mp.create(key, ctype);

      const reader = res.body.getReader();
      const etags = [];
      let chunks = [], have = 0, total = 0;
      const flush = async () => {
        const n = etags.length + 1;
        etags.push(await st.mp.part(key, uploadId, n, new Blob(chunks)));
        chunks = []; have = 0;
        await send({ progress: total, size });
      };
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value); have += value.length; total += value.length;
        if (have >= partSize) await flush();
      }
      if (total === 0) { // empty file: multipart needs at least one part, so use a plain PUT
        await st.mp.abort(key, uploadId);
        uploadId = "";
        await st.put(key, "", { type: ctype });
      } else {
        if (have > 0) await flush();
        await st.mp.complete(key, uploadId, etags.map((e, i) => ({ n: i + 1, e })));
        uploadId = "";
      }
      await send({ done: true, key, size: total });
    } catch (e) {
      if (uploadId) { try { await st.mp.abort(key, uploadId); } catch (x) { /* ignore */ } }
      try { await send({ error: String(e.message || e) }); } catch (x) { /* client left */ }
    } finally {
      try { await w.close(); } catch (x) { /* ignore */ }
    }
  })());

  return new Response(readable, { headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store" } });
}
