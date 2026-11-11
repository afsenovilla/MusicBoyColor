// WAV (PCM) writer with a LIST/INFO chunk for basic metadata.

const INFO = { TITLE: 'INAM', ARTIST: 'IART', ALBUM: 'IPRD', DATE: 'ICRD', TRACKNUMBER: 'ITRK', GENRE: 'IGNR', COMMENT: 'ICMT' };

export function encodeWav(left, right, sampleRate, bps, tags = []) {
  const enc = new TextEncoder();
  const chunks = [];
  for (const [k, v] of tags) {
    if (!INFO[k] || v === '' || v === undefined) continue;
    const t = enc.encode(String(v));
    const body = new Uint8Array((t.length + 2) & ~1); // NUL-terminated, even length
    body.set(t);
    chunks.push([INFO[k], body]);
  }
  const infoLen = chunks.length ? 4 + chunks.reduce((s, [, b]) => s + 8 + b.length, 0) : 0;
  const bytes = bps >> 3, n = left.length, dataLen = n * 2 * bytes;
  const total = 12 + 24 + (infoLen ? 8 + infoLen : 0) + 8 + dataLen;
  const out = new Uint8Array(total), dv = new DataView(out.buffer);
  const tag = (o, s) => { for (let i = 0; i < 4; i++) out[o + i] = s.charCodeAt(i); };
  tag(0, 'RIFF'); dv.setUint32(4, total - 8, true); tag(8, 'WAVE');
  tag(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 2, true);
  dv.setUint32(24, sampleRate, true); dv.setUint32(28, sampleRate * 2 * bytes, true);
  dv.setUint16(32, 2 * bytes, true); dv.setUint16(34, bps, true);
  let o = 36;
  if (infoLen) {
    tag(o, 'LIST'); dv.setUint32(o + 4, infoLen, true); tag(o + 8, 'INFO'); o += 12;
    for (const [id, body] of chunks) { tag(o, id); dv.setUint32(o + 4, body.length, true); out.set(body, o + 8); o += 8 + body.length; }
  }
  tag(o, 'data'); dv.setUint32(o + 4, dataLen, true); o += 8;
  for (let i = 0; i < n; i++) {
    for (const v of [left[i], right[i]]) { out[o++] = v; out[o++] = v >> 8; if (bytes === 3) out[o++] = v >> 16; }
  }
  return out;
}
