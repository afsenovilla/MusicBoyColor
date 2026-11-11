// Minimal but complete FLAC encoder: fixed predictors (order 0-4), partitioned
// Rice coding, stereo decorrelation, MD5 signature and Vorbis comments.
// Lossless by construction; verified against ffmpeg's decoder in the tests.

import { md5 } from './md5.js';

const BLOCK = 4096;
const CRC8 = new Uint8Array(256), CRC16 = new Uint16Array(256);
for (let i = 0; i < 256; i++) {
  let c = i, d = i << 8;
  for (let k = 0; k < 8; k++) {
    c = c & 0x80 ? ((c << 1) ^ 0x07) & 0xff : (c << 1) & 0xff;
    d = d & 0x8000 ? ((d << 1) ^ 0x8005) & 0xffff : (d << 1) & 0xffff;
  }
  CRC8[i] = c; CRC16[i] = d;
}

class BitWriter {
  constructor(cap) { this.buf = new Uint8Array(cap); this.pos = 0; this.acc = 0; this.n = 0; }
  reserve(bytes) {
    if (this.pos + bytes <= this.buf.length) return;
    const nb = new Uint8Array(Math.max(this.buf.length * 2, this.pos + bytes));
    nb.set(this.buf.subarray(0, this.pos)); this.buf = nb;
  }
  write(v, bits) { // bits <= 24
    this.acc = (this.acc << bits) | (v & ((1 << bits) - 1));
    this.n += bits;
    while (this.n >= 8) { this.n -= 8; this.buf[this.pos++] = (this.acc >>> this.n) & 0xff; }
  }
  write32(v, bits) { if (bits > 24) { this.write(v >>> 16, bits - 16); this.write(v & 0xffff, 16); } else this.write(v, bits); }
  unary(q) { while (q >= 24) { this.write(0, 24); q -= 24; } this.write(1, q + 1); }
  align() { if (this.n) this.write(0, 8 - this.n); }
}

const SCRATCH = [0, 1, 2, 3, 4].map(() => new Int32Array(BLOCK));

// Plan the cheapest subframe for one channel block. Returns a descriptor.
function planSubframe(x, n, bps) {
  let constant = true;
  for (let i = 1; i < n; i++) if (x[i] !== x[0]) { constant = false; break; }
  if (constant) return { type: 'const', bits: 8 + bps, x };
  const verbatim = 8 + bps * n;
  // Residuals for all orders by repeated differencing; pick lowest |sum|.
  SCRATCH[0].set(x.subarray(0, n));
  let bestOrder = 0, bestSum = Infinity;
  for (let o = 0; o <= 4 && o < n; o++) {
    const r = SCRATCH[o];
    if (o > 0) { const p = SCRATCH[o - 1]; for (let i = o; i < n; i++) r[i] = p[i] - p[i - 1]; }
    let s = 0;
    for (let i = o; i < n; i++) s += r[i] < 0 ? -r[i] : r[i];
    if (s < bestSum) { bestSum = s; bestOrder = o; }
  }
  const res = SCRATCH[bestOrder], order = bestOrder;
  let best = null;
  for (let po = 0; po <= 6; po++) {
    if (n % (1 << po) || (n >> po) <= order) break;
    const parts = 1 << po, plen = n >> po, ks = new Uint8Array(parts);
    let bits = 0, maxK = 0;
    for (let p = 0; p < parts; p++) {
      const from = p === 0 ? order : p * plen, to = (p + 1) * plen, cnt = to - from;
      let sum = 0;
      for (let i = from; i < to; i++) { const v = res[i]; sum += v < 0 ? -2 * v - 1 : 2 * v; }
      let k = 0;
      while (k < 30 && cnt * (1 << (k + 1)) < sum) k++;
      ks[p] = k; if (k > maxK) maxK = k;
      bits += cnt * (k + 1) + Math.floor(sum / (1 << k));
    }
    const pbits = maxK > 14 ? 5 : 4;
    bits += parts * pbits;
    if (!best || bits < best.bits) best = { bits, po, ks, pbits };
  }
  const total = 8 + order * bps + 6 + best.bits;
  if (total >= verbatim) return { type: 'verbatim', bits: verbatim, x };
  return { type: 'fixed', bits: total, x, order, po: best.po, ks: best.ks, pbits: best.pbits };
}

function writeSubframe(w, sf, n, bps) {
  const x = sf.x;
  if (sf.type === 'const') { w.write(0, 8); w.write32(x[0], bps); return; }
  if (sf.type === 'verbatim') { w.write(1 << 1, 8); for (let i = 0; i < n; i++) w.write32(x[i], bps); return; }
  const o = sf.order;
  w.write((8 | o) << 1, 8);
  for (let i = 0; i < o; i++) w.write32(x[i], bps);
  // Recompute the residual (scratch buffers are shared between channels).
  const r = new Int32Array(n);
  r.set(x.subarray(0, n));
  for (let k = 0; k < o; k++) for (let i = n - 1; i > k; i--) r[i] -= r[i - 1];
  w.write(sf.pbits === 5 ? 1 : 0, 2); w.write(sf.po, 4);
  const parts = 1 << sf.po, plen = n >> sf.po;
  for (let p = 0; p < parts; p++) {
    const k = sf.ks[p];
    w.write(k, sf.pbits);
    for (let i = p === 0 ? o : p * plen, to = (p + 1) * plen; i < to; i++) {
      const v = r[i], u = v < 0 ? -2 * v - 1 : 2 * v;
      w.unary(Math.floor(u / (1 << k)));
      if (k) w.write32(u % (1 << k), k);
    }
  }
}

function utf8Num(n) {
  if (n < 0x80) return [n];
  if (n < 0x800) return [0xc0 | (n >> 6), 0x80 | (n & 0x3f)];
  if (n < 0x10000) return [0xe0 | (n >> 12), 0x80 | ((n >> 6) & 0x3f), 0x80 | (n & 0x3f)];
  return [0xf0 | (n >> 18), 0x80 | ((n >> 12) & 0x3f), 0x80 | ((n >> 6) & 0x3f), 0x80 | (n & 0x3f)];
}

const RATE_CODE = { 8000: 4, 16000: 5, 22050: 6, 24000: 7, 32000: 8, 44100: 9, 48000: 10, 96000: 11 };

// left/right: Int32Array of signed samples at `bps` bits. tags: [[key, value], ...]
export function encodeFlac(left, right, sampleRate, bps, tags = []) {
  const total = left.length;
  const w = new BitWriter(Math.ceil(total * bps / 4) + 65536);
  const enc = new TextEncoder();
  // --- metadata -----------------------------------------------------------
  const vendor = enc.encode('MusicBoyColor');
  const comments = tags.filter(([, v]) => v !== '' && v !== undefined && v !== null).map(([k, v]) => enc.encode(`${k}=${v}`));
  const vcLen = 8 + vendor.length + comments.reduce((s, c) => s + 4 + c.length, 0);
  const head = new Uint8Array(4 + 4 + 34 + 4 + vcLen);
  const dv = new DataView(head.buffer);
  head.set([0x66, 0x4c, 0x61, 0x43, 0x00, 0, 0, 34]);
  dv.setUint16(8, BLOCK); dv.setUint16(10, BLOCK);
  // min/max frame size (bytes 12-17) are filled in at the end
  dv.setUint32(18, (sampleRate << 12) | (1 << 9) | ((bps - 1) << 4) | Math.floor(total / 2 ** 32));
  dv.setUint32(22, total >>> 0);
  let o = 42;
  dv.setUint32(o, (0x84 << 24) | vcLen); o += 4;
  dv.setUint32(o, vendor.length, true); o += 4; head.set(vendor, o); o += vendor.length;
  dv.setUint32(o, comments.length, true); o += 4;
  for (const c of comments) { dv.setUint32(o, c.length, true); o += 4; head.set(c, o); o += c.length; }
  // --- frames -------------------------------------------------------------
  const mid = new Int32Array(BLOCK), side = new Int32Array(BLOCK);
  let minFrame = 0xffffff, maxFrame = 0;
  for (let start = 0, frame = 0; start < total; start += BLOCK, frame++) {
    const n = Math.min(BLOCK, total - start);
    const l = left.subarray(start, start + n), r = right.subarray(start, start + n);
    for (let i = 0; i < n; i++) { mid[i] = (l[i] + r[i]) >> 1; side[i] = l[i] - r[i]; }
    const pl = planSubframe(l, n, bps), pr = planSubframe(r, n, bps);
    const pm = planSubframe(mid, n, bps), ps = planSubframe(side, n, bps + 1);
    const opts = [[pl.bits + pr.bits, 1, pl, pr, bps, bps], [pl.bits + ps.bits, 8, pl, ps, bps, bps + 1],
      [ps.bits + pr.bits, 9, ps, pr, bps + 1, bps], [pm.bits + ps.bits, 10, pm, ps, bps, bps + 1]];
    opts.sort((a, b) => a[0] - b[0]);
    const [, assign, s0, s1, b0, b1] = opts[0];
    w.reserve(Math.ceil(n * (2 * bps + 2) / 8) + 64);
    const fs = w.pos;
    w.write(0xfff8, 16);
    w.write((7 << 4) | (RATE_CODE[sampleRate] || 0), 8);
    w.write((assign << 4) | ((bps === 24 ? 6 : bps === 16 ? 4 : 0) << 1), 8);
    for (const b of utf8Num(frame)) w.write(b, 8);
    w.write(n - 1, 16);
    let c8 = 0;
    for (let i = fs; i < w.pos; i++) c8 = CRC8[c8 ^ w.buf[i]];
    w.write(c8, 8);
    writeSubframe(w, s0, n, b0);
    writeSubframe(w, s1, n, b1);
    w.align();
    let c16 = 0;
    for (let i = fs; i < w.pos; i++) c16 = CRC16[((c16 >> 8) ^ w.buf[i]) & 0xff] ^ ((c16 << 8) & 0xffff);
    w.write(c16, 16);
    const size = w.pos - fs;
    if (size < minFrame) minFrame = size; if (size > maxFrame) maxFrame = size;
  }
  if (total) {
    head[12] = minFrame >> 16; head[13] = minFrame >> 8; head[14] = minFrame;
    head[15] = maxFrame >> 16; head[16] = maxFrame >> 8; head[17] = maxFrame;
  }
  // MD5 of the interleaved little-endian PCM.
  const bytes = bps >> 3, raw = new Uint8Array(total * 2 * bytes);
  for (let i = 0, p = 0; i < total; i++) {
    for (const v of [left[i], right[i]]) { raw[p++] = v; raw[p++] = v >> 8; if (bytes === 3) raw[p++] = v >> 16; }
  }
  head.set(md5(raw), 26);
  const out = new Uint8Array(head.length + w.pos);
  out.set(head); out.set(w.buf.subarray(0, w.pos), head.length);
  return out;
}
