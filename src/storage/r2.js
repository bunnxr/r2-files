// The R2 driver: R2's S3 API, reached with short-lived presigned URLs (src/sigv4.js).
// This is exactly how the app has always talked to R2; only the code moved here.
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
  return d;
}
