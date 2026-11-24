// ---------------------------------------------------------------------
//  Terminal client: the one-URL installer host and the /cli/* routes.
//
//  https://u.bunnxr.com/             serves public/install/upload.sh or
//                                    upload.ps1, picked from the User-Agent.
//  https://u.bunnxr.com/local        the same scripts, set to upload to
//                                    Zenith (your own server) instead of R2.
//  https://files.bunnxr.com/cli/*    the upload routes the script calls.
//                                    Every one needs the upload password as
//                                    "Authorization: Bearer <password>",
//                                    except upload/data (see below).
//
//  There is deliberately no delete, move, trash, share, list or settings
//  route here: the password can only add files, never remove or read them.
// ---------------------------------------------------------------------
import { json, readJson, logEvent } from "./util.js";
import { ZENITH_ROOT } from "./storage/index.js";
import { uploadInit, uploadComplete, partTarget, uploadData, uploadAbort } from "./uploads.js";
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
//  The installer host: one URL per destination, two scripts
//    /        uploads go to R2
//    /local   uploads go to Zenith: the same script, with its two setting
//             lines (destination folder and name) switched over
// ---------------------------------------------------------------------
const TO_ZENITH = {
  sh: [[/^DEST=""/m, 'DEST="' + ZENITH_ROOT + '"'], [/^TARGET="R2"/m, 'TARGET="Zenith"']],
  ps1: [[/^\$Script:Dest(\s*)= ''/m, "$Script:Dest$1= '" + ZENITH_ROOT + "'"], [/^\$Script:Target(\s*)= 'R2'/m, "$Script:Target$1= 'Zenith'"]],
};

async function serveScript(request, env, url, c) {
  if (request.method !== "GET" && request.method !== "HEAD") return plain("Method not allowed", 405, { allow: "GET, HEAD" });
  const local = url.pathname === "/local" || url.pathname === "/local/";
  if (url.pathname !== "/" && !local) return plain("Not found", 404);
  if (local && !(c && c.ZENITH)) return plain("Zenith is not set up on this Worker yet.", 503);

  const ua = request.headers.get("User-Agent") || "";
  // Invoke-RestMethod / irm send "... WindowsPowerShell/5.1" or "... PowerShell/7.x";
  // curl, wget and everything else get the bash script.
  const which = /PowerShell/i.test(ua) ? "ps1" : "sh";

  if (!env.ASSETS) return plain("Static assets binding missing. Check the [assets] section in wrangler.toml.", 500);
  const res = await env.ASSETS.fetch(new Request(new URL(SCRIPTS[which], url.origin), { method: "GET" }));
  if (!res.ok) return plain("The install script is missing from this deployment.", 500);
  let body = await res.text();
  if (local) {
    for (const [find, put] of TO_ZENITH[which]) {
      if (!find.test(body)) return plain("The install script's settings lines were changed, so it cannot be pointed at Zenith.", 500);
      body = body.replace(find, put);
    }
  }

  logEvent("script.served", { script: which, ua, target: local ? "zenith" : "r2" });
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
  // A chunk for Zenith: the signed URL that upload/part handed out is the permission (like an R2
  // presigned URL), so the script can PUT the chunk to it exactly as it would to R2.
  if (request.method === "PUT" && url.pathname === PREFIX + "upload/data") return uploadData(c, request, url);
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

    case "upload/part":
      return json(await partTarget(c, await readJson(request), url.origin + PREFIX + "upload/data"));

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
      const r = await uploadAbort(c, b);
      logEvent("upload.error", { key: b.key, via: "cli", error: "aborted by the client" });
      return json(r);
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
