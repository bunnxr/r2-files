import { HAS_STREAMS, isZip, readZip, entryBlob, buildZip, mimeOf } from '/zip.js';
// Settings (title, colours, upload tuning) come from the Worker's CONFIG via /api/config.
let BOOT = { title: 'r2 by bunnxr', accent: '', parallel: 4, retries: 3, view: 'grid', publicHost: '', publicFolders: [], trashDays: 30 };
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
let V = null; // the open preview / gallery, if any

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
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
  more: '<circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/>',
  move: '<path d="M4 12h15M13 6l6 6-6 6"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/>',
  edit: '<path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16z"/>',
  save: '<path d="M5 4h11l3 3v13H5zM8 4v5h7V4M8 20v-6h8v6"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>',
  chevL: '<path d="m15 6-6 6 6 6"/>',
  note: '<path d="M5 4h14v11l-5 5H5zM14 20v-5h5M8 9h8M8 13h4"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  database: '<ellipse cx="12" cy="6" rx="8" ry="3"/><path d="M4 6v6c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6"/>',
  folderFill: '<path d="M3 6.5A2.5 2.5 0 0 1 5.5 4H9l2 2h7.5A2.5 2.5 0 0 1 21 8.5v9a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5z"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  broom: '<path d="M4 20h16M7 20l1-9h8l1 9M10 11V4h4v7"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="m11 12 8-8 3 3-2 2-2-2-2 2 2 2-3 3-2-2"/>'
};
const ico = (n, s) => { const f = /Fill$/.test(n); return '<svg class="i" width="' + (s || 18) + '" height="' + (s || 18) + '" viewBox="0 0 24 24" fill="' + (f ? 'currentColor' : 'none') + '" stroke="' + (f ? 'none' : 'currentColor') + '" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + P[n] + '</svg>'; };
const EXT = { image: 'jpg jpeg png gif webp avif svg bmp heic heif ico tif tiff', video: 'mp4 mov m4v webm mkv avi wmv', audio: 'mp3 wav flac aac m4a ogg opus', pdf: 'pdf', archive: 'zip rar 7z tar gz tgz bz2 xz', code: 'js ts jsx tsx json html css py rb go rs java c cpp h php sh sql yml yaml xml md', sheet: 'xls xlsx csv tsv ods numbers', doc: 'doc docx odt rtf txt pages ppt pptx key' };
const KC = { folder: '#4c9aff', image: '#10b981', video: '#ec4899', audio: '#8b5cf6', pdf: '#ef4444', archive: '#f59e0b', code: '#0ea5e9', sheet: '#22a06b', doc: '#3b82f6', file: '#94a3b8' };
const GLYPH = { folder: 'folder', image: 'image', video: 'video', audio: 'audio', pdf: 'doc', archive: 'archive', code: 'code', sheet: 'sheet', doc: 'doc', file: 'file' };
const PREV = { image: 1, video: 1, audio: 1, pdf: 1 };
const kindOf = (name) => { const e = name.indexOf('.') < 0 ? '' : name.split('.').pop().toLowerCase(); for (const k in EXT) if ((' ' + EXT[k] + ' ').indexOf(' ' + e + ' ') >= 0 && e) return k; return 'file'; };
const tile = (k, s) => (k === 'folder' ? '<span class="tile fold" style="--c:' + KC[k] + '">' + ico('folderFill', Math.round((s || 22) * 1.45)) + '</span>' : '<span class="tile" style="--c:' + KC[k] + '">' + ico(GLYPH[k], s || 22) + '</span>');

/* ---------- state ---------- */
const S = { notes: {}, selMode: false, sel: new Set(), prefix: '', folders: [], files: [], shown: [], loading: true, error: '', q: '', by: 'name', dir: 1, view: ls.get('fm-view') || BOOT.view, seq: 0 };

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
modalEl.addEventListener('mousedown', (e) => { if (e.target === modalEl && !(V && V.edit)) closeModal(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !modalEl.hidden && !(V && V.edit)) closeModal(); });

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
$('#upToggle').innerHTML = ico('down', 18);
$('#upClear').innerHTML = ico('broom', 17);

/* ---------- browsing ---------- */
const UPV = 'upload-password'; // the settings view: #view=upload-password
const KINDS = ['recent', 'image', 'video', 'audio', 'doc', 'archive', 'other', 'trash', 'links', UPV];
const KIND_TITLE = { recent: 'Recent files', image: 'Images', video: 'Videos', audio: 'Audio', doc: 'Documents', archive: 'Archives', other: 'Other files', trash: 'Trash', links: 'Links', [UPV]: 'Upload password' };
const CAT = { image: ['Images', '#3b82f6', 'image'], video: ['Videos', '#ef4444', 'video'], audio: ['Audio', '#8b5cf6', 'audio'], doc: ['Documents', '#22a06b', 'doc'], archive: ['Archives', '#f59e0b', 'archive'], other: ['Other', '#64748b', 'file'], trash: ['Trash', '#94a3b8', 'trash'] };
const NAV = [['', 'Files', 'folder'], ['links', 'Links', 'link'], [UPV, 'Upload password', 'key'], ['trash', 'Trash', 'trash']];
S.kind = ''; S.usage = null; S.total = 0; S.shownFolders = [];
const L = { list: [], shown: [], loading: false, error: '', off: false, seq: 0, activeCount: 0, filter: 'all' }; // Links page
const U = { loading: false, error: '', password: '', auto: 'off', rotatedAt: 0, draft: null, busy: false, seq: 0 }; // Upload password page
const SIX_DAYS_MS = 6 * 24 * 60 * 60 * 1000;
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
  S.kind = r.kind; S.prefix = r.prefix; S.q = (S.kind === 'links' && L.nextQ) || ''; L.nextQ = ''; $('#q').value = S.q; setSelMode(false);
  if (S.kind) setSort('date', -1); else setSort('name', 1);
  load();
}
window.addEventListener('hashchange', applyRoute);

async function load(silent) {
  if (S.kind === 'links') { ++S.seq; return loadLinks(silent); }
  if (S.kind === UPV) { ++S.seq; return loadUpAuth(silent); }
  const seq = ++S.seq;
  if (!silent) { S.loading = true; S.error = ''; render(); }
  try {
    const np = api('/api/notes').then((r) => { S.notes = r.notes || {}; }).catch(() => {});
    if (S.kind) {
      const d = await api('/api/browse?type=' + encodeURIComponent(S.kind));
      if (seq !== S.seq) return;
      S.folders = [];
      S.files = d.files.map((f) => {
        if (S.kind === 'trash') { const orig = f.key.replace(/^\.trash\/[^/]+\//, ''), t = orig.lastIndexOf('/'); return { type: 'file', key: f.key, trash: true, orig: orig, name: orig.slice(t + 1), dir: t > 0 ? orig.slice(0, t) : '', size: f.size, modified: f.modified }; }
        const i = f.key.lastIndexOf('/');
        return { type: 'file', key: f.key, name: f.key.slice(i + 1), dir: i > 0 ? f.key.slice(0, i) : '', size: f.size, modified: f.modified };
      });
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
    await np;
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
    renderNav();
  } catch (e) { $('#uBig').textContent = '–'; $('#uSub').textContent = e.message; }
}

function filtered() {
  const q = S.q.trim().toLowerCase();
  const match = (i) => !q || i.name.toLowerCase().indexOf(q) >= 0 || (i.dir && i.dir.toLowerCase().indexOf(q) >= 0) || (S.notes[i.key] || '').toLowerCase().indexOf(q) >= 0;
  const byName = (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
  const cmp = S.by === 'size' ? (a, b) => a.size - b.size : S.by === 'date' ? (a, b) => (a.modified > b.modified ? 1 : a.modified < b.modified ? -1 : 0) : byName;
  const folders = S.folders.filter(match).sort(byName);
  if (S.by === 'name' && S.dir < 0) folders.reverse();
  return { folders: folders, files: S.files.filter(match).sort((a, b) => S.dir * cmp(a, b) || byName(a, b)) };
}

function itemHtml(it, i) {
  const k = kindOf(it.name), note = S.notes[it.key] || '', date = esc(fdate(it.modified));
  return '<div class="item go" data-i="' + i + '"><div class="main"><input type="checkbox" class="sel" data-sel aria-label="Select ' + esc(it.name) + '"' + (S.sel.has(it.key) ? ' checked' : '') + '>' + tile(k, 20) + '<div class="nm"><b title="' + esc(it.trash ? it.orig : it.key) + '">' + esc(it.name) + '</b>' + (it.dir ? '<small class="path">' + esc(it.dir) + '</small>' : '') + '<small class="sub"><span>' + fmt(it.size) + '</span><span>' + date + '</span></small></div></div><span class="sz">' + fmt(it.size) + '</span><span class="dt">' + date + '</span><span class="nt' + (note ? '' : ' blank') + '" data-note="' + i + '" title="' + esc(note || 'Add a note') + '">' + esc(note || 'Add note') + '</span></div>';
}
function folderHtml(f, i) {
  return '<div class="fcard" data-f="' + i + '"><div class="f-top">' + tile('folder', 22) + '<button class="ib danger" data-act="delete" title="Move folder to trash" aria-label="Move folder ' + esc(f.name) + ' to trash">' + ico('trash', 17) + '</button></div><b title="' + esc(f.name) + '">' + esc(f.name) + '</b><small>Folder' + (isPublicKey(f.key) ? '<span class="badge">Public</span>' : '') + '</small></div>';
}
function theadHtml() {
  const a = (k) => (S.by === k ? (S.dir > 0 ? ' ↑' : ' ↓') : '');
  return '<div class="thead"><span class="th-n"><input type="checkbox" class="sel" data-selall aria-label="Select all"><span data-sort="name">Name' + a('name') + '</span></span><span data-sort="size">Size' + a('size') + '</span><span data-sort="date">Modified' + a('date') + '</span><span>Notes</span></div>';
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
    const c = n[0] === 'links' ? L.activeCount : bt[n[0]] ? bt[n[0]].count : 0;
    return '<a href="' + (n[0] ? '#view=' + n[0] : '#') + '" class="' + (on ? 'on' : '') + '">' + ico(n[2], 18) + '<span>' + n[1] + '</span>' + (c ? '<em>' + c + '</em>' : '') + '</a>';
  }).join('');
}

function render() {
  renderCrumbs(); renderNav(); applyView();
  // Settings view: no search, no folders, no sort controls, no file list
  const up = S.kind === UPV;
  $('#upSec').hidden = !up;
  $('#searchBar').hidden = up;
  if (up) {
    $('#linksSec').hidden = true; $('#filesSec').hidden = true; $('#folderSec').hidden = true;
    $('#selbar').hidden = true; $('#trashbar').hidden = true;
    renderUpAuth();
    return;
  }
  const lk = S.kind === 'links';
  $('#linksSec').hidden = !lk; $('#filesSec').hidden = lk;
  $('#q').placeholder = lk ? 'Search links and file names' : 'Search the files';
  if (lk) { $('#folderSec').hidden = true; $('#selbar').hidden = true; renderLinks(); return; }
  $('#trashbar').hidden = S.kind !== 'trash';
  $('#trashText').textContent = 'Deleted files stay here for ' + BOOT.trashDays + ' days, then they are removed automatically.';
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
  const have = new Set(S.files.map((f) => f.key));
  S.sel.forEach((k) => { if (!have.has(k)) S.sel.delete(k); });
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
  renderSel();
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
  if (e.target.closest('[data-selall]')) { selectAll(e.target.checked); return; }
  const s = e.target.closest('[data-sort]');
  if (s) { const k = s.dataset.sort; if (S.by === k) setSort(k, -S.dir); else setSort(k, k === 'date' ? -1 : 1); render(); return; }
  const act = e.target.closest('[data-act]');
  if (act && act.dataset.act === 'retry') { load(); return; }
  const row = e.target.closest('[data-i]'); if (!row) return;
  const it = S.shown[+row.dataset.i]; if (!it) return;
  if (e.target.closest('[data-sel]')) { toggleSel(it.key, e.target.checked); return; }
  if (e.target.closest('[data-note]')) { startNoteEdit(row, it); return; }
  if (S.selMode) { toggleSel(it.key, !S.sel.has(it.key)); const cb = row.querySelector('[data-sel]'); if (cb) cb.checked = S.sel.has(it.key); return; }
  if (act) { const a = act.dataset.act; if (a === 'download') download(it); else if (a === 'preview') preview(it); else if (a === 'share') { if (isPublicKey(it.key)) copyPublic(it); else openShare(it); } else if (a === 'more') { const r = act.getBoundingClientRect(); openMore(it, r.left, r.bottom + 4); } else if (a === 'restore') restoreItems([it]); else if (a === 'purge') purgeItems([it]); return; }
  if (it.trash) { ctxItem(it, e.clientX, e.clientY); return; }
  if (isViewable(it.name)) preview(it); else if (isZip(it.name)) openArchive(it); else ctxItem(it, e.clientX, e.clientY);
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

/* ---------- uploads ---------- */
const queue = [];
let uid = 0, running = false;
const getLoaded = (it) => (it.state === 'done' ? it.size : it.got ? Math.min(it.size, it.got.reduce((a, v) => a + v, 0)) : 0);

function enqueue(entries, prefixOverride) {
  if (!entries.length) return;
  const prefix = prefixOverride !== undefined ? prefixOverride : S.prefix;
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
const RESUME_KEY = 'fm-resume-v1';
const resumeLoad = () => { try { return JSON.parse(ls.get(RESUME_KEY) || '{}'); } catch (e) { return {}; } };
const resumeSave = (m) => ls.set(RESUME_KEY, JSON.stringify(m));
const fpOf = (it) => [it.file.name, it.file.size, it.file.lastModified].join('|');
function resumeSet(it, rec) { const m = resumeLoad(); m[fpOf(it)] = Object.assign({ t: Date.now(), name: it.file.name, size: it.file.size }, rec); resumeSave(m); }
function resumeDrop(it) { const m = resumeLoad(); delete m[fpOf(it)]; resumeSave(m); renderResumeNote(); }
async function uploadFile(it) {
  it.state = 'uploading'; it.canceled = false; it.fail = null; it.samples = []; it.got = []; it.resumed = 0;
  renderUploads();
  let init = null;
  try {
    // Unfinished upload of this exact file (same name, size and date)? Ask R2 which chunks it already has.
    let have = new Map();
    const rec = resumeLoad()[fpOf(it)];
    if (rec && rec.uploadId) {
      try {
        const r = await api('/api/upload/parts', { key: rec.key, uploadId: rec.uploadId });
        r.parts.forEach((p) => have.set(p.n, p));
        init = { mode: 'multipart', key: rec.key, uploadId: rec.uploadId, partSize: rec.partSize, parts: rec.parts };
      } catch (e) { resumeDrop(it); init = null; have = new Map(); }
    }
    if (!init) {
      init = await api('/api/upload/init', { prefix: it.prefix, rel: it.rel, name: it.file.name, size: it.file.size, type: it.file.type || '' });
      if (init.mode === 'multipart') resumeSet(it, { key: init.key, uploadId: init.uploadId, partSize: init.partSize, parts: init.parts });
    }
    it.name = init.key.split('/').pop();
    it.key = init.key;
    if (init.mode === 'multipart') {
      it.uploadId = init.uploadId;
      const n = init.parts, ps = init.partSize;
      const etags = new Array(n);
      it.got = new Array(n).fill(0);
      const finished = new Array(n).fill(false);
      have.forEach((p, num) => {
        const want = num < n ? ps : it.size - ps * (n - 1);
        if (num >= 1 && num <= n && p.size === want && p.etag) { etags[num - 1] = p.etag; it.got[num - 1] = want; finished[num - 1] = true; it.resumed++; }
      });
      let next = 0;
      const run = async () => {
        try {
          while (!it.canceled && !it.fail) {
            const i = next++;
            if (i >= n) return;
            if (finished[i]) continue;
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
    resumeDrop(it);
    it.state = 'done';
  } catch (e) {
    if (it.canceled || e === CANCEL) {
      if (init && init.uploadId) api('/api/upload/abort', { key: init.key, uploadId: init.uploadId }).catch(() => {});
      resumeDrop(it);
      it.state = 'canceled';
    } else {
      // keep the multipart upload: "try again" (or choosing the file later) continues where it stopped
      it.state = 'error'; it.error = (e.message || 'Upload failed') + ' Try again to continue.';
    }
  }
  renderUploads();
  renderResumeNote();
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
window.addEventListener('beforeunload', (e) => { if (job || queue.some((i) => i.state === 'uploading' || i.state === 'queued')) { e.preventDefault(); e.returnValue = ''; } });

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
window.addEventListener('dragenter', (e) => { if (!hasFiles(e) || !modalEl.hidden) return; e.preventDefault(); dragN++; $('#drop').classList.add('on'); });
window.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
window.addEventListener('dragleave', (e) => { if (!hasFiles(e)) return; dragN = Math.max(0, dragN - 1); if (!dragN) $('#drop').classList.remove('on'); });
window.addEventListener('drop', async (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault(); dragN = 0; $('#drop').classList.remove('on');
  if (!modalEl.hidden) return;
  const dt = e.dataTransfer;
  const ents = [];
  Array.from(dt.items || []).forEach((it) => { const en = it.kind === 'file' && it.webkitGetAsEntry ? it.webkitGetAsEntry() : null; if (en) ents.push(en); });
  const files = Array.from(dt.files);
  if (ents.length) { const out = []; for (const en of ents) await walk(en, '', out); enqueue(out); }
  else enqueue(files.map((f) => ({ file: f, rel: '' })));
});

/* ---------- selection, archives (browse / extract) and "zip selected" ---------- */
function renderSel() {
  const n = S.sel.size, tr = S.kind === 'trash';
  $('#selbar').hidden = !(n || S.selMode);
  $('#selClear').hidden = !n;
  ['selDl', 'selZip', 'selMove', 'selCopy', 'selDel'].forEach((id) => { $('#' + id).hidden = tr || !n; });
  ['selRestore', 'selPurge'].forEach((id) => { $('#' + id).hidden = !tr || !n; });
  if (n) { let sz = 0; S.files.forEach((f) => { if (S.sel.has(f.key)) sz += f.size; }); $('#selCount').textContent = n + (n === 1 ? ' file selected' : ' files selected') + ' (' + fmt(sz) + ')'; }
  if (!n) $('#selCount').textContent = 'Tap files to select them';
  const all = $('[data-selall]');
  if (all) { const c = S.shown.filter((f) => S.sel.has(f.key)).length; all.checked = c > 0 && c === S.shown.length; all.indeterminate = c > 0 && c < S.shown.length; }
}
function toggleSel(key, on) { if (on) S.sel.add(key); else S.sel.delete(key); renderSel(); }
function selectAll(on) {
  S.shown.forEach((f) => { if (on) S.sel.add(f.key); else S.sel.delete(f.key); });
  document.querySelectorAll('#list [data-sel]').forEach((cb) => { cb.checked = on; });
  renderSel();
}
$('#selClear').onclick = () => { S.sel.clear(); document.querySelectorAll('#list [data-sel]').forEach((cb) => { cb.checked = false; }); renderSel(); };

let job = null;
function startJob(title) {
  if (job) { toast('Another task is still running.', 'info'); return null; }
  job = { canceled: false };
  $('#jobTitle').textContent = title; $('#jobSub').textContent = 'Starting…'; $('#jobBar').style.width = '0%'; $('#job').hidden = false;
  return job;
}
function updateJob(sub, pct) { $('#jobSub').textContent = sub; if (pct != null) $('#jobBar').style.width = pct + '%'; }
function endJob() { job = null; $('#job').hidden = true; }
$('#jobCancel').onclick = () => { if (job) { job.canceled = true; if (job.onCancel) job.onCancel(); $('#jobSub').textContent = 'Canceling…'; } };

function askName(title, desc, def, label) {
  return new Promise((resolve) => {
    let val = null;
    openModal('<form class="dlg" role="dialog" aria-modal="true"><h2>' + esc(title) + '</h2><p>' + esc(desc) + '</p><input id="fn" class="field" maxlength="120" value="' + esc(def) + '" autocomplete="off"><div class="dlg-acts"><button type="button" class="btn" data-x="no">Cancel</button><button type="submit" class="btn primary">' + esc(label) + '</button></div></form>', () => resolve(val));
    const inp = $('#fn'); inp.focus(); inp.select();
    $('form', modalEl).onsubmit = (e) => { e.preventDefault(); const v = inp.value.trim(); if (!v) { inp.focus(); return; } val = v; closeModal(); };
    modalEl.onclick = (e) => { if (e.target.closest('[data-x=no]')) closeModal(); };
  });
}
function saveBlob(blob, name) {
  const u = URL.createObjectURL(blob), a = document.createElement('a');
  a.href = u; a.download = name; a.style.display = 'none';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(u), 60000);
}

/* --- zip selected --- */
async function zipSelected(toDevice) {
  const chosen = S.files.filter((f) => S.sel.has(f.key));
  if (!chosen.length) return;
  if (!HAS_STREAMS) { toast('Your browser is too old for zipping (needs Chrome 103, Safari 16.4 or Firefox 113 or newer).', 'err'); return; }
  const prefix = S.prefix;
  const stamp = new Date().toISOString().slice(0, 16).replace(/[-:]/g, '').replace('T', '-');
  const name = toDevice ? 'files-' + stamp : await askName('Save a zip in R2', 'The zip will be saved in ' + (prefix ? '/' + prefix : 'the top level') + '.', 'archive.zip', 'Create zip');
  if (!name) return;
  const zname = /\.zip$/i.test(name) ? name : name + '.zip';
  const j = startJob('Creating ' + zname);
  if (!j) return;
  try {
    const items = chosen.map((f) => ({ zipName: S.kind ? f.key : f.name, size: f.size, modified: f.modified, getUrl: async () => '/api/read?key=' + encodeURIComponent(f.key) }));
    const blob = await buildZip(items, { canceled: () => j.canceled, onProgress: (read, total, i, nm) => updateJob((i + 1) + ' of ' + items.length + ': ' + nm, Math.min(99, total ? (read / total) * 100 : 0)) });
    if (toDevice) saveBlob(blob, zname); else enqueue([{ file: new File([blob], zname, { type: 'application/zip' }), rel: '' }], prefix);
    if (!toDevice) { S.sel.clear(); document.querySelectorAll('#list [data-sel]').forEach((cb) => { cb.checked = false; }); renderSel(); }
    toast(toDevice ? 'Your zip is downloading.' : 'Zip ready. Uploading ' + zname + '…', 'ok');
  } catch (e) { if (!j.canceled) toast(e.message, 'err'); }
  endJob();
}

/* --- browse an archive --- */
let arc = null;
const nameCmp = (a, b) => (a.name || a.base).localeCompare(b.name || b.base, undefined, { numeric: true, sensitivity: 'base' });
async function arcUrl(A) { return A.url; }
function arcChildren(A, dir) {
  const folders = new Map(), files = [];
  A.entries.forEach((e, i) => {
    if (e.path.indexOf(dir) !== 0) return;
    const rest = e.path.slice(dir.length);
    if (!rest) return;
    const k = rest.indexOf('/');
    if (k < 0) { if (!e.dir) files.push(i); return; }
    const n = rest.slice(0, k);
    const f = folders.get(n) || { name: n, count: 0, size: 0 };
    if (!e.dir) { f.count++; f.size += e.usize; }
    folders.set(n, f);
  });
  return { folders: Array.from(folders.values()).sort(nameCmp), files: files.sort((a, b) => nameCmp(A.entries[a], A.entries[b])) };
}
function arcUnder(A, prefix) { const r = []; A.entries.forEach((e, i) => { if (!e.dir && !e.bad && e.path.indexOf(prefix) === 0) r.push(i); }); return r; }
function arcRow(A, i) {
  const e = A.entries[i], k = kindOf(e.base);
  const pv = PREV[k] && !e.bad && e.usize <= 500 * 1048576;
  let acts = '';
  if (!e.bad) {
    if (pv) acts += '<button class="ib" data-aa="preview" title="Preview" aria-label="Preview ' + esc(e.base) + '">' + ico('eye', 17) + '</button>';
    acts += '<button class="ib" data-aa="download" title="Download" aria-label="Download ' + esc(e.base) + '">' + ico('download', 17) + '</button>';
  }
  return '<div class="arow" data-ai="' + i + '"><input type="checkbox" class="sel" data-asel aria-label="Select ' + esc(e.base) + '"' + (A.sel.has(i) ? ' checked' : '') + (e.bad ? ' disabled' : '') + '><div class="main">' + tile(k, 18) + '<div class="nm"><b title="' + esc(e.path) + '">' + esc(e.base) + '</b><small class="sub">' + (e.bad ? esc(e.reason) : fmt(e.usize)) + '</small></div></div><span class="sz">' + (e.bad ? esc(e.reason) : fmt(e.usize)) + '</span><span class="dt">' + esc(fdate(e.date)) + '</span><div class="acts">' + acts + '</div></div>';
}
function arcFolderRow(A, f) {
  const pre = A.dir + f.name + '/', idx = arcUnder(A, pre);
  const all = idx.length > 0 && idx.every((i) => A.sel.has(i));
  return '<div class="arow" data-af="' + esc(pre) + '"><input type="checkbox" class="sel" data-fsel aria-label="Select folder ' + esc(f.name) + '"' + (all ? ' checked' : '') + (idx.length ? '' : ' disabled') + '><div class="main">' + tile('folder', 18) + '<div class="nm"><b>' + esc(f.name) + '</b><small class="sub">' + f.count + (f.count === 1 ? ' file' : ' files') + '</small></div></div><span class="sz">' + fmt(f.size) + '</span><span class="dt"></span><div class="acts"></div></div>';
}
function renderArc() {
  const A = arc; if (!A) return;
  const old = $('#arcList'), top = old ? old.scrollTop : 0;
  const files = A.entries.filter((e) => !e.dir && !e.bad);
  const total = files.reduce((n, e) => n + e.usize, 0), nSel = A.sel.size;
  let crumbs, body = '';
  if (A.view) {
    crumbs = '<a data-x="back">&larr; Back to list</a><b>' + esc(A.view.name) + '</b>';
    body = '<div class="arc-view">' + A.view.html + '</div>';
  } else {
    crumbs = '<a data-d="">' + esc(A.it.name) + '</a>';
    let acc = '';
    A.dir.split('/').filter(Boolean).forEach((p) => { acc += p + '/'; crumbs += '<span class="sep">' + ico('chev', 14) + '</span><a data-d="' + esc(acc) + '">' + esc(p) + '</a>'; });
    const ch = arcChildren(A, A.dir);
    body = ch.folders.map((f) => arcFolderRow(A, f)).join('') + ch.files.map((i) => arcRow(A, i)).join('');
    if (!body) body = '<div class="empty"><p>This archive is empty.</p></div>';
  }
  modalEl.innerHTML = '<div class="pv arc" role="dialog" aria-modal="true"><div class="pv-h"><b>' + esc(A.it.name) + '</b><button class="btn primary" data-x="extract"' + (files.length ? '' : ' disabled') + '>' + (nSel ? 'Extract selected (' + nSel + ')' : 'Extract all here') + '</button><button class="ib" data-x="close" aria-label="Close">' + ico('x', 18) + '</button></div><div class="arc-bar"><div class="arc-crumbs">' + crumbs + '</div>' + (A.view ? '' : '<label class="arc-all"><input type="checkbox" class="sel" data-aall' + (files.length && nSel === files.length ? ' checked' : '') + '> Select all</label><span>' + files.length + (files.length === 1 ? ' file, ' : ' files, ') + fmt(total) + '</span>') + '</div><div class="arc-list" id="arcList">' + body + '</div></div>';
  $('#arcList').scrollTop = top;
}
function arcBack() { const A = arc; if (!A || !A.view) return; URL.revokeObjectURL(A.view.url); A.view = null; renderArc(); }
function showArc() {
  openModal('', () => { if (arc && arc.view) URL.revokeObjectURL(arc.view.url); arc = null; });
  modalEl.onclick = arcClick;
  renderArc();
}
function arcClick(e) {
  const A = arc; if (!A) return;
  const x = e.target.closest('[data-x]');
  if (x) { const a = x.dataset.x; if (a === 'close') closeModal(); else if (a === 'back') arcBack(); else if (a === 'extract') arcExtract(); return; }
  const d = e.target.closest('[data-d]');
  if (d) { A.dir = d.dataset.d; renderArc(); $('#arcList').scrollTop = 0; return; }
  if (e.target.closest('[data-aall]')) { A.sel.clear(); if (e.target.checked) A.entries.forEach((en, i) => { if (!en.dir && !en.bad) A.sel.add(i); }); renderArc(); return; }
  const fs = e.target.closest('[data-fsel]');
  if (fs) { arcUnder(A, fs.closest('[data-af]').dataset.af).forEach((i) => { if (fs.checked) A.sel.add(i); else A.sel.delete(i); }); renderArc(); return; }
  const row = e.target.closest('[data-ai]');
  if (row) {
    const i = +row.dataset.ai, aa = e.target.closest('[data-aa]');
    if (e.target.closest('[data-asel]')) { if (e.target.checked) A.sel.add(i); else A.sel.delete(i); renderArc(); return; }
    if (aa) arcOpen(A, A.entries[i], aa.dataset.aa);
    return;
  }
  const fr = e.target.closest('[data-af]');
  if (fr) { A.dir = fr.dataset.af; renderArc(); $('#arcList').scrollTop = 0; }
}
async function openArchive(it) {
  if (!HAS_STREAMS) { toast('Your browser is too old to open archives (needs Chrome 103, Safari 16.4 or Firefox 113 or newer).', 'err'); return; }
  openModal('<div class="pv"><div class="pv-b"><div class="spin"></div></div></div>');
  try {
    const url = '/api/read?key=' + encodeURIComponent(it.key);
    const entries = await readZip(url, it.size);
    arc = { it, url, t: Date.now(), entries, dir: '', sel: new Set(), view: null };
    showArc();
  } catch (e) { closeModal(); toast(e.message, 'err'); }
}
async function arcOpen(A, e, mode) {
  const t = toast((mode === 'preview' ? 'Opening ' : 'Preparing ') + e.base + '…', 'info', 0);
  try {
    const blob = await entryBlob(await arcUrl(A), e, mimeOf(e.path));
    t.close();
    if (mode === 'download') { saveBlob(blob, e.base); return; }
    if (arc !== A) return;
    const u = URL.createObjectURL(blob), k = kindOf(e.base);
    A.view = { name: e.path, url: u, html: k === 'image' ? '<img src="' + u + '" alt="">' : k === 'video' ? '<video src="' + u + '" controls playsinline autoplay></video>' : k === 'audio' ? '<audio src="' + u + '" controls autoplay></audio>' : '<iframe src="' + u + '" title="' + esc(e.base) + '"></iframe>' };
    renderArc();
  } catch (err) { t.close(); toast(err.message, 'err'); }
}

/* --- extract here: sends the files to the normal uploader, a couple at a time --- */
async function arcExtract() {
  const A = arc; if (!A) return;
  const idx = A.sel.size ? Array.from(A.sel).sort((a, b) => a - b) : A.entries.map((e, i) => i).filter((i) => !A.entries[i].dir && !A.entries[i].bad);
  const list = idx.map((i) => A.entries[i]);
  if (!list.length) return;
  const dest = A.it.key.slice(0, A.it.key.lastIndexOf('/') + 1);
  const size = list.reduce((n, e) => n + e.usize, 0);
  const ok = await confirmDlg('Extract here?', 'Extract ' + list.length + (list.length === 1 ? ' file' : ' files') + ' (' + fmt(size) + ') into ' + (dest ? '/' + dest : 'the top level') + '? Folder structure is kept and existing files are never overwritten.', 'Extract');
  if (!ok) { showArc(); return; }
  arc = null;
  const j = startJob('Extracting ' + A.it.name);
  if (!j) return;
  let done = 0;
  try {
    for (const e of list) {
      while (!j.canceled && queue.filter((q) => q.state === 'queued').length >= 2) await sleep(300);
      if (j.canceled) break;
      updateJob((done + 1) + ' of ' + list.length + ': ' + e.path, (done / list.length) * 100);
      const blob = await entryBlob(await arcUrl(A), e, mimeOf(e.path));
      const parts = e.path.split('/'), base = parts.pop();
      enqueue([{ file: new File([blob], base, { type: blob.type }), rel: parts.join('/') }], dest);
      done++;
    }
    toast(j.canceled ? 'Extraction canceled after ' + done + ' files.' : 'Extracted ' + done + (done === 1 ? ' file' : ' files') + '. Uploads continue in the panel.', j.canceled ? 'info' : 'ok');
  } catch (err) { toast('Extraction stopped: ' + err.message, 'err'); }
  endJob();
}

/* ---------- links, trash, move/copy, viewer + editor, URL upload, paste, resume, PWA ---------- */
const TEXT_EXT = ' txt md markdown json csv tsv log js mjs ts jsx tsx css html htm xml yml yaml toml ini conf cfg env sh bash py rb go rs java c cpp h hpp cs php sql srt vtt ';
const isText = (n) => { const e = n.indexOf('.') < 0 ? '' : n.split('.').pop().toLowerCase(); return (!!e && TEXT_EXT.indexOf(' ' + e + ' ') >= 0) || /^(readme|license|dockerfile|makefile)$/i.test(n); };
const isViewable = (n) => !!PREV[kindOf(n)] || isText(n);
const isEditable = (n, size) => isText(n) && size <= 1048576;
const isPublicKey = (key) => !!BOOT.publicHost && (BOOT.publicFolders || []).some((p) => key.indexOf(p) === 0);
const publicUrl = (key) => 'https://' + BOOT.publicHost + '/' + key.split('/').map(encodeURIComponent).join('/');
const tid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 5);

async function copyText(t) {
  try { await navigator.clipboard.writeText(t); return true; } catch (e) { /* try the old way */ }
  try { const ta = document.createElement('textarea'); ta.value = t; ta.style.cssText = 'position:fixed;opacity:0'; document.body.appendChild(ta); ta.select(); const ok = document.execCommand('copy'); ta.remove(); return ok; } catch (e) { return false; }
}
function copyPublic(it) { const u = publicUrl(it.key); copyText(u).then((ok) => toast(ok ? 'Public link copied' : u, ok ? 'ok' : 'info', ok ? 3000 : 9000)); }

/* --- generic helpers: action sheet, batches --- */
function sheet(title, rows) {
  return new Promise((resolve) => {
    let val = null;
    openModal('<div class="dlg" role="dialog" aria-modal="true"><h2>' + esc(title) + '</h2><div class="sheet">' + rows.map((r) => '<button data-pick="' + r[0] + '"' + (r[3] ? ' class="danger"' : '') + '>' + ico(r[1], 19) + '<span>' + esc(r[2]) + '</span></button>').join('') + '</div></div>', () => resolve(val));
    modalEl.onclick = (e) => { const b = e.target.closest('[data-pick]'); if (b) { val = b.dataset.pick; closeModal(); } };
  });
}
async function runBatches(title, list, size, call) {
  const j = startJob(title);
  if (!j) return null;
  let done = 0;
  const errors = [];
  try {
    for (let i = 0; i < list.length && !j.canceled; i += size) {
      updateJob(done + ' of ' + list.length, (done / list.length) * 100);
      const chunk = list.slice(i, i + size);
      const r = await call(chunk);
      const bad = r && r.errors ? r.errors : [];
      done += chunk.length - bad.length;
      bad.forEach((x) => errors.push(x.error || String(x)));
    }
  } catch (e) { errors.push(e.message); }
  const canceled = j.canceled;
  endJob();
  return { done, errors, canceled };
}
function report(verb, r) {
  if (!r) return;
  const n = r.done + (r.done === 1 ? ' file' : ' files');
  if (r.errors.length) toast(verb + ' ' + n + '. ' + r.errors.length + ' failed: ' + r.errors[0], 'err', 9000);
  else toast(r.canceled ? 'Stopped after ' + n + '.' : verb + ' ' + n + '.', r.canceled ? 'info' : 'ok');
  setSelMode(false); load(true); loadUsage();
}

/* --- trash --- */
async function del(it) {
  if (S.kind === 'trash') return purgeItems([it]);
  const isF = it.type === 'folder';
  const ok = await confirmDlg(isF ? 'Move folder to trash?' : 'Move to trash?', (isF ? '“' + it.name + '” and everything inside it' : '“' + it.name + '”') + ' will be moved to the trash. You can restore it for ' + BOOT.trashDays + ' days.', 'Move to trash');
  if (!ok) return;
  if (isF) await trashFolder(it); else await trashFiles([it]);
}
async function trashFiles(list) {
  const id = tid();
  report('Moved to trash:', await runBatches('Moving to trash', list, 12, (ch) => api('/api/trash', { keys: ch.map((f) => f.key), id })));
}
async function trashFolder(f) {
  const id = tid(), j = startJob('Moving “' + f.name + '” to trash');
  if (!j) return;
  let n = 0;
  const errs = [];
  try {
    for (;;) {
      if (j.canceled) break;
      const r = await api('/api/trash-folder', { prefix: f.key, id });
      if (!r.listed) break;
      n += r.moved; r.errors.forEach((x) => errs.push(x.error));
      updateJob(n + ' files moved', null);
      if (!r.moved) break;
    }
  } catch (e) { errs.push(e.message); }
  endJob();
  if (errs.length) toast('Some files could not be moved: ' + errs[0], 'err', 9000); else toast(j.canceled ? 'Stopped after ' + n + ' files.' : 'Folder moved to trash.', j.canceled ? 'info' : 'ok');
  load(true); loadUsage();
}
async function restoreItems(list) {
  if (!list.length) return;
  report('Restored', await runBatches('Restoring', list, 8, (ch) => api('/api/restore', { keys: ch.map((f) => f.key) })));
}
async function purgeItems(list) {
  if (!list.length) return;
  const ok = await confirmDlg('Delete forever?', (list.length === 1 ? '“' + list[0].name + '” will' : list.length + ' files will') + ' be permanently deleted. This cannot be undone.', 'Delete forever');
  if (!ok) return;
  report('Deleted', await runBatches('Deleting forever', list, 1, async (ch) => { await api('/api/delete', { key: ch[0].key }); return {}; }));
}
async function emptyTrash() {
  const ok = await confirmDlg('Empty the trash?', 'Everything in the trash will be permanently deleted.', 'Empty trash');
  if (!ok) return;
  const j = startJob('Emptying the trash');
  if (!j) return;
  let n = 0;
  try {
    for (;;) { if (j.canceled) break; const r = await api('/api/empty-trash', {}); if (!r.deleted) break; n += r.deleted; updateJob(n + ' files deleted', null); }
    toast('Trash emptied.', 'ok');
  } catch (e) { toast(e.message, 'err'); }
  endJob(); load(true); loadUsage();
}
$('#emptyTrash').onclick = emptyTrash;

/* --- move / copy --- */
function pickFolder(title, label, start) {
  return new Promise((resolve) => {
    let dir = start || '', val = null;
    const draw = async () => {
      let cr = '<a data-d="">' + esc(BOOT.title) + '</a>', acc = '';
      dir.split('/').filter(Boolean).forEach((p) => { acc += p + '/'; cr += '<span class="sep">' + ico('chev', 14) + '</span><a data-d="' + esc(acc) + '">' + esc(p) + '</a>'; });
      modalEl.innerHTML = '<div class="dlg pick" role="dialog" aria-modal="true"><h2>' + esc(title) + '</h2><div class="arc-crumbs">' + cr + '</div><div class="pk-list" id="pkList"><div class="spin" style="margin:28px auto"></div></div><div class="dlg-acts"><button class="btn" data-x="no">Cancel</button><button class="btn primary" data-x="ok">' + esc(label) + '</button></div></div>';
      const mine = dir;
      try {
        const d = await api('/api/list?prefix=' + encodeURIComponent(dir));
        if (mine !== dir || !$('#pkList')) return;
        $('#pkList').innerHTML = d.folders.length ? d.folders.map((f) => '<div class="pk-row" data-d="' + esc(f) + '">' + ico('folder', 18) + '<span>' + esc(f.slice(dir.length).replace(/\/$/, '')) + '</span></div>').join('') : '<div class="empty" style="padding:28px 12px"><p>No folders in here. You can choose this one.</p></div>';
      } catch (e) { if ($('#pkList')) $('#pkList').innerHTML = '<div class="empty"><p>' + esc(e.message) + '</p></div>'; }
    };
    openModal('', () => resolve(val));
    modalEl.onclick = (e) => {
      const d = e.target.closest('[data-d]');
      if (d) { dir = d.dataset.d; draw(); return; }
      const x = e.target.closest('[data-x]');
      if (!x) return;
      if (x.dataset.x === 'ok') val = dir;
      closeModal();
    };
    draw();
  });
}
async function moveFiles(list, mode) {
  if (!list.length) return;
  const copy = mode === 'copy';
  const dest = await pickFolder(copy ? 'Copy to…' : 'Move to…', copy ? 'Copy here' : 'Move here', S.kind ? '' : S.prefix);
  if (dest === null) return;
  report(copy ? 'Copied' : 'Moved', await runBatches((copy ? 'Copying ' : 'Moving ') + list.length + (list.length === 1 ? ' file' : ' files'), list, 8, (ch) => api('/api/move', { keys: ch.map((f) => f.key), dest, mode })));
}

/* --- share links --- */
async function openShare(it) {
  const pub = isPublicKey(it.key), host = !!BOOT.publicHost;
  openModal('<div class="dlg" role="dialog" aria-modal="true"><h2>Share “' + esc(it.name) + '”</h2>' +
    (pub ? '<span class="lbl2">Public folder link</span><button class="btn primary block" data-s="public">' + ico('globe', 17) + ' Copy public link</button>' : '') +
    '<span class="lbl2">' + (host ? 'Short link' : 'Expiring link') + '</span><div class="seg4"><button class="btn" data-s="3600">1 hour</button><button class="btn" data-s="86400">1 day</button><button class="btn" data-s="604800">7 days</button>' + (host ? '<button class="btn" data-s="0">Never expires</button>' : '') + '</div>' +
    '<div class="copyrow" id="shRow" hidden><input id="shLink" class="field" readonly><button class="btn" data-c="1">Copy</button></div>' +
    '<small class="hint" id="shNote">' + (host ? 'The address stays the same whatever you pick; only how long it works changes.' : 'Pick how long the link should work. It is copied for you.') + '</small>' +
    (host ? '<div class="sh-more"><button type="button" class="link" data-new="1">' + ico('plus', 15) + ' New separate link…</button><button type="button" class="link" data-all="1">' + ico('link', 15) + ' All links of this file</button></div>' : '') +
    '<div class="dlg-acts"><button class="btn danger" id="shRemove" data-rm="1" hidden>Remove link</button><button class="btn" data-x="no">Close</button></div></div>');
  const note = (t) => { const n = $('#shNote'); if (n) n.textContent = t; };
  const when = (exp) => (exp ? 'Works until ' + new Date(exp * 1000).toLocaleString() + '.' : 'Never expires.');
  const show = async (url, text, copy) => { if (!$('#shRow')) return; $('#shRow').hidden = false; const f = $('#shLink'); f.value = url; f.select(); const ok = copy ? await copyText(url) : false; note((ok ? 'Copied. ' : '') + text); };
  if (host) api('/api/link-info', { key: it.key }).then((i) => { if (i.exists && $('#shRow')) { show(i.url, i.active ? 'Current link. ' + when(i.exp) : 'This link has expired. Pick a length to turn it on again.', false); if (i.active) $('#shRemove').hidden = false; } }).catch(() => {});
  modalEl.onclick = async (e) => {
    if (e.target.closest('[data-x]')) { closeModal(); return; }
    if (e.target.closest('[data-new]')) { newLinkDlg(it.key); return; }
    if (e.target.closest('[data-all]')) { closeModal(); manageLinksFor(it.key); return; }
    if (e.target.closest('[data-c]')) { const ok = await copyText($('#shLink').value); toast(ok ? 'Copied' : 'Press and hold the link to copy it', ok ? 'ok' : 'info'); return; }
    if (e.target.closest('[data-rm]')) { try { await api('/api/link-remove', { key: it.key }); $('#shRow').hidden = true; $('#shRemove').hidden = true; note('Link removed. It no longer works.'); } catch (err) { toast(err.message, 'err'); } return; }
    const b = e.target.closest('[data-s]');
    if (!b) return;
    try {
      if (b.dataset.s === 'public') return show(publicUrl(it.key), 'Anyone can open it. It never expires.', true);
      const r = await api(host ? '/api/link' : '/api/share', { key: it.key, seconds: +b.dataset.s });
      if (host && $('#shRemove')) $('#shRemove').hidden = false;
      show(r.url, when(r.exp), true);
    } catch (err) { toast(err.message, 'err'); }
  };
}
/* --- Links page: every short link with its validity; change expiry, address or file, or delete it --- */
const nowS = () => Math.floor(Date.now() / 1000);
const lkState = (l) => (l.missing ? 'broken' : l.active ? 'active' : 'expired');
function inWords(sec) {
  const a = Math.abs(sec);
  if (a < 3600) return Math.max(1, Math.round(a / 60)) + ' min';
  if (a < 86400) return Math.round(a / 3600) + ' h';
  return Math.round(a / 86400) + (Math.round(a / 86400) === 1 ? ' day' : ' days');
}
const fwhen = (s) => new Date(s * 1000).toLocaleString(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' });
function lkValidity(l) {
  if (!l.exp) return 'Never expires';
  const d = l.exp - nowS();
  return d > 0 ? 'Expires in ' + inWords(d) : 'Expired ' + inWords(d) + ' ago';
}
async function loadLinks(silent) {
  const seq = ++L.seq;
  if (!silent || !L.list.length) { L.loading = true; L.error = ''; render(); }
  const all = [];
  try {
    let after = '', pages = 0;
    do {
      const r = await api('/api/links?after=' + encodeURIComponent(after));
      if (seq !== L.seq) return;
      L.off = !!r.off;
      all.push(...r.links);
      after = r.next;
      if (after) { L.list = all.slice(); L.loading = false; render(); } // show what we have while the rest loads
    } while (after && ++pages < 100);
    L.list = all; L.loading = false; L.error = '';
  } catch (e) {
    if (seq !== L.seq) return;
    L.loading = false;
    if (silent && L.list.length) toast(e.message, 'err'); else L.error = e.message;
  }
  L.activeCount = L.list.filter((l) => lkState(l) === 'active').length;
  render();
}
function linkRowHtml(l, i) {
  const st = lkState(l), nm = l.key ? l.key.split('/').pop() : l.name;
  const pill = { active: 'Active', expired: 'Expired', broken: 'File missing' }[st];
  const exact = l.exp ? fwhen(l.exp) : 'No end date';
  return '<div class="lk-row ' + st + '" data-l="' + i + '">' + tile(kindOf(nm), 18) +
    '<div class="lk-main"><div class="lk-top"><a class="lk-url" href="' + esc(l.url) + '" target="_blank" rel="noopener noreferrer" title="Open ' + esc(l.url) + '">' + esc(l.url.replace(/^https?:\/\//, '')) + '</a>' +
    '<button class="ib" data-la="copy" title="Copy link" aria-label="Copy link">' + ico('copy', 16) + '</button></div>' +
    '<small class="lk-file">' + (l.key ? '<a data-la="goto" title="Show in folder">' + esc(l.key) + '</a>' : 'No file') + (l.size ? ' · ' + fmt(l.size) : '') + '</small></div>' +
    '<div class="lk-val"><span class="pill ' + st + '">' + pill + '</span><small title="' + esc(exact) + '">' + esc(lkValidity(l)) + '</small><small class="lk-exact">' + esc(exact) + '</small></div>' +
    '<div class="lk-acts"><button class="btn" data-la="valid" title="Change validity">' + ico('clock', 16) + '<span>Validity</span></button>' +
    '<button class="ib" data-la="more" title="More" aria-label="More actions">' + ico('more', 18) + '</button></div></div>';
}
function renderLinks() {
  const box = $('#lkList');
  $('#lkRefresh').innerHTML = ico('retry', 17);
  if (L.loading) { box.innerHTML = '<div class="empty"><div class="spin" style="margin:0 auto 12px"></div><p>Loading links…</p></div>'; $('#lkCount').textContent = ''; $('#lkClean').hidden = true; return; }
  if (L.error) { box.innerHTML = '<div class="empty"><h3>Could not load the links</h3><p>' + esc(L.error) + '</p><button class="btn primary" data-la="reload">Try again</button></div>'; return; }
  if (L.off) { box.innerHTML = '<div class="empty">' + tile('file', 28) + '<h3>Short links are off</h3><p>Set PUBLIC_HOST in src/config.js to use short links.</p></div>'; return; }
  const q = S.q.trim().toLowerCase();
  const rank = { active: 0, expired: 1, broken: 2 };
  L.shown = L.list.filter((l) => (L.filter === 'all' || lkState(l) === L.filter) && (!q || l.name.toLowerCase().indexOf(q) >= 0 || l.key.toLowerCase().indexOf(q) >= 0))
    .sort((a, b) => rank[lkState(a)] - rank[lkState(b)] || (b.t || 0) - (a.t || 0));
  const dead = L.list.filter((l) => lkState(l) !== 'active').length;
  $('#lkClean').hidden = !dead;
  $('#lkClean').textContent = 'Clean up (' + dead + ')';
  $('#lkCount').textContent = (L.shown.length !== L.list.length ? L.shown.length + ' of ' : '') + L.list.length + (L.list.length === 1 ? ' link' : ' links');
  if (L.shown.length) box.innerHTML = L.shown.map(linkRowHtml).join('');
  else if (L.list.length) box.innerHTML = '<div class="empty"><h3>No matches</h3><p>No link matches this filter.</p></div>';
  else box.innerHTML = '<div class="empty">' + tile('file', 28) + '<h3>No links yet</h3><p>Open a file’s menu and choose “Share link…” to create one. It shows up here.</p></div>';
}
async function lkUpdate(l, body, msg) {
  try {
    const r = await api('/api/link-update', Object.assign({ name: l.name }, body));
    Object.assign(l, r, { missing: body.key ? false : l.missing });
    L.activeCount = L.list.filter((x) => lkState(x) === 'active').length;
    render();
    if (msg) toast(msg, 'ok');
    return true;
  } catch (e) { toast(e.message, 'err'); return false; }
}
function pad2(n) { return String(n).padStart(2, '0'); }
const toLocalInput = (d) => d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + 'T' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
function openValidity(l) {
  const cur = () => (l.exp ? (l.exp > nowS() ? 'Works until ' + fwhen(l.exp) + ' (' + lkValidity(l).toLowerCase() + ').' : 'Expired on ' + fwhen(l.exp) + '.') : 'Never expires.');
  const opts = [[3600, '1 hour'], [86400, '1 day'], [604800, '7 days'], [2592000, '30 days'], [7776000, '90 days'], [0, 'Never']];
  const def = new Date(Math.min(Math.max(Date.now(), (l.exp || 0) * 1000) + 86400000, Date.now() + 364 * 86400000));
  openModal('<div class="dlg" role="dialog" aria-modal="true"><h2>Validity</h2><p class="lk-dlgurl">' + esc(l.url.replace(/^https?:\/\//, '')) + '</p>' +
    '<div class="lk-cur" id="lkCur">' + esc(cur()) + '</div>' +
    '<span class="lbl2">Works for (from now)</span><div class="seg3">' + opts.map((o) => '<button class="btn" data-v="' + o[0] + '">' + o[1] + '</button>').join('') + '</div>' +
    '<span class="lbl2">Or until a date</span><div class="copyrow"><input id="lkDate" class="field" type="datetime-local" min="' + toLocalInput(new Date()) + '" max="' + toLocalInput(new Date(Date.now() + 364 * 86400000)) + '" value="' + toLocalInput(def) + '"><button class="btn primary" data-v="date">Set</button></div>' +
    '<small class="hint">The link address stays the same; only how long it works changes.</small>' +
    '<div class="dlg-acts">' + (lkState(l) === 'active' ? '<button class="btn danger" data-v="off">Turn off now</button>' : '') + '<button class="btn" data-x="no">Close</button></div></div>');
  modalEl.onclick = async (e) => {
    if (e.target.closest('[data-x]')) { closeModal(); return; }
    const b = e.target.closest('[data-v]'); if (!b) return;
    let exp, v = b.dataset.v;
    if (v === 'date') {
      const t = new Date($('#lkDate').value).getTime();
      if (!t || t <= Date.now()) { toast('Pick a date in the future.', 'err'); return; }
      exp = Math.floor(t / 1000);
    } else if (v === 'off') exp = nowS();
    else exp = +v ? nowS() + +v : 0;
    if (await lkUpdate(l, { exp }, v === 'off' ? 'Link turned off.' : 'Validity updated.')) closeModal();
  };
}
// Extra link for a file, separate from its other links (own address, own validity)
function newLinkDlg(key) {
  const fname = key.split('/').pop();
  const opts = [[3600, '1 hour'], [86400, '1 day'], [604800, '7 days'], [2592000, '30 days'], [7776000, '90 days'], [0, 'Never']];
  openModal('<form class="dlg" role="dialog" aria-modal="true"><h2>New link for “' + esc(fname) + '”</h2><p>A separate link with its own address and validity. The file’s other links are not changed.</p>' +
    '<span class="lbl2">Address</span><div class="lk-addr"><span>' + esc(BOOT.publicHost) + '/</span><input id="nlName" class="field" maxlength="180" placeholder="Leave empty to use the file name" autocomplete="off"></div>' +
    '<span class="lbl2">Works for</span><div class="seg3">' + opts.map((o) => '<button type="button" class="btn" data-v="' + o[0] + '">' + o[1] + '</button>').join('') + '</div>' +
    '<div class="copyrow" id="nlRow" hidden><input id="nlLink" class="field" readonly><button type="button" class="btn" data-c="1">Copy</button></div>' +
    '<small class="hint" id="nlNote">Pick how long it should work to create it. It is copied for you.</small>' +
    '<div class="dlg-acts"><button type="button" class="btn" data-x="no">Close</button></div></form>');
  $('#nlName').focus();
  $('form', modalEl).onsubmit = (e) => e.preventDefault();
  let busy = false;
  modalEl.onclick = async (e) => {
    if (e.target.closest('[data-x]')) { closeModal(); return; }
    if (e.target.closest('[data-c]')) { const ok = await copyText($('#nlLink').value); toast(ok ? 'Copied' : 'Press and hold the link to copy it', ok ? 'ok' : 'info'); return; }
    const b = e.target.closest('[data-v]'); if (!b || busy) return;
    busy = true;
    try {
      const s = +b.dataset.v;
      const r = await api('/api/link-add', { key, name: $('#nlName').value.trim(), exp: s ? nowS() + s : 0 });
      if (L.list.length) { L.list.push(r); L.activeCount++; render(); }
      if (!$('#nlRow')) return;
      $('#nlRow').hidden = false; $('#nlLink').value = r.url; $('#nlName').value = '';
      const ok = await copyText(r.url);
      $('#nlNote').textContent = (ok ? 'Copied. ' : '') + (r.exp ? 'Works until ' + fwhen(r.exp) + '.' : 'Never expires.') + ' Pick again to make one more.';
    } catch (err) { toast(err.message, 'err'); }
    busy = false;
  };
}
function manageLinksFor(key) { L.nextQ = key; if (S.kind === 'links') applyRoute(); else location.hash = 'view=links'; }
async function renameLink(l) {
  const v = await askName('Change link address', 'The old address stops working. This becomes a separate custom link, so “Share link” on the file will make a new link next time.', l.name, 'Save');
  if (!v || v === l.name) return;
  const old = l.name;
  if (await lkUpdate(l, { newName: v }, 'Link address changed.')) { const u = l.url; if (l.name !== old) copyText(u).then((ok) => ok && toast('New link copied', 'ok')); }
}
function pickFile(title, start) {
  return new Promise((resolve) => {
    let dir = start || '', val = null;
    const draw = async () => {
      let cr = '<a data-d="">' + esc(BOOT.title) + '</a>', acc = '';
      dir.split('/').filter(Boolean).forEach((p) => { acc += p + '/'; cr += '<span class="sep">' + ico('chev', 14) + '</span><a data-d="' + esc(acc) + '">' + esc(p) + '</a>'; });
      modalEl.innerHTML = '<div class="dlg pick" role="dialog" aria-modal="true"><h2>' + esc(title) + '</h2><div class="arc-crumbs">' + cr + '</div><div class="pk-list" id="pkList"><div class="spin" style="margin:28px auto"></div></div><div class="dlg-acts"><button class="btn" data-x="no">Cancel</button></div></div>';
      const mine = dir;
      try {
        const d = await api('/api/list?prefix=' + encodeURIComponent(dir));
        if (mine !== dir || !$('#pkList')) return;
        const rows = d.folders.map((f) => '<div class="pk-row" data-d="' + esc(f) + '">' + ico('folder', 18) + '<span>' + esc(f.slice(dir.length).replace(/\/$/, '')) + '</span></div>')
          .concat(d.files.filter((f) => !f.key.endsWith('/')).map((f) => { const n = f.key.slice(dir.length); return '<div class="pk-row" data-k="' + esc(f.key) + '">' + ico(GLYPH[kindOf(n)], 18) + '<span>' + esc(n) + '</span><small class="pk-sz">' + fmt(f.size) + '</small></div>'; }));
        $('#pkList').innerHTML = rows.length ? rows.join('') : '<div class="empty" style="padding:28px 12px"><p>This folder is empty.</p></div>';
      } catch (e) { if ($('#pkList')) $('#pkList').innerHTML = '<div class="empty"><p>' + esc(e.message) + '</p></div>'; }
    };
    openModal('', () => resolve(val));
    modalEl.onclick = (e) => {
      const d = e.target.closest('[data-d]'); if (d) { dir = d.dataset.d; draw(); return; }
      const k = e.target.closest('[data-k]'); if (k) { val = k.dataset.k; closeModal(); return; }
      if (e.target.closest('[data-x]')) closeModal();
    };
    draw();
  });
}
async function retargetLink(l) {
  const start = l.key && l.key.lastIndexOf('/') > 0 ? l.key.slice(0, l.key.lastIndexOf('/') + 1) : '';
  const k = await pickFile('Point the link to another file', start);
  if (!k || k === l.key) return;
  await lkUpdate(l, { key: k }, 'The link now opens “' + k.split('/').pop() + '”.');
}
async function deleteLinks(list, ask) {
  if (!list.length) return;
  if (ask) {
    const ok = list.length === 1
      ? await confirmDlg('Delete this link?', list[0].url.replace(/^https?:\/\//, '') + ' will stop working. The file itself is not touched.', 'Delete link')
      : await confirmDlg('Delete ' + list.length + ' links?', 'All expired links and links whose file is missing will be removed. Files are not touched.', 'Delete links');
    if (!ok) return;
  }
  const r = await runBatches('Deleting links', list, 1, async (ch) => { await api('/api/link-delete', { name: ch[0].name }); return {}; });
  if (!r) return;
  if (r.errors.length) toast('Some links could not be deleted: ' + r.errors[0], 'err', 9000); else toast(r.done === 1 ? 'Link deleted.' : r.done + ' links deleted.', 'ok');
  loadLinks(true);
}
function showLinkFile(l) { if (!l.key) return; const i = l.key.lastIndexOf('/'); go(i > 0 ? l.key.slice(0, i + 1) : ''); }
async function linkMenu(l, x, y) {
  const st = lkState(l);
  const rows = [['copy', 'copy', 'Copy link'], ['open', 'ext', 'Open link'], '-', ['valid', 'clock', 'Change validity…'], ['rename', 'edit', 'Change link address…'], ['target', 'move', 'Point to another file…']];
  if (st !== 'broken') rows.push(['newfor', 'plus', 'New link for this file…'], ['goto', 'folder', 'Show file in folder']);
  if (l.key) rows.push(['same', 'search', 'All links of this file']);
  if (st === 'active') rows.push('-', ['off', 'x', 'Turn off now']);
  rows.push('-', ['del', 'trash', 'Delete link', true]);
  const a = await showMenu(l.url.replace(/^https?:\/\//, ''), rows, x, y);
  if (a) linkAct(a, l);
}
function linkAct(a, l, el) {
  if (a === 'copy') copyText(l.url).then((ok) => toast(ok ? 'Link copied' : l.url, ok ? 'ok' : 'info', ok ? 2500 : 9000));
  else if (a === 'open') window.open(l.url, '_blank', 'noopener');
  else if (a === 'valid') openValidity(l);
  else if (a === 'rename') renameLink(l);
  else if (a === 'target') retargetLink(l);
  else if (a === 'goto') showLinkFile(l);
  else if (a === 'newfor') newLinkDlg(l.key);
  else if (a === 'same') { S.q = l.key; $('#q').value = l.key; render(); }
  else if (a === 'off') lkUpdate(l, { exp: nowS() }, 'Link turned off.');
  else if (a === 'del') deleteLinks([l], true);
  else if (a === 'more' && el) { const r = el.getBoundingClientRect(); linkMenu(l, r.left, r.bottom + 4); }
}
$('#lkList').addEventListener('click', (e) => {
  const b = e.target.closest('[data-la]');
  if (b && b.dataset.la === 'reload') { loadLinks(); return; }
  const row = e.target.closest('[data-l]'); if (!row) return;
  const l = L.shown[+row.dataset.l]; if (!l) return;
  if (b) { e.preventDefault(); linkAct(b.dataset.la, l, b); return; }
  if (!e.target.closest('a')) linkMenu(l, e.clientX, e.clientY);
});
$('#lkFilter').addEventListener('change', (e) => { L.filter = e.target.value; render(); });
$('#lkRefresh').onclick = () => loadLinks();
$('#lkClean').onclick = () => deleteLinks(L.list.filter((l) => lkState(l) !== 'active'), true);

function fileRows(it) {
  if (it.trash) return [['restore', 'retry', 'Restore'], ['note', 'note', S.notes[it.key] ? 'Edit note…' : 'Add note…'], ['select', 'check', 'Select'], '-', ['purge', 'trash', 'Delete forever', true]];
  const rows = [];
  if (isViewable(it.name)) rows.push(['preview', 'eye', 'Preview']);
  if (isZip(it.name)) rows.push(['open', 'archive', 'Browse archive contents']);
  rows.push(['download', 'download', 'Download'], '-', ['share', 'link', 'Share link…']);
  if (isPublicKey(it.key)) rows.push(['public', 'globe', 'Copy public link']);
  if (isEditable(it.name, it.size)) rows.push(['edit', 'edit', 'Edit text']);
  rows.push(['note', 'note', S.notes[it.key] ? 'Edit note…' : 'Add note…'], ['select', 'check', 'Select'], '-', ['move', 'move', 'Move to…'], ['copy', 'copy', 'Copy to…'], ['delete', 'trash', 'Move to trash', true]);
  return rows;
}
function runFileAction(a, it) {
  if (a === 'preview') preview(it);
  else if (a === 'open') openArchive(it);
  else if (a === 'download') download(it);
  else if (a === 'share') openShare(it);
  else if (a === 'public') copyPublic(it);
  else if (a === 'edit') { preview(it); if (V) V.autoEdit = true; }
  else if (a === 'move') moveFiles([it], 'move');
  else if (a === 'copy') moveFiles([it], 'copy');
  else if (a === 'delete') del(it);
  else if (a === 'restore') restoreItems([it]);
  else if (a === 'purge') purgeItems([it]);
  else if (a === 'note') openNote(it);
  else if (a === 'select') { setSelMode(true); toggleSel(it.key, true); render(); }
}
async function openMore(it, x, y) { const a = await showMenu(it.name, fileRows(it), x, y); if (a) runFileAction(a, it); }

/* --- viewer: gallery, players, PDF, text / code / Markdown, and the text editor --- */
const MAXTXT = 2 * 1048576;
function mdToHtml(src) {
  const inline = (t) => esc(t)
    .replace(/\x60([^\x60]+)\x60/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<i>$2</i>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  const out = [], lines = src.replace(/\r\n?/g, '\n').split('\n');
  let i = 0, para = [], list = '';
  const endPara = () => { if (para.length) { out.push('<p>' + inline(para.join(' ')) + '</p>'); para = []; } };
  const endList = () => { if (list) { out.push('</' + list + '>'); list = ''; } };
  while (i < lines.length) {
    const l = lines[i];
    let m;
    if (/^\x60\x60\x60/.test(l)) {
      endPara(); endList();
      const code = [];
      i++;
      while (i < lines.length && !/^\x60\x60\x60/.test(lines[i])) code.push(lines[i++]);
      out.push('<pre class="code"><code>' + esc(code.join('\n')) + '</code></pre>');
    } else if ((m = l.match(/^(#{1,6})\s+(.*)$/))) { endPara(); endList(); out.push('<h' + m[1].length + '>' + inline(m[2]) + '</h' + m[1].length + '>'); }
    else if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(l)) { endPara(); endList(); out.push('<hr>'); }
    else if ((m = l.match(/^>\s?(.*)$/))) { endPara(); endList(); out.push('<blockquote>' + inline(m[1]) + '</blockquote>'); }
    else if ((m = l.match(/^\s*[-*+]\s+(.*)$/))) { endPara(); if (list !== 'ul') { endList(); out.push('<ul>'); list = 'ul'; } out.push('<li>' + inline(m[1]) + '</li>'); }
    else if ((m = l.match(/^\s*\d+[.)]\s+(.*)$/))) { endPara(); if (list !== 'ol') { endList(); out.push('<ol>'); list = 'ol'; } out.push('<li>' + inline(m[1]) + '</li>'); }
    else if (!l.trim()) { endPara(); endList(); }
    else { endList(); para.push(l.trim()); }
    i++;
  }
  endPara(); endList();
  return out.join('');
}
function codeHtml(text) {
  const lines = text.split('\n'), cap = 8000;
  return '<pre class="code"><code>' + lines.slice(0, cap).map((l, n) => '<span class="ln">' + (n + 1) + '</span>' + esc(l)).join('\n') + '</code></pre>' + (lines.length > cap ? '<p class="vw-note">Showing the first ' + cap + ' lines.</p>' : '');
}
function guardClose() {
  if (V && V.edit) { const t = $('#vwText'); if (t && t.value !== V.text && !window.confirm('Discard your unsaved changes?')) return false; }
  return true;
}
function preview(it) {
  const list = S.shown.filter((f) => !f.trash && isViewable(f.name));
  const idx = list.findIndex((f) => f.key === it.key);
  V = { list: idx >= 0 ? list : [it], i: Math.max(0, idx), edit: false, text: '', seq: 0, autoEdit: false };
  openModal('', () => { V = null; });
  modalEl.onclick = viewerClick;
  showViewer();
}
function navV(d) { if (!V || V.list.length < 2 || V.edit) return; V.i = (V.i + d + V.list.length) % V.list.length; showViewer(); }
async function showViewer() {
  const cur = V.list[V.i], k = kindOf(cur.name), asText = isText(cur.name) && !PREV[k], my = ++V.seq, multi = V.list.length > 1;
  V.edit = false; V.text = '';
  modalEl.innerHTML = '<div class="pv vw arc" role="dialog" aria-modal="true"><div class="pv-h"><b title="' + esc(cur.key) + '">' + esc(cur.name) + '</b>' + (multi ? '<span class="vw-n">' + (V.i + 1) + ' / ' + V.list.length + '</span>' : '') + '<span id="vwActs" class="vw-acts"></span><button class="btn" data-v="dl">' + ico('download', 16) + '<span class="lbl"> Download</span></button><button class="ib" data-v="close" aria-label="Close">' + ico('x', 18) + '</button></div><div class="pv-b" id="vwBody"><div class="spin"></div></div>' + (multi ? '<button class="vw-nav prev" data-v="prev" aria-label="Previous">' + ico('chevL', 22) + '</button><button class="vw-nav next" data-v="next" aria-label="Next">' + ico('chev', 22) + '</button>' : '') + '</div>';
  const body = $('#vwBody');
  let sx = 0, sy = 0;
  body.addEventListener('touchstart', (e) => { sx = e.touches[0].clientX; sy = e.touches[0].clientY; }, { passive: true });
  body.addEventListener('touchend', (e) => { const dx = e.changedTouches[0].clientX - sx, dy = e.changedTouches[0].clientY - sy; if (Math.abs(dx) > 70 && Math.abs(dy) < 60) navV(dx < 0 ? 1 : -1); }, { passive: true });
  try {
    const r = await api('/api/url', { key: cur.key, mode: 'inline' });
    if (!V || my !== V.seq) return;
    const u = esc(r.url);
    if (asText) {
      const res = await fetch('/api/read?key=' + encodeURIComponent(cur.key), { headers: { Range: 'bytes=0-' + (MAXTXT - 1) } });
      if (!res.ok) throw new Error('Could not read the file (HTTP ' + res.status + ').');
      const t = await res.text();
      if (!V || my !== V.seq) return;
      V.text = t;
      body.className = 'pv-b txt';
      body.innerHTML = /\.(md|markdown)$/i.test(cur.name) ? '<div class="md">' + mdToHtml(t) + (cur.size > MAXTXT ? '<p class="vw-note">Showing the first 2 MB.</p>' : '') + '</div>' : codeHtml(t) + (cur.size > MAXTXT ? '<p class="vw-note">Showing the first 2 MB.</p>' : '');
      if (isEditable(cur.name, cur.size)) {
        $('#vwActs').innerHTML = '<button class="btn" data-v="edit">' + ico('edit', 16) + '<span class="lbl"> Edit</span></button>';
        if (V.autoEdit) { V.autoEdit = false; startEdit(); }
      }
    } else {
      body.innerHTML = k === 'image' ? '<img src="' + u + '" alt="' + esc(cur.name) + '">'
        : k === 'video' ? '<video src="' + u + '" controls playsinline autoplay></video>'
        : k === 'audio' ? '<audio src="' + u + '" controls autoplay></audio>'
        : '<iframe src="' + u + '" title="' + esc(cur.name) + '"></iframe>';
      if (k === 'pdf') $('#vwActs').innerHTML = '<a class="btn" href="' + u + '" target="_blank" rel="noopener">Open</a>';
    }
  } catch (e) { if (V && my === V.seq && $('#vwBody')) $('#vwBody').innerHTML = '<div class="empty"><p>' + esc(e.message) + '</p></div>'; }
}
function startEdit() {
  V.edit = true;
  const body = $('#vwBody');
  body.className = 'pv-b';
  body.innerHTML = '<textarea id="vwText" class="editor" spellcheck="false"></textarea>';
  $('#vwText').value = V.text; $('#vwText').focus();
  $('#vwActs').innerHTML = '<button class="btn primary" data-v="save">' + ico('save', 16) + '<span class="lbl"> Save</span></button><button class="btn" data-v="cancel">Cancel</button>';
}
async function saveEdit() {
  const cur = V.list[V.i], t = $('#vwText').value, btn = $('[data-v=save]');
  btn.disabled = true;
  try {
    await api('/api/save', { key: cur.key, text: t });
    cur.size = new TextEncoder().encode(t).length;
    toast('Saved “' + cur.name + '”', 'ok');
    load(true);
    showViewer();
  } catch (e) { toast(e.message, 'err'); btn.disabled = false; }
}
function viewerClick(e) {
  const b = e.target.closest('[data-v]');
  if (!b || !V) return;
  const a = b.dataset.v, cur = V.list[V.i];
  if (a === 'close') { if (guardClose()) closeModal(); }
  else if (a === 'prev') navV(-1);
  else if (a === 'next') navV(1);
  else if (a === 'dl') download(cur);
  else if (a === 'edit') startEdit();
  else if (a === 'save') saveEdit();
  else if (a === 'cancel') { if (guardClose()) showViewer(); }
}
document.addEventListener('keydown', (e) => {
  if (!V || modalEl.hidden) return;
  const t = e.target;
  if (t && (t.tagName === 'TEXTAREA' || t.tagName === 'INPUT')) return;
  if (e.key === 'ArrowLeft') navV(-1); else if (e.key === 'ArrowRight') navV(1);
});

/* --- upload from a link (the Worker downloads it and streams it into R2) --- */
function askUrl() {
  return new Promise((resolve) => {
    let val = null;
    openModal('<form class="dlg" role="dialog" aria-modal="true"><h2>Save a link to R2</h2><p>The server downloads the file and saves it in ' + esc(S.prefix && !S.kind ? '/' + S.prefix : 'the top level') + '.</p><input id="uu" class="field" type="url" placeholder="https://example.com/file.zip" autocomplete="off"><input id="un" class="field" placeholder="File name (optional)" maxlength="120" autocomplete="off"><div class="dlg-acts"><button type="button" class="btn" data-x="no">Cancel</button><button type="submit" class="btn primary">Save to R2</button></div></form>', () => resolve(val));
    $('#uu').focus();
    $('form', modalEl).onsubmit = (e) => { e.preventDefault(); const u = $('#uu').value.trim(); if (!/^https?:\/\//i.test(u)) { $('#uu').focus(); return; } val = { url: u, name: $('#un').value.trim() }; closeModal(); };
    modalEl.onclick = (e) => { if (e.target.closest('[data-x=no]')) closeModal(); };
  });
}
async function uploadFromUrl() {
  const v = await askUrl();
  if (!v) return;
  const j = startJob('Saving link to R2');
  if (!j) return;
  const ac = new AbortController();
  j.onCancel = () => ac.abort();
  try {
    const res = await fetch('/api/fetch-url', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: v.url, name: v.name, prefix: S.kind ? '' : S.prefix }), signal: ac.signal });
    if (!res.ok || !res.body) { const d = await res.json().catch(() => ({})); throw new Error(d.error || 'Request failed (' + res.status + ')'); }
    const reader = res.body.getReader(), dec = new TextDecoder();
    let buf = '', key = '', ok = false;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        const ev = JSON.parse(line);
        if (ev.error) throw new Error(ev.error);
        if (ev.stage === 'start') { key = ev.key; $('#jobTitle').textContent = 'Saving ' + ev.key.split('/').pop(); }
        if (ev.progress != null) updateJob(fmt(ev.progress) + (ev.size ? ' of ' + fmt(ev.size) : ''), ev.size ? Math.min(99, (ev.progress / ev.size) * 100) : null);
        if (ev.done) { ok = true; key = ev.key; }
      }
    }
    if (!ok) throw new Error('The connection closed before the file was saved.');
    toast('Saved “' + key + '”', 'ok');
  } catch (e) { if (!j.canceled) toast(e.message, 'err', 8000); else toast('Canceled.', 'info'); }
  endJob(); load(true); loadUsage();
}

/* --- upload a folder, paste screenshots --- */
$('#folderInput').addEventListener('change', (e) => {
  const files = Array.from(e.target.files);
  enqueue(files.map((f) => { const rp = f.webkitRelativePath || '', i = rp.lastIndexOf('/'); return { file: f, rel: i > 0 ? rp.slice(0, i) : '' }; }));
  e.target.value = '';
});
document.addEventListener('paste', (e) => {
  const t = e.target;
  if (!modalEl.hidden || (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable))) return;
  const files = Array.from((e.clipboardData && e.clipboardData.files) || []);
  if (!files.length) return;
  e.preventDefault();
  const stamp = new Date().toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-');
  enqueue(files.map((f, n) => {
    const generic = /^image\//.test(f.type) && /^image\.\w+$/i.test(f.name);
    const ext = (f.type.split('/')[1] || 'png').replace('jpeg', 'jpg');
    return { file: generic ? new File([f], 'screenshot-' + stamp + (files.length > 1 ? '-' + (n + 1) : '') + '.' + ext, { type: f.type }) : f, rel: '' };
  }));
  toast('Uploading ' + files.length + (files.length === 1 ? ' pasted file' : ' pasted files') + '…', 'info');
});

/* --- resume interrupted uploads (the multipart upload id is remembered in this browser) --- */
function renderResumeNote() {
  const m = resumeLoad(), now = Date.now();
  let dirty = false;
  Object.keys(m).forEach((k) => { if (now - m[k].t > 7 * 86400e3) { delete m[k]; dirty = true; } });
  if (dirty) resumeSave(m);
  const active = new Set(queue.filter((q) => q.state === 'queued' || q.state === 'uploading' || q.state === 'error').map(fpOf));
  const left = Object.keys(m).filter((k) => !active.has(k));
  $('#resumeNote').hidden = !left.length;
  if (left.length) $('#resumeText').innerHTML = '<b>' + left.length + (left.length === 1 ? ' unfinished upload' : ' unfinished uploads') + '</b>: ' + left.slice(0, 3).map((k) => esc(m[k].name)).join(', ') + (left.length > 3 ? '…' : '') + '. Choose the same file again and it continues where it stopped.';
}
$('#resumeDiscard').onclick = async () => {
  const m = resumeLoad();
  const active = new Set(queue.filter((q) => q.state === 'queued' || q.state === 'uploading' || q.state === 'error').map(fpOf));
  for (const k of Object.keys(m)) { if (active.has(k)) continue; try { await api('/api/upload/abort', { key: m[k].key, uploadId: m[k].uploadId }); } catch (e) { /* already gone */ } delete m[k]; }
  resumeSave(m); renderResumeNote();
};
window.addEventListener('online', () => {
  let any = false;
  queue.forEach((q) => { if (q.state === 'error') { q.state = 'queued'; q.error = ''; q.xhrs.clear(); any = true; } });
  if (any) { renderUploads(); pump(); toast('Back online. Resuming uploads…', 'info'); }
});

/* --- selection bar buttons --- */
const selItems = () => S.files.filter((f) => S.sel.has(f.key));
$('#selDl').onclick = () => zipSelected(true);
$('#selZip').onclick = () => zipSelected(false);
$('#selMove').onclick = () => moveFiles(selItems(), 'move');
$('#selCopy').onclick = () => moveFiles(selItems(), 'copy');
$('#selDel').onclick = async () => { const l = selItems(); if (!l.length) return; if (await confirmDlg('Move ' + l.length + (l.length === 1 ? ' file' : ' files') + ' to trash?', 'You can restore them for ' + BOOT.trashDays + ' days.', 'Move to trash')) trashFiles(l); };
$('#selRestore').onclick = () => restoreItems(selItems());
$('#selPurge').onclick = () => purgeItems(selItems());

/* --- installable app --- */
if ('serviceWorker' in navigator) {
  const regSw = () => { navigator.serviceWorker.register('/sw.js').catch(() => {}); };
  if (document.readyState === 'complete') regSw(); else window.addEventListener('load', regSw);
}
renderResumeNote();

/* ---------- New menu, right-click / long-press menus, new text + zip files, largest files ---------- */
$('#newIco').innerHTML = ico('plus', 20);
$('#uIco').innerHTML = ico('database', 22);
$('#uGo').innerHTML = ico('chev', 18);
$('#usageCard').onclick = () => openLargest();

let ctxEl = null, lastNative = 0, lastHold = 0, suppressClick = 0;
function closeCtx() { if (ctxEl) { ctxEl.remove(); ctxEl = null; } }
function popMenu(rows, x, y) {
  return new Promise((resolve) => {
    closeCtx();
    const el = document.createElement('div');
    el.className = 'ctx'; el.setAttribute('role', 'menu');
    el.innerHTML = rows.map((r) => (r === '-' ? '<hr>' : '<button role="menuitem" data-pick="' + r[0] + '"' + (r[3] ? ' class="danger"' : '') + '>' + ico(r[1], 18) + '<span>' + esc(r[2]) + '</span></button>')).join('');
    document.body.appendChild(el); ctxEl = el;
    el.style.left = Math.max(8, Math.min(x, innerWidth - el.offsetWidth - 8)) + 'px';
    el.style.top = Math.max(8, Math.min(y, innerHeight - el.offsetHeight - 8)) + 'px';
    const done = (v) => { document.removeEventListener('mousedown', away, true); document.removeEventListener('keydown', key, true); window.removeEventListener('scroll', away, true); window.removeEventListener('resize', away); if (ctxEl === el) closeCtx(); ctxClosedAt = Date.now(); resolve(v); };
    const born = Date.now();
    const away = (e) => { if (e.type === 'scroll' && Date.now() - born < 400) return; if (!el.contains(e.target)) done(null); };
    const key = (e) => { if (e.key === 'Escape') done(null); };
    el.addEventListener('click', (e) => { const b = e.target.closest('[data-pick]'); if (b) done(b.dataset.pick); });
    document.addEventListener('mousedown', away, true); document.addEventListener('keydown', key, true); window.addEventListener('scroll', away, true); window.addEventListener('resize', away);
  });
}
const isPhone = () => matchMedia('(max-width:759px)').matches || matchMedia('(pointer:coarse)').matches;
// desktop: a small menu next to the pointer; phones: a bottom sheet
function showMenu(title, rows, x, y) { return isPhone() || x == null ? sheet(title, rows.filter((r) => r !== '-')) : popMenu(rows, x, y); }

const newRows = () => [['upload', 'upload', 'Upload files'], ['uploadDir', 'folder', 'Upload folder'], '-', ['folder', 'folderPlus', 'New folder'], ['text', 'edit', 'New text file'], ['zip', 'archive', 'New zip file'], '-', ['url', 'globe', 'Save from a link']];
function doNew(a) { if (a === 'upload') $('#file').click(); else if (a === 'uploadDir') $('#folderInput').click(); else if (a === 'folder') newFolder(); else if (a === 'text') newTextFile(); else if (a === 'zip') newZipFile(); else if (a === 'url') uploadFromUrl(); }
async function openNew(x, y) { const a = await showMenu('Create or upload', newRows(), x, y); if (a) doNew(a); }
$('#btnNew').onclick = (e) => { const r = e.currentTarget.getBoundingClientRect(); openNew(r.left, r.bottom + 6); };
$('#fab').onclick = () => openNew();

async function newFolder() {
  const name = await askFolder();
  if (!name) return;
  try { await api('/api/mkdir', { prefix: S.kind ? '' : S.prefix, name: name }); toast('Folder created', 'ok'); load(true); }
  catch (e) { toast(e.message, 'err'); }
}

/* --- right-click (desktop) and press-and-hold (phones) --- */
async function ctxItem(it, x, y) {
  if (S.sel.size > 1 && S.sel.has(it.key) && !it.trash) {
    const a = await showMenu(S.sel.size + ' files selected', [['dl', 'download', 'Download as zip'], '-', ['move', 'move', 'Move to…'], ['copy', 'copy', 'Copy to…'], ['del', 'trash', 'Move to trash', true], '-', ['clear', 'x', 'Clear selection']], x, y);
    if (a === 'dl') zipSelected(true); else if (a === 'move') moveFiles(selItems(), 'move'); else if (a === 'copy') moveFiles(selItems(), 'copy'); else if (a === 'del') $('#selDel').click(); else if (a === 'clear') $('#selClear').click();
    return;
  }
  const a = await showMenu(it.name, fileRows(it), x, y);
  if (a) runFileAction(a, it);
}
async function ctxFolder(f, x, y) {
  const a = await showMenu(f.name, [['open', 'folder', 'Open'], '-', ['del', 'trash', 'Move to trash', true]], x, y);
  if (a === 'open') go(f.key); else if (a === 'del') del(f);
}
async function ctxEmpty(x, y) {
  if (S.kind === 'trash') { const a = await showMenu('Trash', [['empty', 'trash', 'Empty trash', true]], x, y); if (a) emptyTrash(); return; }
  const a = await showMenu('Create or upload', newRows().concat(S.files.length ? ['-', ['selmode', 'check', 'Select files']] : []), x, y);
  if (a === 'selmode') setSelMode(true); else if (a) doNew(a);
}
const NOCTX = 'input,textarea,select,button,a,label,.nav,.navcard,.usage,.selbar,.note,.thead,.searchbar,.sec-h,.crumbs,.ctx,.sheet,.uploads,.job,.fab,#modal';
function ctxAt(t, x, y) {
  if (!t || !t.closest) return false;
  if (S.kind === 'links') { const lr = t.closest('#lkList [data-l]'); if (lr && !t.closest('a,button')) { const l = L.shown[+lr.dataset.l]; if (l) { linkMenu(l, x, y); return true; } } return false; }
  const row = t.closest('#list [data-i]'), fc = t.closest('#folders [data-f]');
  if (row) { const it = S.shown[+row.dataset.i]; if (it) { ctxItem(it, x, y); return true; } return false; }
  if (fc) { const f = S.shownFolders[+fc.dataset.f]; if (f) { ctxFolder(f, x, y); return true; } return false; }
  if (t.closest(NOCTX)) return false;
  ctxEmpty(x, y);
  return true;
}
document.addEventListener('contextmenu', (e) => {
  if (!modalEl.hidden || (e.target.closest && e.target.closest('input,textarea,.ctx'))) return;
  if (Date.now() - lastHold < 900) { e.preventDefault(); return; } // the press-and-hold already opened a menu
  if (ctxAt(e.target, e.clientX, e.clientY)) { e.preventDefault(); lastNative = Date.now(); }
});
let lp = null, lpPos = null;
document.addEventListener('touchstart', (e) => {
  if (e.touches.length !== 1 || !modalEl.hidden) return;
  const t = e.touches[0], tg = e.target;
  if (!tg.closest || tg.closest('input,textarea,select,.ctx,.sheet,.selbar,.thead,.nav,.navcard,.usage,.fab,.searchbar,.uploads,.job')) return;
  lpPos = [t.clientX, t.clientY];
  lp = setTimeout(() => { lp = null; if (Date.now() - lastNative < 900) return; if (ctxAt(tg, lpPos[0], lpPos[1])) { lastHold = Date.now(); suppressClick = Date.now() + 700; if (navigator.vibrate) navigator.vibrate(12); } }, 520);
}, { passive: true });
document.addEventListener('touchmove', (e) => { if (lp && lpPos) { const t = e.touches[0]; if (Math.hypot(t.clientX - lpPos[0], t.clientY - lpPos[1]) > 10) { clearTimeout(lp); lp = null; } } }, { passive: true });
['touchend', 'touchcancel'].forEach((n) => document.addEventListener(n, () => { clearTimeout(lp); lp = null; }, { passive: true }));
document.addEventListener('click', (e) => { if (Date.now() < suppressClick) { e.stopPropagation(); e.preventDefault(); } }, true);

/* --- new text file --- */
function newTextFile() {
  const prefix = S.kind ? '' : S.prefix;
  openModal('<form class="dlg wide" role="dialog" aria-modal="true"><h2>New text file</h2><p>It will be saved in ' + esc(prefix ? '/' + prefix : 'the top level') + '.</p><input id="ntName" class="field" value="untitled.txt" maxlength="120" autocomplete="off"><textarea id="ntText" class="field area" spellcheck="false" placeholder="Start typing…"></textarea><div class="dlg-acts"><button type="button" class="btn" data-x="no">Cancel</button><button type="submit" class="btn primary">Create</button></div></form>');
  const nm = $('#ntName'), dot = nm.value.indexOf('.');
  nm.focus(); nm.setSelectionRange(0, dot > 0 ? dot : nm.value.length);
  $('form', modalEl).onsubmit = async (e) => {
    e.preventDefault();
    const name = nm.value.trim(), btn = $('button[type=submit]', modalEl);
    if (!name) { nm.focus(); return; }
    btn.disabled = true;
    try { const r = await api('/api/new-text', { prefix, name, text: $('#ntText').value }); closeModal(); toast('Created “' + r.key.split('/').pop() + '”', 'ok'); load(true); loadUsage(); }
    catch (err) { toast(err.message, 'err'); btn.disabled = false; }
  };
  modalEl.onclick = (e) => { if (e.target.closest('[data-x=no]')) closeModal(); };
}

/* --- new zip file: pick files, they are zipped in the browser and uploaded as one zip --- */
function newZipFile() {
  if (!HAS_STREAMS) { toast('Your browser is too old for zipping (needs Chrome 103, Safari 16.4 or Firefox 113 or newer).', 'err'); return; }
  const prefix = S.kind ? '' : S.prefix, picked = [];
  openModal('<form class="dlg wide" role="dialog" aria-modal="true"><h2>New zip file</h2><p>Add files and they are zipped and saved in ' + esc(prefix ? '/' + prefix : 'the top level') + '.</p><input id="nzName" class="field" value="archive.zip" maxlength="120" autocomplete="off"><div class="zdrop" id="zDrop"><b>Drop files or folders here</b><span><button type="button" class="link" data-z="files">Choose files</button> or <button type="button" class="link" data-z="dir">choose a folder</button></span></div><div class="zlist" id="zList"></div><div class="dlg-acts"><button type="button" class="btn" data-x="no">Cancel</button><button type="submit" class="btn primary">Create zip</button></div></form>');
  const draw = () => {
    const el = $('#zList'); if (!el) return;
    el.innerHTML = picked.map((p, i) => '<div class="zr"><span class="zn" title="' + esc(p.path) + '">' + esc(p.path) + '</span><small>' + fmt(p.file.size) + '</small><button type="button" class="ib" data-zr="' + i + '" aria-label="Remove">' + ico('x', 16) + '</button></div>').join('') + (picked.length ? '<small class="hint">' + picked.length + (picked.length === 1 ? ' file, ' : ' files, ') + fmt(picked.reduce((n, p) => n + p.file.size, 0)) + '</small>' : '');
  };
  const add = (list) => { list.forEach((x) => picked.push({ file: x.file, path: (x.rel || '') + x.file.name })); draw(); };
  const mk = (dir) => {
    const i = document.createElement('input'); i.type = 'file'; i.multiple = true; if (dir) i.webkitdirectory = true;
    i.onchange = () => add(Array.from(i.files).map((f) => ({ file: f, rel: dir && f.webkitRelativePath ? f.webkitRelativePath.slice(0, f.webkitRelativePath.lastIndexOf('/') + 1) : '' })));
    return i;
  };
  const zd = $('#zDrop');
  ['dragenter', 'dragover'].forEach((n) => zd.addEventListener(n, (e) => { e.preventDefault(); e.stopPropagation(); zd.classList.add('on'); }));
  zd.addEventListener('dragleave', () => zd.classList.remove('on'));
  zd.addEventListener('drop', async (e) => {
    e.preventDefault(); e.stopPropagation(); zd.classList.remove('on');
    const dt = e.dataTransfer, ents = Array.from(dt.items || []).map((it) => (it.kind === 'file' && it.webkitGetAsEntry ? it.webkitGetAsEntry() : null)).filter(Boolean);
    if (ents.length) { const out = []; for (const en of ents) await walk(en, '', out); add(out); } else add(Array.from(dt.files).map((f) => ({ file: f, rel: '' })));
  });
  modalEl.onclick = (e) => {
    if (e.target.closest('[data-x=no]')) { closeModal(); return; }
    const z = e.target.closest('[data-z]'); if (z) { mk(z.dataset.z === 'dir').click(); return; }
    const r = e.target.closest('[data-zr]'); if (r) { picked.splice(+r.dataset.zr, 1); draw(); }
  };
  $('form', modalEl).onsubmit = async (e) => {
    e.preventDefault();
    const name = $('#nzName').value.trim() || 'archive.zip', zname = /\.zip$/i.test(name) ? name : name + '.zip';
    const items = picked.map((p) => ({ zipName: p.path, size: p.file.size, modified: p.file.lastModified, file: p.file }));
    closeModal();
    const j = startJob('Creating ' + zname);
    if (!j) return;
    try {
      const blob = await buildZip(items, { canceled: () => j.canceled, onProgress: (read, total, i, nm) => updateJob((i + 1) + ' of ' + items.length + ': ' + nm, Math.min(99, total ? (read / total) * 100 : 0)) });
      enqueue([{ file: new File([blob], zname, { type: 'application/zip' }), rel: '' }], prefix);
      toast('Zip ready. Uploading ' + zname + '…', 'ok');
    } catch (err) { if (!j.canceled) toast(err.message, 'err'); }
    endJob();
  };
}

/* --- storage: the biggest files --- */
async function openLargest() {
  openModal('<div class="dlg wide" role="dialog" aria-modal="true"><h2>Largest files</h2><div id="lgBody"><div class="spin" style="margin:30px auto"></div></div><div class="dlg-acts"><button class="btn" data-x="no">Close</button></div></div>');
  modalEl.onclick = (e) => {
    const r = e.target.closest('[data-lg]');
    if (r) { const k = r.dataset.lg; closeModal(); location.hash = k.indexOf('.trash/') === 0 ? 'view=trash' : (k.lastIndexOf('/') > 0 ? encodeURIComponent(k.slice(0, k.lastIndexOf('/') + 1)) : ''); return; }
    if (e.target.closest('[data-x]')) closeModal();
  };
  try {
    const d = await api('/api/largest');
    if (!$('#lgBody')) return;
    const max = d.files.length ? d.files[0].size || 1 : 1;
    $('#lgBody').innerHTML = d.files.length ? '<div class="lg">' + d.files.map((f) => {
      const trash = f.key.indexOf('.trash/') === 0, orig = trash ? f.key.replace(/^\.trash\/[^/]+\//, '') : f.key, i = orig.lastIndexOf('/'), nm = orig.slice(i + 1);
      return '<div class="lg-row" data-lg="' + esc(f.key) + '">' + tile(kindOf(nm), 18) + '<div class="lg-n"><b title="' + esc(orig) + '">' + esc(nm) + '</b><small>' + esc((i > 0 ? orig.slice(0, i) : 'Top level') + (trash ? ' (in trash)' : '')) + '</small><div class="lg-bar" style="width:' + Math.max(2, (f.size / max) * 100) + '%"></div></div><span class="lg-s">' + fmt(f.size) + '</span></div>';
    }).join('') + '</div>' : '<div class="empty"><p>No files yet.</p></div>';
  } catch (e) { if ($('#lgBody')) $('#lgBody').innerHTML = '<div class="empty"><p>' + esc(e.message) + '</p></div>'; }
}

/* ---------- select mode and per-file notes ---------- */
$('#btnSelect').innerHTML = ico('check', 16) + '<span class="lbl">Select</span>';
let ctxClosedAt = 0;
function setSelMode(on) {
  S.selMode = on;
  document.body.classList.toggle('selmode', on);
  $('#btnSelect').classList.toggle('on', on);
  if (!on) { S.sel.clear(); document.querySelectorAll('#list [data-sel]').forEach((cb) => { cb.checked = false; }); }
  renderSel();
}
$('#btnSelect').onclick = () => setSelMode(!S.selMode);
$('#selDone').onclick = () => setSelMode(false);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && S.selMode && modalEl.hidden && Date.now() - ctxClosedAt > 150) setSelMode(false); });

function paintNote(cell, key) { const n = S.notes[key] || ''; cell.classList.toggle('blank', !n); cell.title = n || 'Add a note'; cell.textContent = n || 'Add note'; }
async function saveNote(key, text) {
  const r = await api('/api/note', { key, text });
  if (r.text) S.notes[key] = r.text; else delete S.notes[key];
}
function startNoteEdit(row, it) {
  const cell = row.querySelector('[data-note]');
  if (!cell || cell.querySelector('input')) return;
  const old = S.notes[it.key] || '';
  cell.classList.remove('blank');
  cell.innerHTML = '<input class="nt-in" maxlength="2000" placeholder="Write a note" value="' + esc(old) + '">';
  const inp = cell.firstChild;
  inp.focus(); inp.select();
  let finished = false;
  const finish = async (save) => {
    if (finished) return;
    finished = true;
    const v = inp.value.trim();
    if (save && v !== old) { try { await saveNote(it.key, v); } catch (e) { toast(e.message, 'err'); } }
    paintNote(cell, it.key);
  };
  inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); finish(true); } else if (e.key === 'Escape') { e.stopPropagation(); finish(false); } });
  inp.addEventListener('blur', () => finish(true));
  inp.addEventListener('click', (e) => e.stopPropagation());
}
function openNote(it) {
  const old = S.notes[it.key] || '';
  openModal('<form class="dlg wide" role="dialog" aria-modal="true"><h2>Note for “' + esc(it.name) + '”</h2><textarea id="noteText" class="field area" style="height:140px" maxlength="2000" placeholder="Write a note about this file…"></textarea><div class="dlg-acts">' + (old ? '<button type="button" class="btn" data-x="clear">Remove note</button>' : '') + '<button type="button" class="btn" data-x="no">Cancel</button><button type="submit" class="btn primary">Save</button></div></form>');
  const t = $('#noteText');
  t.value = old; t.focus();
  const save = async (v) => { try { await saveNote(it.key, v); closeModal(); render(); } catch (e) { toast(e.message, 'err'); } };
  $('form', modalEl).onsubmit = (e) => { e.preventDefault(); save(t.value.trim()); };
  modalEl.onclick = (e) => { const x = e.target.closest('[data-x]'); if (!x) return; if (x.dataset.x === 'clear') save(''); else closeModal(); };
}

/* ---------- upload password (#view=upload-password) ---------- */
/* The Worker owns the real password: it lives in .system/upload-auth.json in
   the bucket and is read and written through /api/settings/upload-password,
   which sits behind the normal Access login. Generate only fills the box;
   nothing is stored until Save. */
const PW_ALPHABET = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'; // 62 characters
const PW_OK = /^[a-zA-Z0-9]{7,24}$/; // generated ones are 7; typed ones may be up to 24
/* Same rule as generatePassword() in src/upauth.js: bytes at or above 248
   (the largest multiple of 62 that fits in a byte) are thrown away, so no
   character is more likely than any other. */
function newPassword() {
  let out = '';
  const buf = new Uint8Array(16);
  while (out.length < 7) {
    crypto.getRandomValues(buf);
    for (let i = 0; i < buf.length && out.length < 7; i++) {
      if (buf[i] >= 248) continue;
      out += PW_ALPHABET[buf[i] % 62];
    }
  }
  return out;
}

async function loadUpAuth(silent) {
  const seq = ++U.seq;
  if (!silent) { U.loading = true; U.error = ''; render(); }
  try {
    const d = await api('/api/settings/upload-password');
    if (seq !== U.seq) return;
    U.password = d.password || ''; U.auto = d.auto === 'on' ? 'on' : 'off'; U.rotatedAt = Number(d.rotatedAt) || 0;
    U.draft = null; U.loading = false; U.error = '';
  } catch (e) {
    if (seq !== U.seq) return;
    U.loading = false;
    if (silent) toast(e.message, 'err'); else U.error = e.message;
  }
  render();
}

function renderUpAuth() {
  const el = $('#upBody');
  if (U.loading) { el.innerHTML = '<div class="spin" style="margin:34px auto"></div>'; return; }
  if (U.error) {
    el.innerHTML = '<div class="empty"><h3>Could not load the upload password</h3><p>' + esc(U.error) + '</p><button class="btn primary" data-up="retry">Try again</button></div>';
    return;
  }
  const on = U.auto === 'on';
  const val = U.draft === null ? U.password : U.draft;
  el.innerHTML =
    '<p class="up-note">The terminal upload client asks for this password. The web app itself stays behind your Cloudflare Access login.</p>' +
    '<label class="up-lbl" for="upPass">Password</label>' +
    '<div class="copyrow">' +
      '<input id="upPass" class="field mono" maxlength="24" size="24" spellcheck="false" autocomplete="off" autocapitalize="off" autocorrect="off" value="' + esc(val) + '" aria-label="Upload password">' +
      '<button class="btn" data-up="gen">' + ico('retry', 16) + 'Generate</button>' +
      '<button class="btn" data-up="copy">' + ico('copy', 16) + 'Copy</button>' +
    '</div>' +
    '<small class="up-hint">7 to 24 characters: letters and numbers. Generate makes a 7-character one.</small>' +
    '<div class="up-row">' +
      '<div class="up-txt"><b>Auto-rotate every 6 days</b><small>' + (on ? 'A new password is generated for you.' : 'The password never changes on its own.') + '</small></div>' +
      '<button class="sw' + (on ? ' on' : '') + '" role="switch" aria-checked="' + (on ? 'true' : 'false') + '" data-up="auto" aria-label="Auto-rotate every 6 days"><i></i></button>' +
    '</div>' +
    (on ? '<small class="up-hint up-next">Next rotation: ' + esc(U.rotatedAt ? fwhen((U.rotatedAt + SIX_DAYS_MS) / 1000) : 'unknown') + '</small>' : '') +
    '<div class="up-acts"><button class="btn primary" data-up="save"' + (U.busy ? ' disabled' : '') + '>Save</button></div>';
}

async function saveUpAuth(patch, msg) {
  if (U.busy) return;
  U.busy = true; renderUpAuth();
  try {
    const d = await api('/api/settings/upload-password', patch);
    U.password = d.password || ''; U.auto = d.auto === 'on' ? 'on' : 'off'; U.rotatedAt = Number(d.rotatedAt) || 0;
    U.draft = null;
    toast(msg || 'Saved', 'ok');
  } catch (e) { toast(e.message, 'err'); }
  U.busy = false;
  renderUpAuth();
}

$('#upBody').addEventListener('input', (e) => { if (e.target.id === 'upPass') U.draft = e.target.value; });
$('#upBody').addEventListener('click', (e) => {
  const b = e.target.closest('[data-up]');
  if (!b) return;
  const a = b.dataset.up;
  if (a === 'retry') { loadUpAuth(); return; }
  if (a === 'gen') {
    U.draft = newPassword();
    renderUpAuth();
    const inp = $('#upPass'); if (inp) { inp.focus(); inp.select(); }
    toast('New password ready. Click Save to start using it.', 'info');
    return;
  }
  if (a === 'copy') {
    const v = (U.draft === null ? U.password : U.draft) || '';
    if (!v) return;
    copyText(v).then((ok) => toast(ok ? 'Password copied' : v, ok ? 'ok' : 'info', ok ? 3000 : 9000));
    return;
  }
  if (a === 'auto') { saveUpAuth({ auto: U.auto === 'on' ? 'off' : 'on' }, U.auto === 'on' ? 'Auto-rotate off' : 'Auto-rotate on'); return; }
  if (a === 'save') {
    const v = ((U.draft === null ? U.password : U.draft) || '').trim();
    if (!PW_OK.test(v)) { toast('The password must be 7 to 24 characters: letters and numbers only.', 'err'); return; }
    if (v === U.password) { toast('That is already the password.', 'info'); return; }
    saveUpAuth({ password: v }, 'Password saved');
    return;
  }
});

/* ---------- start ---------- */
applyView();
applyRoute();
loadUsage();
