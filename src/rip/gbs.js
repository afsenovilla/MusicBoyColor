// GBS (Game Boy Sound) files: a ripped sound driver plus a small header that
// says where INIT and PLAY live. No detection needed - just follow the spec.

import { GameBoy, FRAME_DOTS } from '../core/gb.js';

const le16 = (b, o) => b[o] | (b[o + 1] << 8);

function text(b, from) {
  let s = '';
  for (let i = from; i < from + 32 && b[i]; i++) s += b[i] >= 0x20 && b[i] < 0x7f ? String.fromCharCode(b[i]) : ' ';
  return s.trim();
}

export function loadGbs(bytes) {
  const songs = bytes[4], first = bytes[5];
  const load = le16(bytes, 6), init = le16(bytes, 8), play = le16(bytes, 10), sp = le16(bytes, 12);
  const tma = bytes[14], tac = bytes[15];
  if (load < 0x70 || load >= 0x8000) throw new Error('err.gbs');
  const data = bytes.subarray(0x70);
  const rom = new Uint8Array(load + data.length);
  rom.set(data, load);
  for (let v = 0; v < 0x40; v += 8) { // RST vectors are relocated to the load address
    rom[v] = 0xc3; rom[v + 1] = (load + v) & 0xff; rom[v + 2] = (load + v) >> 8;
  }
  const cgb = (tac & 0x80) !== 0;
  const gb = new GameBoy(rom, { gbs: true, cgb });
  gb.a = gb.f = gb.b = gb.c = gb.d = gb.e = gb.h = gb.l = 0;
  gb.sp = sp; gb.noInt = true; gb.ramEn = true; gb.ds = cgb;
  gb.tma = tma; gb.tac = tac & 7;
  gb.apu.write(0xff25, 0xff, 0);
  const tickDots = (tac & 4) ? ((1 << [10, 4, 6, 8][tac & 3]) * (256 - tma)) / (cgb ? 2 : 1) : FRAME_DOTS;
  const copyright = text(bytes, 0x50);
  const year = (copyright.match(/\b(19[89]\d|20[0-2]\d)\b/) || [])[1] || '';
  return {
    gb,
    cfg: { kind: 'gbs', snap: gb.save(), tickDots, initAddr: init, playAddr: play },
    ids: Array.from({ length: songs }, (_, i) => i),
    first: Math.max(0, first - 1),
    meta: {
      type: 'gbs', title: text(bytes, 0x10), rawTitle: text(bytes, 0x10), publisher: '',
      author: text(bytes, 0x30), copyright, year, system: cgb ? 'Game Boy Color' : 'Game Boy',
      mapper: 'GBS', size: bytes.length, checksum: '', songs,
    },
  };
}
