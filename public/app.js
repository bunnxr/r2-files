import { HAS_STREAMS, isZip, readZip, entryBlob, buildZip, mimeOf } from '/zip.js';
// Settings (title, colours, upload tuning) come from the Worker's CONFIG via /api/config.
let BOOT = { title: 'Files', accent: '', parallel: 4, retries: 3, view: 'grid', publicHost: '', publicFolders: [], trashDays: 30 };
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
const S = { sel: new Set(), prefix: '', folders: [], files: [], shown: [], loading: true, error: '', q: '', by: 'name', dir: 1, view: ls.get('fm-view') || BOOT.view, seq: 0 };

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
$('#folderIco').innerHTML = ico('folderPlus', 18);
$('#uploadIco').innerHTML = ico('upload', 18);
$('#upToggle').innerHTML = ico('down', 18);
$('#upClear').innerHTML = ico('broom', 17);

/* ---------- browsing ---------- */
const KINDS = ['recent', 'image', 'video', 'audio', 'doc', 'archive', 'other', 'trash'];
const KIND_TITLE = { recent: 'Recent files', image: 'Images', video: 'Videos', audio: 'Audio', doc: 'Documents', archive: 'Archives', other: 'Other files', trash: 'Trash' };
const CAT = { image: ['Images', '#3b82f6', 'image'], video: ['Videos', '#ef4444', 'video'], audio: ['Audio', '#8b5cf6', 'audio'], doc: ['Documents', '#22a06b', 'doc'], archive: ['Archives', '#f59e0b', 'archive'], other: ['Other', '#64748b', 'file'], trash: ['Trash', '#94a3b8', 'trash'] };
const NAV = [['', 'All files', 'folder'], ['recent', 'Recent', 'clock'], ['image', 'Images', 'image'], ['video', 'Videos', 'video'], ['audio', 'Audio', 'audio'], ['doc', 'Documents', 'doc'], ['archive', 'Archives', 'archive'], ['other', 'Other', 'file'], ['trash', 'Trash', 'trash']];
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
  S.kind = r.kind; S.prefix = r.prefix; S.q = ''; $('#q').value = ''; S.sel.clear();
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
  const k = kindOf(it.name), pub = !it.trash && isPublicKey(it.key);
  let acts = '';
  if (it.trash) {
    acts += '<button class="ib" data-act="restore" title="Restore" aria-label="Restore ' + esc(it.name) + '">' + ico('retry', 17) + '</button>';
    acts += '<button class="ib danger" data-act="purge" title="Delete forever" aria-label="Delete ' + esc(it.name) + ' forever">' + ico('trash', 17) + '</button>';
  } else {
    if (isViewable(it.name)) acts += '<button class="ib" data-act="preview" title="Preview" aria-label="Preview ' + esc(it.name) + '">' + ico('eye', 17) + '</button>';
    acts += '<button class="ib" data-act="download" title="Download" aria-label="Download ' + esc(it.name) + '">' + ico('download', 17) + '</button>';
    acts += '<button class="ib" data-act="share" title="' + (pub ? 'Copy public link' : 'Share link') + '" aria-label="' + (pub ? 'Copy public link for ' : 'Share ') + esc(it.name) + '">' + ico(pub ? 'globe' : 'link', 17) + '</button>';
    acts += '<button class="ib" data-act="more" title="More" aria-label="More actions for ' + esc(it.name) + '">' + ico('more', 17) + '</button>';
  }
  const date = esc(fdate(it.modified));
  return '<div class="item' + (!it.trash && (isViewable(it.name) || isZip(it.name)) ? ' go' : '') + '" data-i="' + i + '"><div class="main"><input type="checkbox" class="sel" data-sel aria-label="Select ' + esc(it.name) + '"' + (S.sel.has(it.key) ? ' checked' : '') + '>' + tile(k, 20) + '<div class="nm"><b title="' + esc(it.trash ? it.orig : it.key) + '">' + esc(it.name) + '</b>' + (it.dir ? '<small class="path">' + esc(it.dir) + '</small>' : '') + '<small class="sub"><span>' + fmt(it.size) + '</span><span>' + date + '</span></small></div></div><span class="sz">' + fmt(it.size) + '</span><span class="dt">' + date + '</span><div class="acts">' + acts + '</div></div>';
}
function folderHtml(f, i) {
  return '<div class="fcard" data-f="' + i + '"><div class="f-top">' + tile('folder', 22) + '<button class="ib danger" data-act="delete" title="Move folder to trash" aria-label="Move folder ' + esc(f.name) + ' to trash">' + ico('trash', 17) + '</button></div><b title="' + esc(f.name) + '">' + esc(f.name) + '</b><small>Folder' + (isPublicKey(f.key) ? '<span class="badge">Public</span>' : '') + '</small></div>';
}
function theadHtml() {
  const a = (k) => (S.by === k ? (S.dir > 0 ? ' ↑' : ' ↓') : '');
  return '<div class="thead"><span class="th-n"><input type="checkbox" class="sel" data-selall aria-label="Select all"><span data-sort="name">Name' + a('name') + '</span></span><span data-sort="size">Size' + a('size') + '</span><span data-sort="date">Modified' + a('date') + '</span><span></span></div>';
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
  if (act) { const a = act.dataset.act; if (a === 'download') download(it); else if (a === 'preview') preview(it); else if (a === 'share') { if (isPublicKey(it.key)) copyPublic(it); else openShare(it); } else if (a === 'more') openMore(it); else if (a === 'restore') restoreItems([it]); else if (a === 'purge') purgeItems([it]); return; }
  if (it.trash) return;
  if (isViewable(it.name)) preview(it); else if (isZip(it.name)) openArchive(it);
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

/* ---------- selection, archives (browse / extract) and "zip selected" ---------- */
function renderSel() {
  const n = S.sel.size, tr = S.kind === 'trash';
  $('#selbar').hidden = !n;
  ['selDl', 'selZip', 'selMove', 'selCopy', 'selDel'].forEach((id) => { $('#' + id).hidden = tr; });
  ['selRestore', 'selPurge'].forEach((id) => { $('#' + id).hidden = !tr; });
  if (n) { let sz = 0; S.files.forEach((f) => { if (S.sel.has(f.key)) sz += f.size; }); $('#selCount').textContent = n + (n === 1 ? ' file selected' : ' files selected') + ' (' + fmt(sz) + ')'; }
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
    const items = chosen.map((f) => ({ zipName: S.kind ? f.key : f.name, size: f.size, modified: f.modified, getUrl: async () => (await api('/api/url', { key: f.key, mode: 'download' })).url }));
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
async function arcUrl(A) {
  if (Date.now() - A.t > 40 * 60000) { A.url = (await api('/api/url', { key: A.it.key, mode: 'download' })).url; A.t = Date.now(); }
  return A.url;
}
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
    const r = await api('/api/url', { key: it.key, mode: 'download' });
    const entries = await readZip(r.url, it.size);
    arc = { it, url: r.url, t: Date.now(), entries, dir: '', sel: new Set(), view: null };
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
$('#folderUpIco').innerHTML = ico('folder', 18);
$('#urlIco').innerHTML = ico('globe', 18);

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
  S.sel.clear(); load(true); loadUsage();
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
function openShare(it) {
  const pub = isPublicKey(it.key);
  openModal('<div class="dlg" role="dialog" aria-modal="true"><h2>Share “' + esc(it.name) + '”</h2>' +
    (pub ? '<span class="lbl2">Public link</span><button class="btn primary block" data-s="public">' + ico('globe', 17) + ' Copy public link</button><small class="hint">Anyone with this link can open the file. It never expires.</small>' : '') +
    '<span class="lbl2">Expiring link</span><div class="seg3"><button class="btn" data-s="3600">1 hour</button><button class="btn" data-s="86400">1 day</button><button class="btn" data-s="604800">7 days</button></div>' +
    '<input id="shLink" class="field" readonly hidden><small class="hint" id="shNote">Pick how long the link should work. It is copied for you.</small><div class="dlg-acts"><button class="btn" data-x="no">Close</button></div></div>');
  const show = async (url, note) => { const f = $('#shLink'); f.value = url; f.hidden = false; f.select(); const ok = await copyText(url); const n = $('#shNote'); if (n) n.textContent = (ok ? 'Copied. ' : 'Copy the link above. ') + note; };
  modalEl.onclick = async (e) => {
    if (e.target.closest('[data-x]')) { closeModal(); return; }
    const b = e.target.closest('[data-s]');
    if (!b) return;
    try {
      if (b.dataset.s === 'public') return show(publicUrl(it.key), 'Anyone can open it.');
      const r = await api('/api/share', { key: it.key, seconds: +b.dataset.s });
      show(r.url, 'It works until ' + new Date(r.expires * 1000).toLocaleString() + '.');
    } catch (err) { toast(err.message, 'err'); }
  };
}
async function openMore(it) {
  const rows = [];
  if (isViewable(it.name)) rows.push(['preview', 'eye', 'Preview']);
  if (isZip(it.name)) rows.push(['open', 'archive', 'Browse archive contents']);
  rows.push(['download', 'download', 'Download'], ['share', 'link', 'Share link…']);
  if (isPublicKey(it.key)) rows.push(['public', 'globe', 'Copy public link']);
  if (isEditable(it.name, it.size)) rows.push(['edit', 'edit', 'Edit text']);
  rows.push(['move', 'move', 'Move to…'], ['copy', 'copy', 'Copy to…'], ['delete', 'trash', 'Move to trash', true]);
  const a = await sheet(it.name, rows);
  if (a === 'preview') preview(it);
  else if (a === 'open') openArchive(it);
  else if (a === 'download') download(it);
  else if (a === 'share') openShare(it);
  else if (a === 'public') copyPublic(it);
  else if (a === 'edit') { preview(it); if (V) V.autoEdit = true; }
  else if (a === 'move') moveFiles([it], 'move');
  else if (a === 'copy') moveFiles([it], 'copy');
  else if (a === 'delete') del(it);
}

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
      const res = await fetch(r.url, { headers: { Range: 'bytes=0-' + (MAXTXT - 1) } });
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
$('#btnUrl').onclick = uploadFromUrl;

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

/* ---------- start ---------- */
applyView();
applyRoute();
loadUsage();
