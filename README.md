# R2 File Manager

A Cloudflare Worker that serves a file manager for an R2 bucket. Uploads go straight from the browser to R2 using presigned multipart URLs.

## Layout
- `src/worker.js`: routing and API
- `src/config.js`: CONFIG block (edit your non-secret settings here)
- `src/sigv4.js`: SigV4 presigned URLs
- `src/r2.js`: R2 calls, listing, usage
- `src/uploads.js`: multipart upload, folder delete, download URLs
- `src/access.js`: optional Cloudflare Access token check
- `src/pages.js`: security headers and the "Not configured yet" page
- `public/`: `index.html`, `style.css`, `app.js`

## Secrets (never commit them)
Set `ACCESS_KEY_ID`, `SECRET_ACCESS_KEY` and `ACCOUNT_ID` as **secrets** in the dashboard (Worker > Settings > Variables and Secrets). They override `src/config.js`. Plain-text dashboard variables are removed by `wrangler deploy` unless they are in `wrangler.toml`, so use secrets, or put non-secret values in `src/config.js`.

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
- `index.html`: free to re-layout, but keep these element ids because `app.js` uses them: `logo file uploadIco btnFolder folderIco nav uBig uSub uSeg uTypes q searchIco crumbs folderSec folders filesTitle count sortBy sortDir btnView list drop uploads upTitle upSub upToggle upClear upBar upList modal toasts`.
- `app.js`: the functions `itemHtml`, `folderHtml`, `theadHtml` and `render` build the file rows and cards. Class names and `data-*` attributes there (`data-act`, `data-i`, `data-f`, `data-sort`, `data-u`) are used by the click handlers, so keep them.
- Do not add external scripts or fonts: the Content-Security-Policy in `src/pages.js` blocks them.
