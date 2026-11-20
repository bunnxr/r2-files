// ZIP support for the browser: read a zip straight from R2 with range requests,
// and build a zip as a stream. No libraries: uses DecompressionStream / CompressionStream.
// Needs Chrome 103+, Safari 16.4+ or Firefox 113+.
export const HAS_STREAMS = typeof DecompressionStream === 'function' && typeof CompressionStream === 'function';
export const isZip = (n) => /\.zip$/i.test(n);
// Already-compressed formats are stored as-is when zipping (compressing them again only wastes time)
export const NOCOMP = /\.(zip|rar|7z|gz|tgz|bz2|xz|jpe?g|png|gif|webp|avif|heic|mp3|m4a|aac|ogg|opus|mp4|m4v|mov|mkv|webm|docx|xlsx|pptx|pdf)$/i;
const MIME = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', avif: 'image/avif', bmp: 'image/bmp', mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4', ogg: 'audio/ogg', flac: 'audio/flac', pdf: 'application/pdf', txt: 'text/plain', json: 'application/json', csv: 'text/csv', zip: 'application/zip' };
export const mimeOf = (n) => MIME[n.split('.').pop().toLowerCase()] || '';
// Drop "..", ".", empty parts and backslashes so an archive can never write outside the target folder
export const cleanPath = (p) => p.replace(/\\/g, '/').split('/').filter((s) => s && s !== '.' && s !== '..').join('/') + (/[\\/]$/.test(p) ? '/' : '');
const JUNK = /(^|\/)(__MACOSX\/|\.DS_Store$|Thumbs\.db$)/;
const U8 = new TextDecoder('utf-8', { fatal: true });
const L1 = new TextDecoder('windows-1252');

async function range(url, a, b) {
  let r;
  try { r = await fetch(url, { headers: { Range: 'bytes=' + a + '-' + b } }); }
  catch (e) { throw new Error('Could not read the file. Check your connection and try again.'); }
  if (r.status !== 206 && r.status !== 200) throw new Error('R2 answered with HTTP ' + r.status + ' while reading the archive.');
  return r;
}

export async function readZip(url, size) {
  if (!size) throw new Error('This file is empty, so it is not a ZIP archive.');
  const n = Math.min(size, 66000);
  const tail = new DataView(await (await range(url, size - n, size - 1)).arrayBuffer());
  let i = tail.byteLength - 22;
  for (; i >= 0; i--) if (tail.getUint32(i, true) === 0x06054b50) break;
  if (i < 0) throw new Error('This does not look like a ZIP file.');
  let total = tail.getUint16(i + 10, true), cdSize = tail.getUint32(i + 12, true), cdOff = tail.getUint32(i + 16, true);
  if (total === 0xffff || cdSize === 0xffffffff || cdOff === 0xffffffff) { // ZIP64
    const l = i - 20;
    if (l < 0 || tail.getUint32(l, true) !== 0x07064b50) throw new Error('Unsupported ZIP64 layout.');
    const o = Number(tail.getBigUint64(l + 8, true));
    const b = new DataView(await (await range(url, o, o + 55)).arrayBuffer());
    if (b.getUint32(0, true) !== 0x06064b50) throw new Error('Corrupt ZIP64 directory.');
    total = Number(b.getBigUint64(32, true)); cdSize = Number(b.getBigUint64(40, true)); cdOff = Number(b.getBigUint64(48, true));
  }
  const cd = new DataView(await (await range(url, cdOff, cdOff + cdSize - 1)).arrayBuffer());
  const entries = [];
  let p = 0;
  while (p + 46 <= cd.byteLength && cd.getUint32(p, true) === 0x02014b50) {
    const flags = cd.getUint16(p + 8, true), method = cd.getUint16(p + 10, true);
    const dt = cd.getUint16(p + 12, true), dd = cd.getUint16(p + 14, true);
    let csize = cd.getUint32(p + 20, true), usize = cd.getUint32(p + 24, true), off = cd.getUint32(p + 42, true);
    const nl = cd.getUint16(p + 28, true), el = cd.getUint16(p + 30, true), cl = cd.getUint16(p + 32, true);
    const nb = new Uint8Array(cd.buffer, cd.byteOffset + p + 46, nl);
    let name;
    try { name = U8.decode(nb); } catch (e) { name = L1.decode(nb); }
    for (let q = p + 46 + nl, qe = q + el; q + 4 <= qe; q += 4 + cd.getUint16(q + 2, true)) {
      if (cd.getUint16(q, true) !== 1) continue;
      let r = q + 4;
      if (usize === 0xffffffff) { usize = Number(cd.getBigUint64(r, true)); r += 8; }
      if (csize === 0xffffffff) { csize = Number(cd.getBigUint64(r, true)); r += 8; }
      if (off === 0xffffffff) off = Number(cd.getBigUint64(r, true));
    }
    p += 46 + nl + el + cl;
    const path = cleanPath(name);
    if (!path || JUNK.test(path)) continue;
    const dir = /[\\/]$/.test(name);
    const e = { path, base: path.replace(/\/$/, '').split('/').pop(), dir, method, csize, usize, off, date: new Date(((dd >> 9) & 127) + 1980, ((dd >> 5) & 15) - 1, dd & 31, (dt >> 11) & 31, (dt >> 5) & 63, (dt & 31) * 2), bad: false, reason: '' };
    if (flags & 1) { e.bad = true; e.reason = 'Encrypted'; }
    else if (method !== 0 && method !== 8) { e.bad = true; e.reason = 'Unsupported compression'; }
    entries.push(e);
  }
  return entries;
}

export async function entryBlob(url, e, type) {
  if (!e.csize) return new Blob([], { type: type || '' });
  const h = new DataView(await (await range(url, e.off, e.off + 29)).arrayBuffer());
  if (h.byteLength < 30 || h.getUint32(0, true) !== 0x04034b50) throw new Error('The ZIP entry "' + e.path + '" looks corrupt.');
  const start = e.off + 30 + h.getUint16(26, true) + h.getUint16(28, true);
  const r = await range(url, start, start + e.csize - 1);
  const body = e.method === 0 ? r.body : r.body.pipeThrough(new DecompressionStream('deflate-raw'));
  const b = await new Response(body).blob();
  return type ? b.slice(0, b.size, type) : b;
}

const CRC_T = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crcUpdate = (c, buf) => { for (let i = 0; i < buf.length; i++) c = CRC_T[(c ^ buf[i]) & 255] ^ (c >>> 8); return c; };
const dosTime = (d) => { d = d ? new Date(d) : new Date(); if (isNaN(d)) d = new Date(); const y = Math.max(1980, d.getFullYear()); return [((d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)) & 0xffff, (((y - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xffff]; };

// items: [{ zipName, size, modified, getUrl: async () => presignedUrl }]
// hooks: { canceled: () => bool, onProgress: (bytesRead, bytesTotal, index, name) => void }
export async function buildZip(items, hooks) {
  const te = new TextEncoder();
  const out = [];
  let buf = [], bufBytes = 0, offset = 0;
  const push = (u8) => { buf.push(u8); bufBytes += u8.length; offset += u8.length; if (bufBytes > 32 * 1048576) { out.push(new Blob(buf)); buf = []; bufBytes = 0; } };
  const central = [];
  const total = items.reduce((n, i) => n + i.size, 0);
  let read = 0;
  for (let n = 0; n < items.length; n++) {
    const it = items[n];
    if (hooks.canceled()) throw new Error('Canceled');
    const res = it.file ? { ok: true, body: it.file.stream() } : await fetch(await it.getUrl());
    if (!res.ok) throw new Error('Could not read "' + it.zipName + '" (HTTP ' + res.status + ').');
    const nameB = te.encode(it.zipName);
    const method = NOCOMP.test(it.zipName) ? 0 : 8;
    const [dt, dd] = dosTime(it.modified);
    const lo = offset;
    const h = new DataView(new ArrayBuffer(30)); // local header; sizes follow in a data descriptor (flag bit 3)
    h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x0808, true); h.setUint16(8, method, true);
    h.setUint16(10, dt, true); h.setUint16(12, dd, true); h.setUint16(26, nameB.length, true);
    push(new Uint8Array(h.buffer)); push(nameB);
    let crc = 0xffffffff, usize = 0, csize = 0;
    const tap = new TransformStream({ transform(chunk, ctl) { crc = crcUpdate(crc, chunk); usize += chunk.length; read += chunk.length; ctl.enqueue(chunk); } });
    let stream = (res.body || new Blob([]).stream()).pipeThrough(tap);
    if (method === 8) stream = stream.pipeThrough(new CompressionStream('deflate-raw'));
    const reader = stream.getReader();
    for (;;) {
      if (hooks.canceled()) { reader.cancel(); throw new Error('Canceled'); }
      const { done, value } = await reader.read();
      if (done) break;
      push(value); csize += value.length;
      hooks.onProgress(read, total, n, it.zipName);
      if (offset > 0xfff00000) throw new Error('This zip would be over 4 GB, which the in-browser zipper cannot build. Select fewer files.');
    }
    crc = (crc ^ 0xffffffff) >>> 0;
    const d = new DataView(new ArrayBuffer(16));
    d.setUint32(0, 0x08074b50, true); d.setUint32(4, crc, true); d.setUint32(8, csize, true); d.setUint32(12, usize, true);
    push(new Uint8Array(d.buffer));
    central.push({ nameB, method, crc, csize, usize, lo, dt, dd });
  }
  const cdStart = offset;
  for (const c of central) {
    const h = new DataView(new ArrayBuffer(46));
    h.setUint32(0, 0x02014b50, true); h.setUint16(4, 20, true); h.setUint16(6, 20, true); h.setUint16(8, 0x0808, true); h.setUint16(10, c.method, true);
    h.setUint16(12, c.dt, true); h.setUint16(14, c.dd, true); h.setUint32(16, c.crc, true); h.setUint32(20, c.csize, true); h.setUint32(24, c.usize, true);
    h.setUint16(28, c.nameB.length, true); h.setUint32(42, c.lo, true);
    push(new Uint8Array(h.buffer)); push(c.nameB);
  }
  const e = new DataView(new ArrayBuffer(22));
  e.setUint32(0, 0x06054b50, true); e.setUint16(8, central.length, true); e.setUint16(10, central.length, true); e.setUint32(12, offset - cdStart, true); e.setUint32(16, cdStart, true);
  push(new Uint8Array(e.buffer));
  return new Blob(out.concat(buf), { type: 'application/zip' });
}
