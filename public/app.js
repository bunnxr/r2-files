// Settings (title, colours, upload tuning) come from the Worker's CONFIG via /api/config.
let BOOT = { title: 'Files', accent: '', parallel: 4, retries: 3, view: 'grid' };
try { const r = await fetch('/api/config'); if (r.ok) BOOT = await r.json(); } catch (e) { /* keep defaults */ }
document.title = BOOT.title;
{ const h1 = document.querySelector('.brand h1'); if (h1) h1.textContent = BOOT.title; }
if (BOOT.accent) document.documentElement.style.setProperty('--accent', BOOT.accent);
const $ = (s, r) => (r || document).querySelector(s);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ls = { get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }, set(k, v) { try { localStorage.setItem(k, v); } catch (e) {} } };
const fmt = (n) => { const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0; while (n >= 1024 && i < 4) { n /= 1024; i++; } return (i === 0 ? n : Math.round(n * 10) / 10) + ' ' + u[i]; };
const fdate = (s) => (s ? new Date(s).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '');
const CANCEL = new Error('Canceled');

/* ---------- icons ---------- */
const P = {
  cloud: '<path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  folderPlus: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M12 10v6M9 13h6"/>',
  file: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>',
  doc: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M9 13h6M9 17h6"/>',
  image: '<rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="9" cy="9" r="1.8"/><path d="m21 15-5-5L5 21"/>',
  video: '<rect x="3" y="5" width="18" height="14" rx="3"/><path d="m10 9 5 3-5 3z"/>',
  audio: '<path d="M9 18V5l11-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="17" cy="16" r="3"/>',
  archive: '<rect x="3" y="3" width="18" height="5" rx="1"/><path d="M5 8v11a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8M10 12h4"/>',
  code: '<path d="m8 8-4 4 4 4M16 8l4 4-4 4M14 5l-4 14"/>',
  sheet: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M3 15h18M9 3v18"/>',
  download: '<path d="M12 4v11m0 0 4-4m-4 4-4-4M5 20h14"/>',
  upload: '<path d="M12 16V4m0 0-4 4m4-4 4 4M5 20h14"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/>',
  grid: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  chev: '<path d="m9 6 6 6-6 6"/>',
  down: '<path d="m6 9 6 6 6-6"/>',
  up: '<path d="m6 15 6-6 6 6"/>',
  check: '<path d="m5 12 5 5 10-10"/>',
  retry: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5"/>',
  eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  sort: '<path d="M12 5v14m0 0 5-5m-5 5-5-5"/>',
  ext: '<path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  broom: '<path d="M4 20h16M7 20l1-9h8l1 9M10 11V4h4v7"/>'
};
const ico = (n, s) => '<svg class="i" width="' + (s || 18) + '" height="' + (s || 18) + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + P[n] + '</svg>';
const EXT = { image: 'jpg jpeg png gif webp avif svg bmp heic heif ico tif tiff', video: 'mp4 mov m4v webm mkv avi wmv', audio: 'mp3 wav flac aac m4a ogg opus', pdf: 'pdf', archive: 'zip rar 7z tar gz tgz bz2 xz', code: 'js ts jsx tsx json html css py rb go rs java c cpp h php sh sql yml yaml xml md', sheet: 'xls xlsx csv tsv ods numbers', doc: 'doc docx odt rtf txt pages ppt pptx key' };
const KC = { folder: '#3b82f6', image: '#10b981', video: '#ec4899', audio: '#8b5cf6', pdf: '#ef4444', archive: '#f59e0b', code: '#0ea5e9', sheet: '#22a06b', doc: '#3b82f6', file: '#94a3b8' };
const GLYPH = { folder: 'folder', image: 'image', video: 'video', audio: 'audio', pdf: 'doc', archive: 'archive', code: 'code', sheet: 'sheet', doc: 'doc', file: 'file' };
const PREV = { image: 1, video: 1, audio: 1, pdf: 1 };
const kindOf = (name) => { const e = name.indexOf('.') < 0 ? '' : name.split('.').pop().toLowerCase(); for (const k in EXT) if ((' ' + EXT[k] + ' ').indexOf(' ' + e + ' ') >= 0 && e) return k; return 'file'; };
const tile = (k, s) => '<span class="tile" style="--c:' + KC[k] + '">' + ico(GLYPH[k], s || 22) + '</span>';

/* ---------- state ---------- */
const S = { prefix: '', folders: [], files: [], shown: [], loading: true, error: '', q: '', by: 'name', dir: 1, view: ls.get('fm-view') || BOOT.view, seq: 0 };

/* ---------- api / toast / modal ---------- */
async function api(path, body) {
  let res;
  try { res = await fetch(path, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); }
  catch (e) { throw new Error('Network error. Check your connection and try again.'); }
  let data;
  try { data = await res.json(); }
  catch (e) { throw new Error(res.ok ? 'Unexpected response. Your login may have expired, so reload the page.' : 'Request failed (' + res.status + '). Reload the page if this keeps happening.'); }
  if (!res.ok) throw new Error(data.error || 'Request failed (' + res.status + ')');
  return data;
}
function toast(msg, type, ms) {
  const el = document.createElement('div');
  el.className = 'toast ' + (type || 'info');
  el.textContent = msg;
  $('#toasts').appendChild(el);
  requestAnimationFrame(() => el.classList.add('in'));
  const close = () => { el.classList.remove('in'); setTimeout(() => el.remove(), 260); };
  if (ms !== 0) setTimeout(close, ms || (type === 'err' ? 6000 : 3500));
  return { set(m) { el.textContent = m; }, close };
}
const modalEl = $('#modal');
let modalDone = null;
function openModal(html, onClose) { modalEl.innerHTML = html; modalEl.hidden = false; modalDone = onClose || null; document.body.classList.add('lock'); }
function closeModal() { modalEl.hidden = true; modalEl.innerHTML = ''; modalEl.onclick = null; document.body.classList.remove('lock'); const f = modalDone; modalDone = null; if (f) f(); }
modalEl.addEventListener('mousedown', (e) => { if (e.target === modalEl) closeModal(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !modalEl.hidden) closeModal(); });

function confirmDlg(title, msg, label) {
  return new Promise((resolve) => {
    let ok = false;
    openModal('<div class="dlg" role="dialog" aria-modal="true"><h2>' + esc(title) + '</h2><p>' + esc(msg) + '</p><div class="dlg-acts"><button class="btn" data-x="no">Cancel</button><button class="btn danger" data-x="yes">' + esc(label) + '</button></div></div>', () => resolve(ok));
    $('[data-x=no]', modalEl).focus();
    modalEl.onclick = (e) => { const b = e.target.closest('[data-x]'); if (!b) return; ok = b.dataset.x === 'yes'; closeModal(); };
  });
}
function askFolder() {
  return new Promise((resolve) => {
    let val = null;
    openModal('<form class="dlg" role="dialog" aria-modal="true"><h2>New folder</h2><p>It will be created in ' + esc(S.prefix ? '/' + S.prefix : 'the top level') + '</p><input id="fn" class="field" maxlength="120" placeholder="Folder name" autocomplete="off"><div class="dlg-acts"><button type="button" class="btn" data-x="no">Cancel</button><button type="submit" class="btn primary">Create folder</button></div></form>', () => resolve(val));
    const inp = $('#fn');
    inp.focus();
    $('form', modalEl).onsubmit = (e) => { e.preventDefault(); const v = inp.value.trim(); if (!v) { inp.focus(); return; } val = v; closeModal(); };
    modalEl.onclick = (e) => { if (e.target.closest('[data-x=no]')) closeModal(); };
  });
}

/* ---------- view ---------- */
function applyView() { $('#list').dataset.view = S.view; $('#btnView').innerHTML = ico(S.view === 'grid' ? 'list' : 'grid', 19); }
$('#btnView').onclick = () => { S.view = S.view === 'grid' ? 'list' : 'grid'; ls.set('fm-view', S.view); applyView(); };
$('#logo').innerHTML = ico('cloud', 21);
$('#searchIco').innerHTML = ico('search', 17);
$('#folderIco').innerHTML = ico('folderPlus', 18);
$('#uploadIco').innerHTML = ico('upload', 18);
$('#upToggle').innerHTML = ico('down', 18);
$('#upClear').innerHTML = ico('broom', 17);

/* ---------- browsing ---------- */
const KINDS = ['recent', 'image', 'video', 'audio', 'doc', 'archive', 'other'];
const KIND_TITLE = { recent: 'Recent files', image: 'Images', video: 'Videos', audio: 'Audio', doc: 'Documents', archive: 'Archives', other: 'Other files' };
const CAT = { image: ['Images', '#3b82f6', 'image'], video: ['Videos', '#ef4444', 'video'], audio: ['Audio', '#8b5cf6', 'audio'], doc: ['Documents', '#22a06b', 'doc'], archive: ['Archives', '#f59e0b', 'archive'], other: ['Other', '#64748b', 'file'] };
const NAV = [['', 'All files', 'folder'], ['recent', 'Recent', 'clock'], ['image', 'Images', 'image'], ['video', 'Videos', 'video'], ['audio', 'Audio', 'audio'], ['doc', 'Documents', 'doc'], ['archive', 'Archives', 'archive'], ['other', 'Other', 'file']];
S.kind = ''; S.usage = null; S.total = 0; S.shownFolders = [];
$('#sortDir').innerHTML = ico('sort', 17);

function readRoute() {
  const raw = location.hash.slice(1);
  if (raw.indexOf('view=') === 0) { const k = raw.slice(5); return { kind: KINDS.indexOf(k) >= 0 ? k : 'recent', prefix: '' }; }
  let h = '';
  try { h = decodeURIComponent(raw); } catch (e) {}
  if (h && !h.endsWith('/')) h += '/';
  return { kind: '', prefix: h };
}
function go(prefix) { location.hash = prefix ? encodeURIComponent(prefix) : ''; }
function setSort(by, dir) {
  S.by = by; S.dir = dir; $('#sortBy').value = by;
  const a = $('#sortDir').firstChild; if (a) a.style.transform = dir < 0 ? 'rotate(180deg)' : '';
}
function applyRoute() {
  const r = readRoute();
  S.kind = r.kind; S.prefix = r.prefix; S.q = ''; $('#q').value = '';
  if (S.kind) setSort('date', -1); else setSort('name', 1);
  load();
}
window.addEventListener('hashchange', applyRoute);

async function load(silent) {
  const seq = ++S.seq;
  if (!silent) { S.loading = true; S.error = ''; render(); }
  try {
    if (S.kind) {
      const d = await api('/api/browse?type=' + encodeURIComponent(S.kind));
      if (seq !== S.seq) return;
      S.folders = [];
      S.files = d.files.map((f) => { const i = f.key.lastIndexOf('/'); return { type: 'file', key: f.key, name: f.key.slice(i + 1), dir: i > 0 ? f.key.slice(0, i) : '', size: f.size, modified: f.modified }; });
      S.total = d.total;
      if (d.truncated) toast('Showing the newest ' + d.files.length + ' files only. Use the search box or folders to find older ones.', 'info', 6000);
    } else {
      const d = await api('/api/list?prefix=' + encodeURIComponent(S.prefix));
      if (seq !== S.seq) return;
      S.folders = d.folders.map((k) => ({ type: 'folder', key: k, name: k.slice(S.prefix.length).replace(/\/$/, '') }));
      S.files = d.files.map((f) => ({ type: 'file', key: f.key, name: f.key.slice(S.prefix.length), dir: '', size: f.size, modified: f.modified }));
      S.total = S.files.length;
      if (d.truncated) toast('This folder is very large, so only the first items are shown. Use the search box or sub-folders.', 'info', 6000);
    }
    S.loading = false; S.error = '';
  } catch (e) {
    if (seq !== S.seq) return;
    S.loading = false;
    if (silent) toast(e.message, 'err'); else S.error = e.message;
  }
  render();
}

async function loadUsage() {
  try {
    const u = await api('/api/usage');
    S.usage = u;
    $('#uBig').textContent = fmt(u.used);
    $('#uSub').textContent = u.count + (u.count === 1 ? ' file' : ' files') + (u.partial ? ' (at least)' : '');
    const keys = Object.keys(CAT).filter((k) => u.byType[k] && u.byType[k].count).sort((a, b) => u.byType[b].size - u.byType[a].size);
    $('#uSeg').innerHTML = u.used ? keys.map((k) => '<i title="' + CAT[k][0] + '" style="width:' + Math.max(1.5, (u.byType[k].size / u.used) * 100) + '%;background:' + CAT[k][1] + '"></i>').join('') : '';
    $('#uTypes').innerHTML = keys.length ? keys.map((k) => '<li><a href="#view=' + k + '"><span class="tile" style="--c:' + CAT[k][1] + '">' + ico(CAT[k][2], 18) + '</span><span class="t-n"><b>' + CAT[k][0] + '</b><small>' + u.byType[k].count + (u.byType[k].count === 1 ? ' file' : ' files') + '</small></span><span class="t-s">' + fmt(u.byType[k].size) + '</span></a></li>').join('') : '<li class="muted">Nothing stored yet</li>';
    renderNav();
  } catch (e) { $('#uBig').textContent = '–'; $('#uSub').textContent = e.message; }
}

function filtered() {
  const q = S.q.trim().toLowerCase();
  const match = (i) => !q || i.name.toLowerCase().indexOf(q) >= 0 || (i.dir && i.dir.toLowerCase().indexOf(q) >= 0);
  const byName = (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
  const cmp = S.by === 'size' ? (a, b) => a.size - b.size : S.by === 'date' ? (a, b) => (a.modified > b.modified ? 1 : a.modified < b.modified ? -1 : 0) : byName;
  const folders = S.folders.filter(match).sort(byName);
  if (S.by === 'name' && S.dir < 0) folders.reverse();
  return { folders: folders, files: S.files.filter(match).sort((a, b) => S.dir * cmp(a, b) || byName(a, b)) };
}

function itemHtml(it, i) {
  const k = kindOf(it.name), pv = PREV[k];
  let acts = '';
  if (pv) acts += '<button class="ib" data-act="preview" title="Preview" aria-label="Preview ' + esc(it.name) + '">' + ico('eye', 17) + '</button>';
  acts += '<button class="ib" data-act="download" title="Download" aria-label="Download ' + esc(it.name) + '">' + ico('download', 17) + '</button>';
  acts += '<button class="ib danger" data-act="delete" title="Delete" aria-label="Delete ' + esc(it.name) + '">' + ico('trash', 17) + '</button>';
  const date = esc(fdate(it.modified));
  return '<div class="item' + (pv ? ' go' : '') + '" data-i="' + i + '"><div class="main">' + tile(k, 20) + '<div class="nm"><b title="' + esc(it.key) + '">' + esc(it.name) + '</b>' + (it.dir ? '<small class="path">' + esc(it.dir) + '</small>' : '') + '<small class="sub"><span>' + fmt(it.size) + '</span><span>' + date + '</span></small></div></div><span class="sz">' + fmt(it.size) + '</span><span class="dt">' + date + '</span><div class="acts">' + acts + '</div></div>';
}
function folderHtml(f, i) {
  return '<div class="fcard" data-f="' + i + '"><div class="f-top">' + tile('folder', 22) + '<button class="ib danger" data-act="delete" title="Delete folder" aria-label="Delete folder ' + esc(f.name) + '">' + ico('trash', 17) + '</button></div><b title="' + esc(f.name) + '">' + esc(f.name) + '</b><small>Folder</small></div>';
}
function theadHtml() {
  const a = (k) => (S.by === k ? (S.dir > 0 ? ' ↑' : ' ↓') : '');
  return '<div class="thead"><span data-sort="name">Name' + a('name') + '</span><span data-sort="size">Size' + a('size') + '</span><span data-sort="date">Modified' + a('date') + '</span><span></span></div>';
}

function renderCrumbs() {
  const el = $('#crumbs');
  el.hidden = !(S.prefix || S.kind);
  const parts = S.prefix.split('/').filter(Boolean);
  let acc = '';
  let h = '<a href="#">' + esc(BOOT.title) + '</a>';
  if (S.kind) h += '<span class="sep">' + ico('chev', 15) + '</span><span class="cur">' + esc(KIND_TITLE[S.kind]) + '</span>';
  parts.forEach((p, i) => {
    acc += p + '/';
    h += '<span class="sep">' + ico('chev', 15) + '</span>' + (i === parts.length - 1 ? '<span class="cur">' + esc(p) + '</span>' : '<a href="#' + esc(encodeURIComponent(acc)) + '">' + esc(p) + '</a>');
  });
  el.innerHTML = h;
}
function renderNav() {
  const bt = (S.usage && S.usage.byType) || {};
  $('#nav').innerHTML = NAV.map((n) => {
    const on = n[0] === '' ? !S.kind : S.kind === n[0];
    const c = bt[n[0]] ? bt[n[0]].count : 0;
    return '<a href="' + (n[0] ? '#view=' + n[0] : '#') + '" class="' + (on ? 'on' : '') + '">' + ico(n[2], 18) + '<span>' + n[1] + '</span>' + (c ? '<em>' + c + '</em>' : '') + '</a>';
  }).join('');
}

function render() {
  renderCrumbs(); renderNav(); applyView();
  const list = $('#list'), typeMode = !!S.kind;
  $('#filesTitle').textContent = typeMode ? KIND_TITLE[S.kind] : 'Files';
  if (S.loading) {
    let h = '';
    for (let n = 0; n < 6; n++) h += '<div class="item"><div class="main"><span class="tile sk"></span><div class="nm" style="flex:1"><b class="sk" style="height:12px;width:60%;margin-bottom:7px"></b><small class="sk" style="height:10px;width:35%"></small></div></div></div>';
    $('#folderSec').hidden = true; list.innerHTML = h; $('#count').textContent = ''; return;
  }
  if (S.error) {
    $('#folderSec').hidden = true; $('#count').textContent = '';
    list.innerHTML = '<div class="empty"><h3>Could not load this view</h3><p>' + esc(S.error) + '</p><button class="btn primary" data-act="retry">Try again</button></div>';
    return;
  }
  const v = filtered();
  S.shown = v.files; S.shownFolders = v.folders;
  $('#folderSec').hidden = !v.folders.length;
  $('#folders').innerHTML = v.folders.map(folderHtml).join('');
  if (v.files.length) list.innerHTML = (S.view === 'list' ? theadHtml() : '') + v.files.map(itemHtml).join('');
  else if (S.q) list.innerHTML = '<div class="empty">' + tile('file', 28) + '<h3>No matches</h3><p>Nothing here matches “' + esc(S.q) + '”.</p></div>';
  else if (v.folders.length) list.innerHTML = '<div class="empty"><p>No files in this folder yet. Drop files anywhere to upload.</p></div>';
  else if (typeMode) list.innerHTML = '<div class="empty">' + tile('file', 28) + '<h3>Nothing here yet</h3><p>Files of this type will show up here.</p></div>';
  else list.innerHTML = '<div class="empty">' + tile('folder', 28) + '<h3>This folder is empty</h3><p>Drag files here or choose them from your device.</p><label class="btn primary" for="file">' + ico('upload', 17) + ' Add file</label></div>';
  const total = S.folders.length + S.total;
  const shown = v.folders.length + v.files.length;
  $('#count').textContent = S.q ? shown + ' of ' + total + ' items' : total + (total === 1 ? ' item' : ' items');
}

$('#q').addEventListener('input', (e) => { S.q = e.target.value; render(); });
$('#sortBy').addEventListener('change', (e) => { setSort(e.target.value, S.dir); render(); });
$('#sortDir').onclick = () => { setSort(S.by, -S.dir); render(); };
$('#btnView').addEventListener('click', render);
$('#folders').addEventListener('click', (e) => {
  const row = e.target.closest('[data-f]'); if (!row) return;
  const f = S.shownFolders[+row.dataset.f]; if (!f) return;
  if (e.target.closest('[data-act=delete]')) del(f); else go(f.key);
});
$('#list').addEventListener('click', (e) => {
  const s = e.target.closest('[data-sort]');
  if (s) { const k = s.dataset.sort; if (S.by === k) setSort(k, -S.dir); else setSort(k, k === 'date' ? -1 : 1); render(); return; }
  const act = e.target.closest('[data-act]');
  if (act && act.dataset.act === 'retry') { load(); return; }
  const row = e.target.closest('[data-i]'); if (!row) return;
  const it = S.shown[+row.dataset.i]; if (!it) return;
  if (act) { const a = act.dataset.act; if (a === 'download') download(it); else if (a === 'delete') del(it); else if (a === 'preview') preview(it); return; }
  if (PREV[kindOf(it.name)]) preview(it);
});

/* ---------- download / preview / delete / new folder ---------- */
async function download(it) {
  try {
    const r = await api('/api/url', { key: it.key, mode: 'download' });
    const a = document.createElement('a');
    a.href = r.url; a.rel = 'noopener'; a.style.display = 'none';
    document.body.appendChild(a); a.click(); a.remove();
  } catch (e) { toast(e.message, 'err'); }
}
async function preview(it) {
  const k = kindOf(it.name);
  openModal('<div class="pv" role="dialog" aria-modal="true"><div class="pv-h"><b>' + esc(it.name) + '</b><button class="btn" data-x="dl">' + ico('download', 16) + ' Download</button><button class="ib" data-x="close" aria-label="Close">' + ico('x', 18) + '</button></div><div class="pv-b" id="pvb"><div class="spin"></div></div></div>');
  modalEl.onclick = (e) => { const b = e.target.closest('[data-x]'); if (!b) return; if (b.dataset.x === 'close') closeModal(); else if (b.dataset.x === 'dl') download(it); };
  try {
    const r = await api('/api/url', { key: it.key, mode: 'inline' });
    const box = $('#pvb');
    if (!box) return;
    const u = esc(r.url);
    box.innerHTML = k === 'image' ? '<img src="' + u + '" alt="' + esc(it.name) + '">'
      : k === 'video' ? '<video src="' + u + '" controls playsinline autoplay></video>'
      : k === 'audio' ? '<audio src="' + u + '" controls autoplay></audio>'
      : '<iframe src="' + u + '" title="' + esc(it.name) + '"></iframe>';
    if (k === 'pdf') { const dl = $('[data-x=dl]', modalEl); if (dl) dl.insertAdjacentHTML('beforebegin', '<a class="btn" href="' + u + '" target="_blank" rel="noopener">Open</a>'); }
  } catch (e) { closeModal(); toast(e.message, 'err'); }
}
async function del(it) {
  const isF = it.type === 'folder';
  const ok = await confirmDlg(isF ? 'Delete this folder?' : 'Delete this file?', isF ? 'The folder “' + it.name + '” and everything inside it will be permanently deleted.' : '“' + it.name + '” will be permanently deleted.', 'Delete');
  if (!ok) return;
  const t = toast('Deleting…', 'info', 0);
  try {
    if (isF) {
      let n = 0;
      for (;;) { const r = await api('/api/delete-folder', { prefix: it.key }); if (!r.deleted) break; n += r.deleted; t.set('Deleting… ' + n + ' items removed'); }
    } else await api('/api/delete', { key: it.key });
    t.close(); toast('Deleted “' + it.name + '”', 'ok');
  } catch (e) { t.close(); toast(e.message, 'err'); }
  load(true); loadUsage();
}
$('#btnFolder').onclick = async () => {
  const name = await askFolder();
  if (!name) return;
  try { await api('/api/mkdir', { prefix: S.prefix, name: name }); toast('Folder created', 'ok'); load(true); }
  catch (e) { toast(e.message, 'err'); }
};

/* ---------- uploads ---------- */
const queue = [];
let uid = 0, running = false;
const getLoaded = (it) => (it.state === 'done' ? it.size : it.got ? Math.min(it.size, it.got.reduce((a, v) => a + v, 0)) : 0);

function enqueue(entries) {
  if (!entries.length) return;
  const prefix = S.prefix;
  entries.forEach((en) => queue.push({ id: ++uid, file: en.file, name: en.file.name, size: en.file.size, prefix: prefix, rel: en.rel || '', state: 'queued', got: null, speed: 0, samples: [], xhrs: new Set(), error: '' }));
  $('#uploads').classList.remove('min');
  renderUploads(); pump();
}
async function pump() {
  if (running) return;
  running = true;
  for (;;) {
    const it = queue.find((i) => i.state === 'queued');
    if (!it) break;
    await uploadFile(it);
  }
  running = false;
  paintUploads(); loadUsage(); load(true);
}
function putPart(it, url, blob, onProg) {
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    it.xhrs.add(x);
    x.open('PUT', url);
    x.upload.onprogress = (e) => onProg(e.loaded);
    x.onload = () => {
      it.xhrs.delete(x);
      if (x.status >= 200 && x.status < 300) {
        const tag = x.getResponseHeader('ETag');
        if (tag) resolve(tag);
        else { const er = new Error('R2 did not return an ETag. Add ETag to ExposeHeaders in the bucket CORS policy.'); er.fatal = true; reject(er); }
      } else reject(new Error('R2 answered with HTTP ' + x.status + (x.status === 403 ? ' (signature or permissions problem)' : '')));
    };
    x.onerror = () => { it.xhrs.delete(x); reject(new Error('Network or CORS error while sending a chunk')); };
    x.onabort = () => { it.xhrs.delete(x); reject(CANCEL); };
    x.send(blob);
  });
}
async function uploadPart(it, num, blob, onProg) {
  let last;
  for (let t = 1; t <= BOOT.retries; t++) {
    if (it.canceled || it.fail) throw CANCEL;
    try {
      const r = await api('/api/upload/part', { key: it.key, uploadId: it.uploadId, partNumber: num });
      onProg(0);
      return await putPart(it, r.url, blob, onProg);
    } catch (e) {
      if (e === CANCEL || e.fatal || it.canceled || it.fail) throw e;
      last = e;
      if (t < BOOT.retries) await sleep(700 * t * t);
    }
  }
  throw last;
}
async function uploadFile(it) {
  it.state = 'uploading'; it.canceled = false; it.fail = null; it.samples = []; it.got = [];
  renderUploads();
  let init = null;
  try {
    init = await api('/api/upload/init', { prefix: it.prefix, rel: it.rel, name: it.file.name, size: it.file.size, type: it.file.type || '' });
    it.name = init.key.split('/').pop();
    it.key = init.key;
    if (init.mode === 'multipart') {
      it.uploadId = init.uploadId;
      const n = init.parts, ps = init.partSize;
      const etags = new Array(n);
      it.got = new Array(n).fill(0);
      let next = 0;
      const run = async () => {
        try {
          while (!it.canceled && !it.fail) {
            const i = next++;
            if (i >= n) return;
            const blob = it.file.slice(i * ps, Math.min((i + 1) * ps, it.size));
            etags[i] = await uploadPart(it, i + 1, blob, (b) => { it.got[i] = b; });
            it.got[i] = blob.size;
          }
        } catch (e) {
          if (e !== CANCEL && !it.fail && !it.canceled) it.fail = e;
          it.xhrs.forEach((x) => x.abort());
        }
      };
      await Promise.all(Array.from({ length: Math.min(BOOT.parallel, n) }, run));
      if (it.canceled) throw CANCEL;
      if (it.fail) throw it.fail;
      await api('/api/upload/complete', { key: init.key, uploadId: init.uploadId, parts: etags.map((e, i) => ({ PartNumber: i + 1, ETag: e })) });
    } else if (it.canceled) throw CANCEL;
    it.state = 'done';
  } catch (e) {
    if (init && init.uploadId) api('/api/upload/abort', { key: init.key, uploadId: init.uploadId }).catch(() => {});
    if (it.canceled || e === CANCEL) it.state = 'canceled';
    else { it.state = 'error'; it.error = e.message || 'Upload failed'; }
  }
  renderUploads();
  load(true); loadUsage();
}
function cancelItem(it) {
  if (it.state === 'queued') it.state = 'canceled';
  else if (it.state === 'uploading') { it.canceled = true; it.xhrs.forEach((x) => x.abort()); }
  renderUploads();
}
function renderUploads() {
  const el = $('#uploads');
  if (!queue.length) { el.hidden = true; return; }
  el.hidden = false;
  $('#upList').innerHTML = queue.map((it) => {
    const btn = it.state === 'queued' || it.state === 'uploading' ? '<button class="ib" data-u="cancel" title="Cancel" aria-label="Cancel upload">' + ico('x', 16) + '</button>'
      : it.state === 'done' ? '<span class="u-ok">' + ico('check', 18) + '</span>'
      : '<button class="ib" data-u="retry" title="Try again" aria-label="Try again">' + ico('retry', 16) + '</button>';
    return '<div class="u-item ' + it.state + '" data-id="' + it.id + '"><div class="u-row"><span class="u-name" title="' + esc(it.name) + '">' + esc(it.name) + '</span>' + btn + '</div><div class="meter sm"><i data-b></i></div><small data-m></small></div>';
  }).join('');
  paintUploads();
}
function paintUploads() {
  if ($('#uploads').hidden) return;
  const now = performance.now();
  let tot = 0, got = 0, speed = 0, active = 0, done = 0, counted = 0;
  queue.forEach((it) => {
    const row = $('.u-item[data-id="' + it.id + '"]');
    const loaded = getLoaded(it);
    if (it.state === 'uploading') {
      it.samples.push([now, loaded]);
      if (it.samples.length > 6) it.samples.shift();
      const a = it.samples[0], b = it.samples[it.samples.length - 1];
      it.speed = b[0] > a[0] ? ((b[1] - a[1]) / (b[0] - a[0])) * 1000 : 0;
    } else it.speed = 0;
    if (it.state !== 'canceled' && it.state !== 'error') { tot += it.size; got += loaded; counted++; if (it.state === 'done') done++; else active++; }
    speed += it.speed;
    if (!row) return;
    const pct = it.size ? (loaded / it.size) * 100 : it.state === 'done' ? 100 : 0;
    $('[data-b]', row).style.width = (it.state === 'done' ? 100 : pct) + '%';
    $('[data-m]', row).textContent =
      it.state === 'queued' ? 'Waiting, ' + fmt(it.size)
      : it.state === 'uploading' ? Math.floor(pct) + '%, ' + fmt(loaded) + ' of ' + fmt(it.size) + (it.speed > 0 ? ', ' + fmt(it.speed) + '/s' : '')
      : it.state === 'done' ? 'Uploaded, ' + fmt(it.size)
      : it.state === 'canceled' ? 'Canceled' : it.error;
  });
  const pct = tot ? (got / tot) * 100 : 0;
  $('#upBar').style.width = pct + '%';
  $('#upTitle').textContent = active ? 'Uploading ' + (done + 1 > counted ? counted : done + 1) + ' of ' + counted : counted ? 'Uploads complete' : 'Uploads';
  const eta = speed > 0 ? Math.ceil((tot - got) / speed) : 0;
  $('#upSub').textContent = active ? ' ' + Math.floor(pct) + '%' + (speed > 0 ? ', ' + fmt(speed) + '/s' : '') + (eta ? ', about ' + (eta >= 60 ? Math.ceil(eta / 60) + ' min' : eta + ' s') + ' left' : '') : '';
}
setInterval(paintUploads, 500);
$('#upList').addEventListener('click', (e) => {
  const b = e.target.closest('[data-u]'); if (!b) return;
  const it = queue.find((i) => i.id === +b.closest('.u-item').dataset.id); if (!it) return;
  if (b.dataset.u === 'cancel') cancelItem(it);
  else { it.state = 'queued'; it.error = ''; it.xhrs.clear(); renderUploads(); pump(); }
});
$('#upToggle').onclick = () => { const m = $('#uploads').classList.toggle('min'); $('#upToggle').innerHTML = ico(m ? 'up' : 'down', 18); };
$('#upClear').onclick = () => { for (let i = queue.length - 1; i >= 0; i--) if (['done', 'canceled', 'error'].indexOf(queue[i].state) >= 0) queue.splice(i, 1); renderUploads(); };
window.addEventListener('beforeunload', (e) => { if (queue.some((i) => i.state === 'uploading' || i.state === 'queued')) { e.preventDefault(); e.returnValue = ''; } });

/* ---------- picking and dropping files ---------- */
$('#file').addEventListener('change', (e) => { enqueue(Array.from(e.target.files).map((f) => ({ file: f, rel: '' }))); e.target.value = ''; });
async function walk(entry, path, out) {
  try {
    if (entry.isFile) { const f = await new Promise((res, rej) => entry.file(res, rej)); out.push({ file: f, rel: path }); }
    else if (entry.isDirectory) {
      const rd = entry.createReader(); let all = [];
      for (;;) { const b = await new Promise((res, rej) => rd.readEntries(res, rej)); if (!b.length) break; all = all.concat(Array.from(b)); }
      for (const en of all) await walk(en, path + entry.name + '/', out);
    }
  } catch (e) { /* skip unreadable entries */ }
}
let dragN = 0;
const hasFiles = (e) => e.dataTransfer && Array.prototype.indexOf.call(e.dataTransfer.types || [], 'Files') >= 0;
window.addEventListener('dragenter', (e) => { if (!hasFiles(e)) return; e.preventDefault(); dragN++; $('#drop').classList.add('on'); });
window.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
window.addEventListener('dragleave', (e) => { if (!hasFiles(e)) return; dragN = Math.max(0, dragN - 1); if (!dragN) $('#drop').classList.remove('on'); });
window.addEventListener('drop', async (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault(); dragN = 0; $('#drop').classList.remove('on');
  const dt = e.dataTransfer;
  const ents = [];
  Array.from(dt.items || []).forEach((it) => { const en = it.kind === 'file' && it.webkitGetAsEntry ? it.webkitGetAsEntry() : null; if (en) ents.push(en); });
  const files = Array.from(dt.files);
  if (ents.length) { const out = []; for (const en of ents) await walk(en, '', out); enqueue(out); }
  else enqueue(files.map((f) => ({ file: f, rel: '' })));
});

/* ---------- start ---------- */
applyView();
applyRoute();
loadUsage();
