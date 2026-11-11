// AWS Signature V4 presigned URLs, hand-written with Web Crypto (no dependencies).
const enc = new TextEncoder();
const toHex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
const sha256Hex = async (s) => toHex(await crypto.subtle.digest("SHA-256", enc.encode(s)));
async function hmac(key, msg) {
  const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, enc.encode(msg)));
}
const rfc3986 = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (ch) => "%" + ch.charCodeAt(0).toString(16).toUpperCase());
const encPath = (p) => p.split("/").map(rfc3986).join("/");

// Returns a presigned URL. `key` may be "" for bucket-level calls (listing).
// `headers` are extra headers that get signed (the caller must send them unchanged).
async function presign(c, method, key, { query = {}, headers = {}, expires, now = new Date() } = {}) {
  const host = new URL(c.ENDPOINT).host;
  const path = "/" + [c.BUCKET, key ? encPath(key) : ""].filter(Boolean).join("/");
  const amz = now.toISOString().replace(/[:-]|\.\d{3}/g, ""); // 20130524T000000Z
  const date = amz.slice(0, 8);
  const scope = date + "/" + c.REGION + "/s3/aws4_request";

  const hdrs = { host };
  for (const k of Object.keys(headers)) hdrs[k.toLowerCase()] = headers[k];
  const names = Object.keys(hdrs).sort();
  const signedHeaders = names.join(";");

  const q = Object.assign({}, query, {
    "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
    "X-Amz-Credential": c.ACCESS_KEY_ID + "/" + scope,
    "X-Amz-Date": amz,
    "X-Amz-Expires": String(expires ?? c.URL_EXPIRY_SECONDS),
    "X-Amz-SignedHeaders": signedHeaders,
  });
  const canonicalQuery = Object.keys(q).sort().map((k) => rfc3986(k) + "=" + rfc3986(q[k])).join("&");
  const canonicalHeaders = names.map((n) => n + ":" + String(hdrs[n]).trim().replace(/\s+/g, " ") + "\n").join("");
  const canonicalRequest = [method, path, canonicalQuery, canonicalHeaders, signedHeaders, "UNSIGNED-PAYLOAD"].join("\n");
  const stringToSign = ["AWS4-HMAC-SHA256", amz, scope, await sha256Hex(canonicalRequest)].join("\n");

  let k = await hmac(enc.encode("AWS4" + c.SECRET_ACCESS_KEY), date);
  k = await hmac(k, c.REGION);
  k = await hmac(k, "s3");
  k = await hmac(k, "aws4_request");
  const signature = toHex(await hmac(k, stringToSign));
  return c.ENDPOINT + path + "?" + canonicalQuery + "&X-Amz-Signature=" + signature;
}

export { presign, rfc3986 };
