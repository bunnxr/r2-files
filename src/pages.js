import { escHtml } from "./util.js";

// ---------------------------------------------------------------------
//  Pages
// ---------------------------------------------------------------------
function securityPolicy(c) {
  const r2o = new URL(c.ENDPOINT).origin;
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: " + r2o,
    "media-src " + r2o,
    "frame-src " + r2o,
    "connect-src 'self' " + r2o,
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join("; ");
}

function notConfiguredPage(problems) {
  const li = problems.map((p) => "<li>" + escHtml(p) + "</li>").join("");
  const html = '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    "<title>Not configured yet</title><style>" +
    "body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;font:16px/1.55 ui-sans-serif,system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;background:#f4f5fa;color:#0f172a}" +
    "main{max-width:520px;background:#fff;border:1px solid #0001;border-radius:20px;padding:32px;box-shadow:0 12px 40px -12px #0002}h1{margin:0 0 8px;font-size:24px}code{background:#0000000d;padding:2px 6px;border-radius:6px}li{margin:4px 0}" +
    "</style></head><body><main><h1>Not configured yet</h1><p>Edit the <code>CONFIG</code> block at the top of the Worker code, then save and deploy again.</p><ul>" + li + "</ul>" +
    "<p>You can also add Worker secrets or variables with the same names under Settings &gt; Variables and Secrets.</p></main></body></html>";
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}


export { securityPolicy, notConfiguredPage };
