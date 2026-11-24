# R2 File Manager

A Cloudflare Worker that serves a file manager for an R2 bucket, plus a second drive, **Zenith**: a self-hosted S3 server. Uploads go straight from the browser to R2 using presigned multipart URLs. There is also a terminal upload client for when a browser is not convenient.

## Layout
- `src/worker.js`: routing and API
- `src/config.js`: CONFIG block (edit your non-secret settings here)
- `src/sigv4.js`: SigV4 presigned URLs (used by the R2 driver)
- `src/storage/`: **the only code that talks to storage** (see "Storage and Zenith")
  - `index.js`: `resolve()` decides which drive a path is on; `store(c)` is the interface every other module uses; `sys(c)` holds the app's own records (always R2); listing usage and unique names
  - `s3.js`: the S3 operations both drivers share (list, stat, get, put, delete, copy, multipart) and the XML parsing
  - `r2.js`: the R2 driver (presigned URLs, as before)
  - `zenith.js`: the Zenith driver (aws4fetch, path-style) and the signed chunk URLs
- `src/vendor/aws4fetch.js`: aws4fetch 1.0.20, copied unchanged (MIT), so deploys need no `npm install`
- `src/uploads.js`: multipart upload, the Zenith chunk route, folder delete
- `src/fileops.js`: move, copy, trash, restore, save text, multipart part list, moving between R2 and Zenith
- `src/links.js`: short links on the public host
- `src/notes.js`: per-file notes
- `src/urlfetch.js`: "save from a link"
- `src/public.js`: everything served on the public hostname
- `src/access.js`: optional Cloudflare Access token check
- `src/upauth.js`: the upload password (stored in R2), generation and rotation
- `src/cli.js`: the `u.bunnxr.com` script host and the `/cli/*` routes
- `src/pages.js`: security headers and the "Not configured yet" page
- `public/`: `index.html`, `style.css`, `app.js`, `zip.js`, `sw.js`
- `public/install/`: `upload.sh` and `upload.ps1`, the terminal clients
- `.gitattributes`: keeps `*.sh` checked out with LF endings, so the bash script still runs after a clone on Windows

## Storage and Zenith

Every file has a **path**. A path that starts with `zenith:/` is on Zenith; every other path is in R2:

| Path | Drive | Key on that drive |
| --- | --- | --- |
| `photos/a.jpg` | R2 | `photos/a.jpg` |
| `zenith:/photos/a.jpg` | Zenith | `photos/a.jpg` |

`resolve()` in `src/storage/index.js` is the only place that decides this. Every route, the public host, short links, notes, upload from a link and the terminal client go through `store(c)` with paths, so they work the same on both drives. File and folder names made in the app can never contain `:`, so no R2 folder can clash with `zenith:/`. The app's own records (`.links/`, `.notes/`, `.system/`) always stay in R2.

**Zenith** is s3proxy (filesystem backend) on the LAN, reached at `ZENITH_ENDPOINT` through a Cloudflare Tunnel. Requests are path-style (`${ZENITH_ENDPOINT}/${ZENITH_BUCKET}/<key>`), signed with SigV4 by aws4fetch (service `s3`, region `us-east-1`), and sent with `cache: "no-store"` so they never touch Cloudflare's cache. (Not `cf: { cacheTtl: 0 }`: any `cacheTtl` puts the request in "cache everything" mode, where Cloudflare turns HEAD into GET, which breaks the signature, and may fetch whole files for Range requests.) Every request is signed with SigV4. In front of the hostname there is also a **Cloudflare Access** application with a single **Service Auth** policy, so only requests carrying its service token get through to the server at all: the Worker sends the token from two optional secrets, `ZENITH_CF_ACCESS` and `ZENITH_CF_KEY` (the Client ID and Client Secret, in either order: the ID is the one ending in `.access`). Without them the Worker sends no token, which only works while Access is off. Zenith needs four **secrets** in the Worker's dashboard settings: `ZENITH_ENDPOINT` (no trailing slash), `ZENITH_BUCKET`, `ZENITH_KEY` and `ZENITH_SECRET`. They are read straight from `env`. Do **not** put them in `[vars]` in `wrangler.toml` (that would replace the secrets on deploy) or in `src/config.js`. If any one is missing, Zenith is simply off and R2 is unaffected.

In the web app Zenith is a card in the **Drives** row above the R2 files. Open it and everything works as in R2: upload (files, folders, paste, drag and drop, zip, from a link), new folder, new text file, view, download, edit text, notes, short links, Move to… / Copy to… (also between R2 and Zenith), with these differences:

- **Every byte goes through the Worker.** Browsers never talk to Zenith, so s3proxy needs no CORS. Upload chunks go to `PUT /api/upload/data` at a signed URL, and the Worker streams each one to S3 UploadPart and returns its ETag; downloads and previews stream from `/api/read`. Chunks are capped at **95 MiB**, under the 100 MB request-body limit of Cloudflare's proxy, so a single file can be up to about 927 GB. A failed or cancelled upload is aborted, so no half-finished parts are left on the disk.
- **No trash.** Deleting on Zenith is permanent, after a confirmation.
- **Files added over SMB** show up the next time the folder is listed. They may have no stored content type (it is then guessed from the file name), and their ETags are not checked against R2.
- **Short links** to Zenith files work like R2 links (`bunnxr.com/name`, `r2.bunnxr.com/name`): opening one streams the file from Zenith. When a file is moved, between drives or within one, its links follow it.
- **Moving between R2 and Zenith** streams the file through the Worker (`POST /api/xfer`). Files up to 95 MiB go in one call; bigger ones are copied 2 × 64 MiB parts per call while the app shows progress. The source is deleted only after the copy is complete.
- **R2 only:** the Storage figure, Largest files, Recent and the type views (Images, Videos …), the trash, and public folders.

If Zenith answers 403 *SignatureDoesNotMatch*, the tunnel is probably rewriting the `Host` header: the signature covers the host in `ZENITH_ENDPOINT`.

## Terminal upload

One command, no install, nothing left behind on the machine:

    # Linux, macOS, Git Bash or WSL
    curl -fsSL https://u.bunnxr.com | bash
    curl -fsSL https://u.bunnxr.com/local | bash     # upload to Zenith instead

    # Windows PowerShell
    irm https://u.bunnxr.com | iex
    irm https://u.bunnxr.com/local | iex             # upload to Zenith instead

Both hit the same URL; the Worker picks the script from the request's User-Agent. `/local` serves the same script with its two settings lines switched (`DEST` to `zenith:/`, `TARGET` to `Zenith`), so uploads go to Zenith with the same password and the same features. The script asks for the upload password with hidden input, checks it against `POST /cli/verify`, then offers a prompt:

| Command | What it does |
| --- | --- |
| `file <path>` | upload one file |
| `folder <path>` | upload a folder and everything in it, structure kept |
| `<path>` | same thing, worked out from the path itself |
| `help` | show the commands |
| `exit` | quit |

**Drag and drop.** Dragging a file or folder onto the window pastes its path, and the scripts accept it as typed on Linux, macOS and Windows. Before a path is used it is trimmed, stripped of a matching pair of quotes, stripped of the `&` that Windows Terminal adds, unescaped (`My\ Files` on macOS and Linux) and `~`-expanded; on Windows the backslashes are kept as separators, and under WSL a dragged `C:\...` path is looked up under `/mnt/c/...`. Whether something is a file or a folder is decided by looking at the path, not by the keyword typed in front of it, so paths with spaces work quoted, escaped or dragged in.

Each upload shows one line that redraws in place: a bar and percentage, bytes sent against the total, current speed, elapsed time and ETA, plus the file count and current file name when a folder is being sent. Chunks are read straight out of the source file and streamed into the request, so no temporary files are written and the password stays in memory only. Uploads land at the top of the bucket; change `DEST` at the top of either script to send them into a folder instead.

## Upload password

The terminal client is protected by a password, separate from the Cloudflare Access login that guards the web app.

- Manage it in the app: **Uploads** in the sidebar, or `#view=upload-password`.
- Format: **Generate** always makes 7 characters of `a-z`, `A-Z` and `0-9`. A password typed in by hand may be 7 to 24 visible ASCII characters, symbols included (`!@#$%^&*` …), but no spaces and no accented letters or emoji, because it is sent in an HTTP header.
- **Generate** fills the box with a new password; nothing changes until **Save** is clicked. **Copy** puts the value on the clipboard.
- **Auto-rotate every 6 days** is off by default, so the password never changes on its own. Switched on, it saves immediately and a **Next rotation** date appears below the toggle.
- It is stored as a small JSON object at `.system/upload-auth.json` **in the R2 bucket** — not in KV, not as a Worker secret and not in git. The Worker creates it the first time it is needed. `.system/` is hidden from the file manager and every move, copy, delete, trash, share and save route refuses keys under it.

## Routes

| Route | Protection |
| --- | --- |
| `files.bunnxr.com` | the web app and `/api/*`, behind **Cloudflare Access** (SSO) |
| `files.bunnxr.com/cli/*` | **upload password** (`Authorization: Bearer <password>`), with an Access bypass policy on the path |
| `u.bunnxr.com` | the two install scripts, **no login and no secrets**; `/` uploads to R2, `/local` to Zenith; any other path returns 404 |
| `r2.bunnxr.com` | public files and expiring share links |

The `/cli/*` routes are `verify`, `upload/init`, `upload/part`, `upload/complete`, `upload/abort`, `upload/parts` and `fetch-url`, all POST, plus `PUT upload/data` for Zenith chunks. That one takes no password: like an R2 presigned URL, the signed URL from `upload/part` is the permission, for one part of one upload, for `URL_EXPIRY_SECONDS`. There is deliberately no delete, move, trash, share, list or settings route among them: the password can add files, never remove or read them. The password is checked before the request body is read, and never logged. `/api/*` keeps its Access protection and never accepts the CLI password.

Add a rate-limiting rule on `/cli/*` in the Cloudflare dashboard (for example 10 requests per minute per IP).

## Observability

`[observability]` is enabled in `wrangler.toml` with full sampling. The Worker logs one JSON object per line, each with an `event` and a `time`, so the dashboard can filter on a single field.

| Event | Fields |
| --- | --- |
| `cli.verify.ok`, `cli.verify.fail` | `ip`, `ua`, `path` (and `reason` on a failure); never the password |
| `cli.request` | `path`, `method`, for each `/cli/*` request that passed the password check; never the body |
| `script.served` | `script` (`sh` or `ps1`), `ua` |
| `password.generated`, `password.saved` | `by` (`first-use`, `settings` or `cron`); never the value |
| `auto.toggled` | `auto` (`on` or `off`) |
| `rotation.performed` | `rotatedAt` |
| `upload.complete`, `upload.error` | `key`, `size` where known, `via` (`web` or `cli`), `error` on failure |
| `cron.run` | `decision` (`skipped` or `rotated`), plus a `reason` when skipped |

Find them under **Workers & Pages → r2-files → Observability → Logs**, and filter by field, for example `event:cli.verify.fail`. Cron runs show up in the same log stream as `cron.run`; the schedule itself and its recent invocations are under the Worker's **Settings → Trigger Events** (cron triggers), with the output in Observability → Logs. Unexpected errors still go to `console.error` and appear there too.

## Secrets (never commit them)
Set `ACCESS_KEY_ID`, `SECRET_ACCESS_KEY`, `ACCOUNT_ID` and `ENDPOINT` as **secrets** in the dashboard (Worker > Settings > Variables and Secrets). They override `src/config.js`. Zenith's secrets (`ZENITH_ENDPOINT`, `ZENITH_BUCKET`, `ZENITH_KEY`, `ZENITH_SECRET`, plus `ZENITH_CF_ACCESS` and `ZENITH_CF_KEY` for the Access service token) are set the same way and have no counterpart in `src/config.js`. Plain-text dashboard variables are removed by `wrangler deploy` unless they are in `wrangler.toml`, so use secrets, or put non-secret values in `src/config.js`.

The **upload password is not a secret and not in git**: it lives in the bucket at `.system/upload-auth.json` and is managed from the settings page. Nothing in `wrangler.toml` holds a secret; its only ID is the shortener's KV namespace (see "Short links on bunnxr.com"), which is not a secret.

## Deploy with git (no Node on your PC)
Push this folder to GitHub/GitLab. In the Worker: Settings > Builds > Connect, pick the repo. Deploy command: `npx wrangler deploy`. The Worker name must stay `r2-files`.

## Deploy with Wrangler
`npm install`, then `npx wrangler deploy`.

## Local development
Create `.dev.vars` (git-ignored):

    ACCESS_KEY_ID=...
    SECRET_ACCESS_KEY=...
    ACCOUNT_ID=...

Run `npx wrangler dev`. For local testing add `http://localhost:8787` to the bucket's CORS AllowedOrigins.

The bucket CORS policy and the Access application are set up as in the setup guide.

## Restyling (by hand or with another AI agent)
Only the files in `public/` need to change; leave `src/` alone.
- `style.css`: free to change (colours are CSS variables at the top; light theme only).
- `index.html`: free to re-layout, but keep these element ids because `app.js` uses them: `logo file uploadIco btnFolder folderIco nav uSeg uTypes q searchIco searchBar crumbs folderSec folders filesTitle count sortBy sortDir btnView list drop uploads upTitle upSub upToggle upClear upBar upList modal toasts filesSec linksSec lkCount lkFilter lkClean lkRefresh lkList upSec upBody`. The storage figure is the last item of `#nav`, built by `renderNav`.
- `app.js`: the functions `itemHtml`, `folderItemHtml`, `driveHtml` (the Drives cards), `theadHtml` and `render` build the file rows and cards. Class names and `data-*` attributes there (`data-act`, `data-i`, `data-f`, `data-sort`, `data-u`, `data-up`) are used by the click handlers, so keep them.
- The **Uploads** sidebar item (the upload password page) and the `#view=upload-password` route are part of the UI: the item comes from the `NAV` list and is drawn by `renderNav`, the panel is built by `renderUpAuth` into `#upBody`, and its styles are the `.upcard`, `.up-*` and `.sw` rules at the end of `style.css`. Keep them when restyling.
- Do not add external scripts or fonts: the Content-Security-Policy in `src/pages.js` blocks them.

## Short links on bunnxr.com
Short links are shown and copied as `https://LINK_HOST/<name>` (for example `bunnxr.com/gta6.mp4`). `bunnxr.com/*` is routed to the separate **shortener** Worker. When the shortener has no link with that name, it hands the request to this Worker through a service binding (`FILES` → `r2-files` in the shortener's `wrangler.toml`), and this Worker serves the file link. On `LINK_HOST` only short links are served, never public folders. The same links also keep working on `PUBLIC_HOST` (`r2.bunnxr.com/gta6.mp4`). To keep the two from clashing, this Worker reads the shortener's KV namespace (binding `SHORTENER_KV`, read only): a custom address the shortener already uses is refused with an error, and automatic addresses (`charlie.zip`, `charlie-2.zip` …) skip such names. If the shortener later adds a back-half that a file link already has, the shortener's link wins on `bunnxr.com`.
