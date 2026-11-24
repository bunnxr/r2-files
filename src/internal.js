// Internal API for the shortener Worker (its "R2 files" folder on links.bunnxr.com).
//
// The shortener calls this Worker through its FILES service binding with URLs on
// INTERNAL_HOST. That hostname is not routed to any Worker, so a request carrying it
// can only come from a service binding. As a second lock every call must carry the
// token the shortener keeps in its KV namespace (key "_r2files_token"), which this
// Worker reads through its SHORTENER_KV binding.
//
// Only link management and folder browsing (for picking a file) are exposed here.
// Nothing can be uploaded, moved, deleted or read through these routes.
import { HttpError, json, readJson, validPrefix, isInternal } from "./util.js";
import { store } from "./storage/index.js";
import { listLinks, updateLink, deleteLink, addLink } from "./links.js";

export const INTERNAL_HOST = "r2-files.internal";
const TOKEN_KEY = "_r2files_token";

function sameText(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

async function tokenOk(c, request) {
  if (!c.SHORTENER_KV) return false;
  const given = request.headers.get("x-internal-token") || "";
  if (given.length < 32) return false;
  const want = await c.SHORTENER_KV.get(TOKEN_KEY);
  return !!want && want.length >= 32 && sameText(given, want);
}

export async function handleInternal(request, c, url) {
  if (!(await tokenOk(c, request))) return json({ error: "Not allowed." }, 403);
  if (!c.PUBLIC_HOST) return json({ error: "Short links are off: set PUBLIC_HOST in r2-files." }, 400);

  switch (request.method + " " + url.pathname) {
    case "GET /config":
      return json({ linkHost: c.LINK_HOST || c.PUBLIC_HOST });
    case "GET /links":
      return json(await listLinks(c, url.searchParams.get("after") || ""));
    case "POST /link-add":
      return json(await addLink(c, await readJson(request)));
    case "POST /link-update":
      return json(await updateLink(c, await readJson(request)));
    case "POST /link-delete":
      return json(await deleteLink(c, (await readJson(request)).name));
    case "GET /list": { // folder browser for choosing the file of a new link
      const prefix = url.searchParams.get("prefix") ?? "";
      if (!validPrefix(prefix) || isInternal(prefix) || prefix.startsWith(".trash/")) throw new HttpError(400, "Invalid folder path.");
      const r = await store(c).list({ prefix, delimiter: "/", maxPages: 5 });
      return json({
        prefix,
        folders: r.folders.filter((f) => f !== ".trash/" && !isInternal(f)),
        files: r.files.filter((f) => f.key !== prefix && !f.key.endsWith("/") && !isInternal(f.key)).map((f) => ({ key: f.key, size: f.size })),
        truncated: r.truncated,
      });
    }
    default:
      return json({ error: "Not found." }, 404);
  }
}
