// Builds small synthetic ROMs with a table-driven sound driver so the whole
// pipeline can be tested without any copyrighted game.
//   variant 'call': the game calls PlaySong with the id in A.
//   variant 'poke': the game writes id+1 to a request variable the driver polls.

class Asm {
  constructor() { this.b = new Uint8Array(0x8000); this.pc = 0; this.labels = {}; this.fix = []; }
  org(a) { this.pc = a; }
  label(n) { this.labels[n] = this.pc; }
  db(...v) { for (const x of v) this.b[this.pc++] = x & 0xff; }
  abs(op, l) { this.db(op); this.fix.push([this.pc, l, 0]); this.pc += 2; }
  rel(op, l) { this.db(op); this.fix.push([this.pc, l, 1]); this.pc += 1; }
  link() {
    for (const [at, l, rel] of this.fix) {
      const t = typeof l === 'number' ? l : this.labels[l];
      if (t === undefined) throw new Error('label ' + l);
      if (rel) this.b[at] = (t - (at + 1)) & 0xff; else { this.b[at] = t & 0xff; this.b[at + 1] = t >> 8; }
    }
    return this.b;
  }
}

const PTR = 0xc100, START = 0xc102, DELAY = 0xc104, PLAYING = 0xc105, REQUEST = 0xc106;
const note = (hz) => 2048 - Math.round(131072 / hz);
const seq = (hzs, dur) => hzs.flatMap((hz) => { const f = note(hz); return [f & 0xff, f >> 8, dur]; });

export const SONGS = [
  [...seq([523, 659, 784, 1047], 8), 0xfe],                                        // jingle, ends
  [...seq([262, 294, 330, 349, 392, 440, 494, 523], 15), 0xff],                    // 2 s loop
  [...seq([220, 220, 262, 220, 330, 294, 262, 247, 220, 196, 220, 262], 20), 0xff], // 4 s loop
  [...seq([440, 554, 659, 440, 554, 659, 880, 831, 740, 659, 587, 554, 494], 12), 0xff], // AAB form
  [...seq([131, 165, 196, 247, 262, 247, 196, 165, 131, 110, 98, 110, 131, 147, 165, 196, 220, 196], 10), 0xff],
];

export function makeRom(variant = 'call', title = 'TESTSONGS') {
  const a = new Asm();
  a.org(0x40); a.abs(0xc3, 'VBlank');
  a.org(0x100); a.db(0x00); a.abs(0xc3, 'Start');
  a.org(0x150);
  a.label('Start');
  a.db(0xf3); a.db(0x31, 0xff, 0xdf);
  for (const [r, v] of [[0x26, 0x80], [0x24, 0x77], [0x25, 0xff], [0x11, 0x80]]) a.db(0x3e, v, 0xe0, r);
  if (variant === 'call') { a.db(0x3e, 1); a.abs(0xcd, 'PlaySong'); }
  else { a.db(0x3e, 2); a.abs(0xea, REQUEST); }
  a.db(0x3e, 1, 0xe0, 0xff, 0xfb);
  a.label('Loop'); a.db(0x76); a.rel(0x18, 'Loop');
  a.label('VBlank');
  a.db(0xf5, 0xe5, 0xd5); a.abs(0xcd, 'Update'); a.db(0xd1, 0xe1, 0xf1, 0xd9);
  a.label('PlaySong');
  a.db(0xfe, SONGS.length, 0xd0, 0x87, 0x5f, 0x16, 0x00); a.abs(0x21, 'Table'); a.db(0x19);
  a.db(0x2a, 0x5f, 0x7e, 0x57);
  a.abs(0x21, PTR); a.db(0x7b, 0x22, 0x7a, 0x22, 0x7b, 0x22, 0x7a, 0x22, 0x3e, 1, 0x22, 0x77, 0xc9);
  a.label('Update');
  if (variant === 'poke') {
    a.abs(0xfa, REQUEST); a.db(0xb7); a.rel(0x28, 'NoReq');
    a.db(0x3d); a.abs(0xcd, 'PlaySong'); a.db(0xaf); a.abs(0xea, REQUEST);
    a.label('NoReq');
  }
  a.abs(0xfa, PLAYING); a.db(0xb7, 0xc8);
  a.abs(0x21, DELAY); a.db(0x35, 0xc0);
  a.abs(0xfa, PTR); a.db(0x6f); a.abs(0xfa, PTR + 1); a.db(0x67);
  a.label('Read');
  a.db(0x2a, 0xfe, 0xff); a.rel(0x20, 'NotLoop');
  a.abs(0xfa, START); a.db(0x6f); a.abs(0xfa, START + 1); a.db(0x67); a.rel(0x18, 'Read');
  a.label('NotLoop');
  a.db(0xfe, 0xfe); a.rel(0x20, 'Note');
  a.db(0xaf); a.abs(0xea, PLAYING); a.db(0xe0, 0x12, 0xc9);
  a.label('Note');
  a.db(0xe0, 0x13, 0x47, 0x3e, 0xf0, 0xe0, 0x12, 0x2a, 0xf6, 0x80, 0xe0, 0x14, 0x2a); a.abs(0xea, DELAY);
  a.db(0x7d); a.abs(0xea, PTR); a.db(0x7c); a.abs(0xea, PTR + 1); a.db(0xc9);
  a.label('Table');
  const tablePc = a.pc;
  a.pc += SONGS.length * 2;
  SONGS.forEach((s, i) => {
    a.b[tablePc + i * 2] = a.pc & 0xff; a.b[tablePc + i * 2 + 1] = a.pc >> 8;
    a.db(...s);
  });
  const rom = a.link();
  for (let i = 0; i < title.length; i++) rom[0x134 + i] = title.charCodeAt(i);
  rom[0x14b] = 0x01;
  let sum = 0;
  for (let i = 0x134; i <= 0x14c; i++) sum = (sum - rom[i] - 1) & 0xff;
  rom[0x14d] = sum;
  return rom;
}

// A GBS wrapping the same driver: INIT = PlaySong, PLAY = Update.
export function makeGbs() {
  const rom = makeRom('call');
  const a = new Asm(); a.b = rom;
  const find = (bytes) => { for (let i = 0x150; i < 0x400; i++) if (bytes.every((x, k) => rom[i + k] === x)) return i; throw new Error('sig'); };
  const init = find([0xfe, SONGS.length, 0xd0, 0x87]);
  const play = find([0xfa, PLAYING & 0xff, PLAYING >> 8, 0xb7, 0xc8]);
  const load = 0x150, end = 0x800;
  const out = new Uint8Array(0x70 + end - load);
  out.set([0x47, 0x42, 0x53, 1, SONGS.length, 1, load & 0xff, load >> 8, init & 0xff, init >> 8, play & 0xff, play >> 8, 0xfe, 0xdf, 0, 0]);
  const put = (s, o) => { for (let i = 0; i < s.length; i++) out[o + i] = s.charCodeAt(i); };
  put('Test Songs', 0x10); put('MusicBoyColor', 0x30); put('2026 Public Domain', 0x50);
  out.set(rom.subarray(load, end), 0x70);
  return out;
}
