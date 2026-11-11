const enc = new TextEncoder();

// ---------------------------------------------------------------------
//  Optional: verify the Cloudflare Access JWT (RS256, Web Crypto only)
// ---------------------------------------------------------------------
let certCache = { at: 0, keys: null };

async function verifyAccess(request, c) {
  if (!c.ACCESS_TEAM_DOMAIN || !c.ACCESS_AUD) return true; // not configured: Access in front of the domain is the gate
  const token = request.headers.get("Cf-Access-Jwt-Assertion");
  if (!token) return false;
  const parts = token.split(".");
  if (parts.length !== 3) return false;
  const b64 = (x) => Uint8Array.from(atob(x.replace(/-/g, "+").replace(/_/g, "/")), (ch) => ch.charCodeAt(0));
  const dec = new TextDecoder();
  try {
    const team = c.ACCESS_TEAM_DOMAIN.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
    const header = JSON.parse(dec.decode(b64(parts[0])));
    const payload = JSON.parse(dec.decode(b64(parts[1])));
    if (header.alg !== "RS256") return false;
    if (!Array.isArray([].concat(payload.aud)) || ![].concat(payload.aud).includes(c.ACCESS_AUD)) return false;
    if (payload.iss !== "https://" + team) return false;
    if (typeof payload.exp !== "number" || payload.exp * 1000 < Date.now()) return false;
    if (!certCache.keys || Date.now() - certCache.at > 3600e3) {
      const r = await fetch("https://" + team + "/cdn-cgi/access/certs");
      if (!r.ok) return false;
      certCache = { at: Date.now(), keys: (await r.json()).keys || [] };
    }
    const jwk = certCache.keys.find((k) => k.kid === header.kid);
    if (!jwk) return false;
    const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    return await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64(parts[2]), enc.encode(parts[0] + "." + parts[1]));
  } catch (e) {
    return false;
  }
}


export { verifyAccess };
