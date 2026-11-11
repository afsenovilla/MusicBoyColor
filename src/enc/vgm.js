// VGM 1.71 writer for the Game Boy DMG chip: an exact, replayable log of the
// sound-register writes, with loop point and GD3 tags.

const RATE = 44100;

function gd3(fields) {
  const text = fields.map((f) => `${f || ''}\0`).join('');
  const out = new Uint8Array(12 + text.length * 2), dv = new DataView(out.buffer);
  out.set([0x47, 0x64, 0x33, 0x20, 0x00, 0x01, 0x00, 0x00]);
  dv.setUint32(8, text.length * 2, true);
  for (let i = 0; i < text.length; i++) dv.setUint16(12 + i * 2, text.charCodeAt(i), true);
  return out;
}

// events: [{ t seconds, reg, val }], loopStartSec < 0 for no loop.
export function encodeVgm(events, seconds, loopStartSec, tags = {}) {
  const data = [];
  let pos = 0, loopByte = -1, loopSample = 0;
  const total = Math.round(seconds * RATE);
  const loopAt = loopStartSec >= 0 ? Math.round(loopStartSec * RATE) : -1;
  const wait = (to) => {
    let n = to - pos;
    while (n > 0) { const w = Math.min(n, 65535); data.push(0x61, w & 0xff, w >> 8); n -= w; }
    pos = to;
  };
  const markLoop = () => { if (loopAt >= 0 && loopByte < 0) { wait(loopAt); loopByte = data.length; loopSample = pos; } };
  for (const e of events) {
    const s = Math.min(total, Math.round(e.t * RATE));
    if (loopAt >= 0 && loopByte < 0 && s >= loopAt) markLoop();
    wait(s);
    data.push(0xb3, e.reg - 0xff10, e.val);
  }
  markLoop();
  wait(total);
  data.push(0x66);
  const tag = gd3([tags.title, '', tags.album, '', tags.system || 'Nintendo Game Boy', '', tags.artist, '', tags.year, 'MusicBoyColor', tags.comment]);
  const HEAD = 0x100;
  const out = new Uint8Array(HEAD + data.length + tag.length), dv = new DataView(out.buffer);
  out.set([0x56, 0x67, 0x6d, 0x20]);
  dv.setUint32(0x04, out.length - 4, true);
  dv.setUint32(0x08, 0x171, true);
  dv.setUint32(0x14, HEAD + data.length - 0x14, true);
  dv.setUint32(0x18, total, true);
  if (loopByte >= 0) { dv.setUint32(0x1c, HEAD + loopByte - 0x1c, true); dv.setUint32(0x20, total - loopSample, true); }
  dv.setUint32(0x24, 60, true);
  dv.setUint32(0x34, HEAD - 0x34, true);
  dv.setUint32(0x80, 4194304, true);
  out.set(data, HEAD); out.set(tag, HEAD + data.length);
  return out;
}
