// The Zenith driver: the self-hosted S3 endpoint (s3proxy) behind the Cloudflare Tunnel.
//
//   ${ZENITH_ENDPOINT}/${ZENITH_BUCKET}/<key>     path-style, signed with SigV4 (aws4fetch)
//
// SigV4 authenticates every request to s3proxy. Cloudflare Access may sit in front of the hostname too:
// then the Worker also sends the service token from ZENITH_CF_ACCESS / ZENITH_CF_KEY.
// Browsers never talk to the endpoint: every byte goes through
// this Worker. That needs no CORS on s3proxy, and it is why a chunk may not exceed 95 MiB (the
// request-body cap on Cloudflare's proxy is 100 MB, both for the Worker and for the tunnel).
import { AwsClient } from "../vendor/aws4fetch.js";
import { encPath, rfc3986 } from "../sigv4.js";
import { makeDriver, MiB } from "./s3.js";

export const ZENITH_ROOT = "zenith:/";
export const ZENITH_MAX_PART = 95 * MiB;

const enc = new TextEncoder();
const b64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export function zenithDriver(c) {
  const z = c.ZENITH;
  if (!z) return null;
  const aws = new AwsClient({ accessKeyId: z.key, secretAccessKey: z.secret, service: "s3", region: "us-east-1" }); // s3proxy ignores the region, but it is part of the signature
  const base = z.endpoint + "/" + encodeURIComponent(z.bucket);

  const d = makeDriver({
    id: "zenith",
    label: "Zenith",
    root: ZENITH_ROOT,
    bucket: z.bucket,
    maxPart: ZENITH_MAX_PART,
    unreachable: "Could not reach Zenith. Check that the server, s3proxy and the tunnel are running.",
    // s3proxy's filesystem backend keeps unfinished multipart uploads as ".mpus-…" entries in the bucket
    hideKey: (k) => k.startsWith(".mpus-"),
    async send(method, key, { query, headers, body }) {
      const qs = query ? Object.keys(query).map((k) => rfc3986(k) + "=" + rfc3986(query[k])).join("&") : "";
      const url = base + (key ? "/" + encPath(key) : "") + (qs ? "?" + qs : "");
      const h = Object.assign({}, headers, { "x-amz-content-sha256": "UNSIGNED-PAYLOAD" }); // bodies are streamed, never hashed
      let req = await aws.sign(url, { method, headers: h, body });
      // Cloudflare Access service token, added after signing: it is checked by Cloudflare, not by s3proxy,
      // so it stays out of the SigV4 signature
      if (z.access) {
        const ah = new Headers(req.headers);
        ah.set("CF-Access-Client-Id", z.access.id);
        ah.set("CF-Access-Client-Secret", z.access.secret);
        req = new Request(req, { headers: ah });
      }
      // Never cached. Not cf.cacheTtl: any cacheTtl, even 0, switches the request into "cache everything"
      // mode, where Cloudflare sends a HEAD to the origin as a GET (breaking its SigV4 signature, 403)
      // and may fetch a whole file for a Range request. cache: "no-store" bypasses the cache entirely.
      return fetch(req, { cache: "no-store" });
    },
  });
  return d;
}

// ---------------------------------------------------------------------
//  Chunk URLs. A browser or terminal client cannot reach Zenith itself, so
//  it PUTs each chunk to this Worker at a short-lived signed URL, the same
//  way it would PUT to an R2 presigned URL, and reads the ETag back from
//  the response. The signature binds the file, the upload, the part number
//  and an expiry time; its key is derived from ZENITH_SECRET.
// ---------------------------------------------------------------------
async function partKey(c) {
  const root = await crypto.subtle.importKey("raw", enc.encode(c.ZENITH.secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const raw = await crypto.subtle.sign("HMAC", root, enc.encode("r2-file-manager/zenith-part/v1"));
  return crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}
const partMsg = (key, uploadId, n, exp) => ["part", key, uploadId, n, exp].join("\n");

// base: "/api/upload/data" for the web app, "https://<host>/cli/upload/data" for the terminal
export async function zenithPartUrl(c, base, key, uploadId, n) {
  const exp = Math.floor(Date.now() / 1000) + c.URL_EXPIRY_SECONDS;
  const sig = b64u(await crypto.subtle.sign("HMAC", await partKey(c), enc.encode(partMsg(key, uploadId, n, exp))));
  return base + "?key=" + encodeURIComponent(key) + "&uploadId=" + encodeURIComponent(uploadId) + "&n=" + n + "&e=" + exp + "&s=" + sig;
}

export async function verifyZenithPart(c, key, uploadId, n, exp, sig) {
  const e = Number(exp);
  if (!c.ZENITH || !Number.isInteger(e) || e * 1000 < Date.now() || typeof sig !== "string") return false;
  try {
    const raw = Uint8Array.from(atob(sig.replace(/-/g, "+").replace(/_/g, "/")), (ch) => ch.charCodeAt(0));
    return await crypto.subtle.verify("HMAC", await partKey(c), raw, enc.encode(partMsg(key, uploadId, n, e)));
  } catch (err) { return false; }
}
