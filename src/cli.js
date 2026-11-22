// ---------------------------------------------------------------------
//  Terminal client: the one-URL installer host and the /cli/* routes.
//
//  https://u.bunnxr.com/             serves public/install/upload.sh or
//                                    upload.ps1, picked from the User-Agent.
//  https://files.bunnxr.com/cli/*    the upload routes the script calls.
//                                    Every one needs the upload password as
//                                    "Authorization: Bearer <password>".
//
//  There is deliberately no delete, move, trash, share, list or settings
//  route here: the password can only add files, never remove or read them.
// ---------------------------------------------------------------------
import { HttpError, json, readJson, validKey, logEvent } from "./util.js";
import { presign } from "./sigv4.js";
import { r2 } from "./r2.js";
import { uploadInit, uploadComplete } from "./uploads.js";
import { listParts } from "./fileops.js";
import { fetchToR2 } from "./urlfetch.js";
import { readAuth, safeEqual, validPassword } from "./upauth.js";

const PREFIX = "/cli/";
const SCRIPTS = { sh: "/install/upload.sh", ps1: "/install/upload.ps1" };

const plain = (text, status, extra) =>
  new Response(text, {
    status,
    headers: Object.assign(
      { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" },
      extra || {}
    ),
  });

// ---------------------------------------------------------------------
//  The installer host: one URL, two scripts
// ---------------------------------------------------------------------
async function serveScript(request, env, url) {
  if (request.method !== "GET" && request.method !== "HEAD") return plain("Method not allowed", 405, { allow: "GET, HEAD" });
  if (url.pathname !== "/") return plain("Not found", 404);

  const ua = request.headers.get("User-Agent") || "";
  // Invoke-RestMethod / irm send "... WindowsPowerShell/5.1" or "... PowerShell/7.x";
  // curl, wget and everything else get the bash script.
  const which = /PowerShell/i.test(ua) ? "ps1" : "sh";

  if (!env.ASSETS) return plain("Static assets binding missing. Check the [assets] section in wrangler.toml.", 500);
  const res = await env.ASSETS.fetch(new Request(new URL(SCRIPTS[which], url.origin), { method: "GET" }));
  if (!res.ok) return plain("The install script is missing from this deployment.", 500);
  const body = await res.text();

  logEvent("script.served", { script: which, ua });
  return plain(request.method === "HEAD" ? null : body, 200);
}

// ---------------------------------------------------------------------
//  Password check. Runs before the request body is read, so a wrong or
//  missing password costs nothing and never touches the upload code.
//  The password itself is never logged, not even in part.
// ---------------------------------------------------------------------
async function checkPassword(request, c, url) {
  const where = {
    ip: request.headers.get("CF-Connecting-IP") || "",
    ua: request.headers.get("User-Agent") || "",
    path: url.pathname,
  };
  const header = (request.headers.get("Authorization") || "").trim();
  const m = /^Bearer\s+(\S+)$/i.exec(header);
  const given = m ? m[1] : "";
  // Shape check first: junk never reaches the stored password.
  if (!validPassword(given)) {
    logEvent("cli.verify.fail", Object.assign({ reason: given ? "malformed" : "missing" }, where));
    return false;
  }
  const auth = await readAuth(c);
  if (!safeEqual(given, auth.password)) {
    logEvent("cli.verify.fail", Object.assign({ reason: "wrong password" }, where));
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------
//  Router. Only the routes listed here exist under /cli/.
// ---------------------------------------------------------------------
async function handleCli(request, env, c, ctx, url) {
  if (request.method !== "POST") return json({ error: "Not found." }, 404);

  if (!(await checkPassword(request, c, url))) return json({ error: "Wrong or missing upload password." }, 401);

  const route = url.pathname.slice(PREFIX.length);
  const ip = request.headers.get("CF-Connecting-IP") || "";

  if (route === "verify") {
    logEvent("cli.verify.ok", { ip, ua: request.headers.get("User-Agent") || "", path: url.pathname });
    return json({ ok: true });
  }

  // Past this point the password was accepted. Bodies are never logged.
  logEvent("cli.request", { path: url.pathname, method: request.method });

  switch (route) {
    case "upload/init":
      return json(await uploadInit(c, await readJson(request)));

    case "upload/part": {
      const b = await readJson(request);
      const n = Number(b.partNumber);
      if (!validKey(b.key, "file") || typeof b.uploadId !== "string" || !b.uploadId || !Number.isInteger(n) || n < 1 || n > 10000) {
        throw new HttpError(400, "Invalid request.");
      }
      return json({ url: await presign(c, "PUT", b.key, { query: { partNumber: String(n), uploadId: b.uploadId } }) });
    }

    case "upload/complete": {
      const b = await readJson(request);
      try {
        const r = await uploadComplete(c, b);
        logEvent("upload.complete", { key: r.key, size: Number(b.size) || null, via: "cli" });
        return json(r);
      } catch (e) {
        logEvent("upload.error", { key: typeof b.key === "string" ? b.key : "", size: Number(b.size) || null, via: "cli", error: String(e && e.message ? e.message : e) });
        throw e;
      }
    }

    case "upload/abort": {
      const b = await readJson(request);
      if (!validKey(b.key, "file") || typeof b.uploadId !== "string" || !b.uploadId) throw new HttpError(400, "Invalid request.");
      await r2(c, "DELETE", b.key, { query: { uploadId: b.uploadId } });
      logEvent("upload.error", { key: b.key, via: "cli", error: "aborted by the client" });
      return json({ ok: true });
    }

    case "upload/parts":
      return json(await listParts(c, await readJson(request)));

    case "fetch-url":
      return fetchToR2(c, ctx, await readJson(request));

    default:
      return json({ error: "Not found." }, 404);
  }
}

export { PREFIX, serveScript, handleCli };
