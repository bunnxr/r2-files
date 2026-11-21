# R2 File Manager

A Cloudflare Worker that serves a file manager for an R2 bucket. Uploads go straight from the browser to R2 using presigned multipart URLs. There is also a terminal upload client for when a browser is not convenient.

## Layout
- `src/worker.js`: routing and API
- `src/config.js`: CONFIG block (edit your non-secret settings here)
- `src/sigv4.js`: SigV4 presigned URLs
- `src/r2.js`: R2 calls, listing, usage
- `src/uploads.js`: multipart upload, folder delete, download URLs
- `src/fileops.js`: move, copy, trash, restore, save text, multipart part list
- `src/links.js`: short links on the public host
- `src/notes.js`: per-file notes
- `src/urlfetch.js`: "save from a link"
- `src/public.js`: everything served on the public hostname
- `src/access.js`: optional Cloudflare Access token check
- `src/upauth.js`: the upload password (stored in R2), generation and rotation
- `src/cli.js`: the `upload.bunnxr.com` script host and the `/cli/*` routes
- `src/pages.js`: security headers and the "Not configured yet" page
- `public/`: `index.html`, `style.css`, `app.js`, `zip.js`, `sw.js`
- `public/install/`: `upload.sh` and `upload.ps1`, the terminal clients
- `.gitattributes`: keeps `*.sh` checked out with LF endings, so the bash script still runs after a clone on Windows

## Terminal upload

One command, no install, nothing left behind on the machine:

    # Linux, macOS, Git Bash or WSL
    curl -fsSL https://upload.bunnxr.com | bash

    # Windows PowerShell
    irm https://upload.bunnxr.com | iex

Both hit the same URL; the Worker picks the script from the request's User-Agent. The script asks for the upload password with hidden input, checks it against `POST /cli/verify`, then offers a prompt:

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
| `upload.bunnxr.com` | the two install scripts, **no login and no secrets**; any path other than `/` returns 404 |
| `r2.bunnxr.com` | public files and expiring share links |

The `/cli/*` routes are `verify`, `upload/init`, `upload/part`, `upload/complete`, `upload/abort`, `upload/parts` and `fetch-url`, all POST. There is deliberately no delete, move, trash, share, list or settings route among them: the password can add files, never remove or read them. The password is checked before the request body is read, and never logged. `/api/*` keeps its Access protection and never accepts the CLI password.

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
Set `ACCESS_KEY_ID`, `SECRET_ACCESS_KEY`, `ACCOUNT_ID` and `ENDPOINT` as **secrets** in the dashboard (Worker > Settings > Variables and Secrets). They override `src/config.js`. Plain-text dashboard variables are removed by `wrangler deploy` unless they are in `wrangler.toml`, so use secrets, or put non-secret values in `src/config.js`.

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
- `index.html`: free to re-layout, but keep these element ids because `app.js` uses them: `logo file uploadIco btnFolder folderIco nav uBig uSub uSeg uTypes q searchIco searchBar crumbs folderSec folders filesTitle count sortBy sortDir btnView list drop uploads upTitle upSub upToggle upClear upBar upList modal toasts filesSec linksSec lkCount lkFilter lkClean lkRefresh lkList upSec upBody`.
- `app.js`: the functions `itemHtml`, `folderHtml`, `theadHtml` and `render` build the file rows and cards. Class names and `data-*` attributes there (`data-act`, `data-i`, `data-f`, `data-sort`, `data-u`, `data-up`) are used by the click handlers, so keep them.
- The **Uploads** sidebar item (the upload password page) and the `#view=upload-password` route are part of the UI: the item comes from the `NAV` list and is drawn by `renderNav`, the panel is built by `renderUpAuth` into `#upBody`, and its styles are the `.upcard`, `.up-*` and `.sw` rules at the end of `style.css`. Keep them when restyling.
- Do not add external scripts or fonts: the Content-Security-Policy in `src/pages.js` blocks them.

## Short links on bunnxr.com
Short links are shown and copied as `https://LINK_HOST/<name>` (for example `bunnxr.com/gta6.mp4`). `bunnxr.com/*` is routed to the separate **shortener** Worker. When the shortener has no link with that name, it hands the request to this Worker through a service binding (`FILES` → `r2-files` in the shortener's `wrangler.toml`), and this Worker serves the file link. On `LINK_HOST` only short links are served, never public folders. The same links also keep working on `PUBLIC_HOST` (`r2.bunnxr.com/gta6.mp4`). To keep the two from clashing, this Worker reads the shortener's KV namespace (binding `SHORTENER_KV`, read only): a custom address the shortener already uses is refused with an error, and automatic addresses (`charlie.zip`, `charlie-2.zip` …) skip such names. If the shortener later adds a back-half that a file link already has, the shortener's link wins on `bunnxr.com`.
