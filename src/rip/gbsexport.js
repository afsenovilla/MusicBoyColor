// Build a GBS file from a ROM whose sound driver the scanner has located.
//
// A GBS is the ROM (from a load address >= 0x400 upwards) plus INIT and PLAY
// entry points, started on blank memory. To get there from our "snapshot +
// selector function + play routine" we add a small machine-code stub that
//   - restores the driver's RAM from the snapshot (stored in an extra bank),
//   - sets the master sound registers,
//   - maps the GBS song number to the game's song id,
//   - calls the game's selector, and forwards PLAY to the play routine.
// Code the driver runs below 0x400 (typically bank-switching trampolines)
// cannot be part of a GBS, so it is copied next to the stub and re-pointed.
//
// Not every game can be converted; unsupported cases throw Error('gbs.*').
// The result is verified by playing every song from the GBS in our own
// emulator and comparing the sound-register writes with the ROM's.

import { step } from '../core/cpu.js';
import { FRAME_DOTS } from '../core/gb.js';
import { loadGbs } from './gbs.js';
import { Player } from './player.js';

const LOAD = 0x400;
const SENT = 0xfea0;
const ABS = new Set([0xc2, 0xc3, 0xca, 0xd2, 0xda, 0xc4, 0xcc, 0xcd, 0xd4, 0xdc]);
const LEN3 = new Set([0x01, 0x11, 0x21, 0x31, 0x08, 0xea, 0xfa, ...ABS]);
const LEN2 = new Set([0x06, 0x0e, 0x16, 0x1e, 0x26, 0x2e, 0x36, 0x3e, 0x18, 0x20, 0x28, 0x30, 0x38, 0x10,
  0xc6, 0xce, 0xd6, 0xde, 0xe6, 0xee, 0xf6, 0xfe, 0xe0, 0xf0, 0xe8, 0xf8, 0xcb]);
const opLen = (op) => (LEN3.has(op) ? 3 : LEN2.has(op) ? 2 : 1);
const REG_LOAD = { b: 0x47, c: 0x4f, d: 0x57, e: 0x5f, h: 0x67, l: 0x6f };

// Run one subroutine with per-instruction tracing.
function tracedCall(gb, addr, prof) {
  const sp = gb.sp;
  gb.sp = (gb.sp - 2) & 0xffff;
  gb.write8(gb.sp, SENT & 0xff); gb.write8(gb.sp + 1, SENT >> 8);
  gb.pc = addr;
  const end = gb.clock + FRAME_DOTS * 4;
  while (!(gb.pc === SENT && gb.sp === sp)) {
    if (gb.clock >= end || gb.crashed) return false;
    const pc = gb.pc;
    if (pc < 0x8000) {
      const op = gb.read8(pc);
      if ((op & 0xc7) === 0xc7) prof.rsts.add(op & 0x38);
      if (pc < LOAD) prof.low.add(pc);
    }
    const cyc = step(gb);
    gb.advance(gb.ds ? cyc >> 1 : cyc, cyc);
  }
  return true;
}

// The reference behaviour a GBS must reproduce: everything from the snapshot,
// interrupts off, selector called as a plain subroutine.
function reference(session, id, ticks, prof) {
  const p = session.player, gb = p.gb, c = p.cfg;
  gb.load(c.snap);
  gb.tr = null; gb.onApu = null;
  gb.noInt = true; gb.halted = false;
  if (c.kind === 'call') gb.sp = (gb.sp + 2) & 0xffff; // drop the game's own return address
  gb.mt = { r(i) { prof.ram.add(i); }, w(i) { prof.ram.add(i); } };
  const writes = [];
  gb.onApu = (a, v) => writes.push((a << 8) | v);
  const select = (v) => {
    if (c.kind === 'poke') { gb.ram[c.ramId] = v; return true; }
    if (c.reg !== 'a') gb[c.reg] = v;
    gb.a = v;
    if (c.snap.pc >= 0x4000) gb.romOff = c.snap.romOff;
    return tracedCall(gb, c.snap.pc, prof);
  };
  const play = () => {
    if (c.playAddr >= 0x4000) gb.romOff = c.playRomOff;
    return tracedCall(gb, c.playAddr, prof);
  };
  let ok = true;
  if (c.pre !== undefined) { ok = select(c.pre) && ok; for (let k = 0; k < 8; k++) ok = play() && ok; }
  ok = select(id) && ok;
  const playStart = writes.length;
  let done = 0;
  for (; done < ticks && ok; done++) ok = play();
  gb.mt = null; gb.onApu = null;
  return { ok, writes: writes.slice(playStart), ticks: done };
}

// The GBS starts from a silent chip while the ROM snapshot has notes ringing,
// so the driver may issue a few extra (or fewer) channel-off writes. Accept
// streams that are identical apart from a handful of such insertions.
function nearlyEqual(a, b) {
  let i = 0, j = 0, skipped = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; continue; }
    let found = false;
    for (let d = 1; d <= 6 && !found; d++) {
      for (let da = 0; da <= d && !found; da++) {
        const db = d - da;
        if (a[i + da] !== undefined && a[i + da] === b[j + db] && a[i + da + 1] === b[j + db + 1]) { i += da; j += db; skipped += d; found = true; }
      }
    }
    if (!found) return false;
  }
  skipped += (a.length - i) + (b.length - j);
  return skipped <= 12;
}

// The stub needs room in bank 0. Rather than guess which bytes are padding,
// use the longest stretch of bank 0 the driver never read or executed.
function findFree(touched, need) {
  let best = null;
  for (let i = LOAD + 0x40; i < 0x4000;) {
    let j = i;
    while (j < 0x4000 && !touched[j]) j++;
    if (j - i >= need + 16 && (!best || j - i > best.len)) best = { at: i + 8, len: j - i };
    i = j + 1;
  }
  return best;
}

// Returns { data: Uint8Array, checked, matched, notes }.
export function buildGbs(session, rom, tags = {}) {
  const p = session.player, c = p.cfg;
  if (c.kind !== 'call' && c.kind !== 'poke') throw new Error('gbs.noDriver');
  if (c.kind === 'call' && c.ramId !== undefined) throw new Error('gbs.unsupported');
  if (!session.tracks.length) throw new Error('gbs.unsupported');
  const prof = { low: new Set(), ram: new Set(), rsts: new Set() };
  const mbc = new Set();
  const gb = p.gb, origMbc = gb.mbcWrite, origRead = gb.read8;
  const touched = new Uint8Array(0x4000);
  let lowRead = new Uint8Array(LOAD);
  gb.mbcWrite = function (a, v) { mbc.add((a & 0xf000) | v); origMbc.call(this, a, v); };
  gb.read8 = function (a) { if (a < 0x4000) { touched[a] = 1; if (a < LOAD) lowRead[a] = 1; } return origRead.call(this, a); };
  const tracks = [], refs = [];
  let dropped = 0;
  try {
    for (const t of session.tracks) {
      // Ids that made the driver scribble outside its own memory are not songs,
      // and running them can crash other players.
      if (t.dubious) { dropped++; continue; }
      const ticks = Math.min(600, (t.info.looping ? t.info.loopStart + t.info.loopLen : t.info.endTick) + 30);
      const one = { low: new Set(), ram: new Set(), rsts: new Set() };
      lowRead = new Uint8Array(LOAD);
      const ref = reference(session, t.id, ticks, one);
      // A song is convertible when everything it touches below the load address
      // is code we can relocate: no RST, no data tables down there, no wild jumps.
      const code = new Uint8Array(LOAD + 4);
      for (const pc of one.low) for (let k = 0; k < opLen(rom[pc]); k++) code[pc + k] = 1;
      let clean = ref.ok;
      for (let a2 = 0; a2 < LOAD && clean; a2++) if (lowRead[a2] && !code[a2]) clean = false;
      if (!clean) {
        dropped++;
        if (tags.debug) {
          const data = []; for (let a2 = 0; a2 < LOAD; a2++) if (lowRead[a2] && !code[a2]) data.push(a2.toString(16));
          tags.debug(`drop id ${t.id}: ok=${ref.ok} rst=${[...one.rsts]} lowData=[${data.slice(0, 12).join(' ')}] lowPc=[${[...one.low].filter((x) => x < 0x2ad || x > 0x368).map((x) => x.toString(16)).slice(0, 8).join(' ')}]`);
        }
        continue;
      }
      for (const pc of one.low) prof.low.add(pc);
      for (const v of one.rsts) prof.rsts.add(v);
      for (const i of one.ram) prof.ram.add(i);
      tracks.push(t); refs.push(ref);
    }
  } finally { gb.mbcWrite = origMbc; gb.read8 = origRead; }
  if (!tracks.length) throw new Error('gbs.lowData');
  if (tracks.length > 255) throw new Error('gbs.unsupported');
  let maxBank = 1;
  for (const w of mbc) {
    const a = w & 0xf000, v = w & 0xff;
    if (a === 0x3000 && session.meta.mapper === 'MBC5') throw new Error('gbs.mapper');
    if (a === 0x2000 || a === 0x3000) maxBank = Math.max(maxBank, v);
  }
  const selBank = c.kind === 'call' && c.snap.pc >= 0x4000 ? c.snap.romOff / 0x4000 + 1 : 0;
  const playBank = c.playAddr >= 0x4000 ? c.playRomOff / 0x4000 + 1 : 0;
  maxBank = Math.max(maxBank, selBank, playBank, c.snap.romOff / 0x4000 + 1);
  const dataBank = maxBank + 1;
  if (dataBank > 255) throw new Error('gbs.unsupported');

  // ---- relocate low code ----------------------------------------------------
  const lows = [...prof.low].sort((a, b) => a - b);
  const clusters = [];
  for (const pc of lows) {
    const endPc = pc + opLen(rom[pc]);
    const last = clusters[clusters.length - 1];
    if (last && pc <= last.end + 16) last.end = Math.max(last.end, endPc);
    else clusters.push({ start: pc, end: endPc, to: 0 });
  }
  // ---- RAM image ------------------------------------------------------------
  // The stub runs on the game's own stack; never overwrite it while restoring.
  const sp = c.kind === 'call' ? (c.snap.sp + 2) & 0xffff : c.snap.sp;
  const idAddr = (i) => (i >= 0x8000 ? 0xff80 + (i - 0x8000) : i < 0x1000 ? 0xc000 + i : 0xd000 + (i & 0xfff));
  const ids = [...prof.ram].filter((i) => i < 0x8000 + 0x7f && !(idAddr(i) >= sp - 64 && idAddr(i) < sp + 2)).sort((a, b) => a - b);
  const records = [];
  const banks = new Set();
  for (let k = 0; k < ids.length;) {
    let j = k;
    while (j + 1 < ids.length && ids[j + 1] === ids[j] + 1 && j - k < 254 && (ids[j + 1] >> 12) === (ids[k] >> 12)) j++;
    const id = ids[k];
    let svbk = 1, addr;
    if (id >= 0x8000) addr = 0xff80 + (id - 0x8000);
    else if (id < 0x1000) addr = 0xc000 + id;
    else { svbk = id >> 12; addr = 0xd000 + (id & 0xfff); banks.add(svbk); }
    records.push(svbk, addr & 0xff, addr >> 8, j - k + 1, ...c.snap.ram.subarray(id, id + j - k + 1));
    k = j + 1;
  }
  records.push(0xff);
  if (records.length > 0x4000) throw new Error('gbs.unsupported');
  const snapSvbk = (c.snap.wbk >> 12) || 1;

  // ---- stub -----------------------------------------------------------------
  const relocSize = clusters.reduce((n, cl) => n + cl.end - cl.start, 0);
  const free = findFree(touched, 160 + relocSize + tracks.length);
  if (!free) throw new Error('gbs.noSpace');
  const out = [];
  let org = free.at;
  for (const cl of clusters) { cl.to = org; org += cl.end - cl.start; }
  const moved = (addr) => {
    for (const cl of clusters) if (addr >= cl.start && addr < cl.end) return cl.to + addr - cl.start;
    return -1;
  };
  for (const cl of clusters) {
    const bytes = [...rom.subarray(cl.start, cl.end)];
    for (let i = 0; i < bytes.length;) {
      const op = bytes[i], n = opLen(op);
      if (ABS.has(op) && i + 2 < bytes.length) {
        const target = bytes[i + 1] | (bytes[i + 2] << 8);
        if (target < LOAD) {
          const m = moved(target);
          if (m < 0) throw new Error('gbs.lowCode');
          bytes[i + 1] = m & 0xff; bytes[i + 2] = m >> 8;
        }
      }
      i += n;
    }
    out.push(...bytes);
  }
  const fix = (addr) => {
    if (addr >= LOAD) return addr;
    const m = moved(addr);
    if (m < 0) throw new Error('gbs.lowCode');
    return m;
  };
  const base = free.at;
  const here = () => base + out.length;
  const emit = (...b) => out.push(...b.map((x) => x & 0xff));
  const w16 = (v) => [v & 0xff, v >> 8];
  const setBank = (b) => { if (b) emit(0xf5, 0x3e, b, 0xea, 0x00, 0x20, 0xf1); }; // push af / ld a,b / ld (2000),a / pop af

  const playStub = here();
  setBank(playBank);
  emit(0xc3, ...w16(fix(c.playAddr)));
  const selStub = here();
  if (c.kind === 'poke') {
    const id = c.ramId;
    const addr = id >= 0x8000 ? 0xff80 + (id - 0x8000) : id < 0x1000 ? 0xc000 + id : 0xd000 + (id & 0xfff);
    emit(0xea, ...w16(addr), 0xc9);
  } else {
    if (c.reg !== 'a') emit(REG_LOAD[c.reg]);
    setBank(selBank);
    emit(0xc3, ...w16(fix(c.snap.pc)));
  }
  const initStub = here();
  const tableRef = out.length + 4;
  emit(0x5f, 0x16, 0x00, 0x21, 0, 0, 0x19, 0x7e, 0xf5);            // e=a d=0 hl=table add hl,de a=(hl) push af
  emit(0x3e, dataBank, 0xea, 0x00, 0x20, 0x21, 0x00, 0x40);         // map data bank, hl=4000
  const rec = here();
  emit(0x2a, 0xfe, 0xff, 0x28, 0);                                  // a=(hl+) cp FF jr z,done
  const jrDone = out.length - 1;
  emit(0xe0, 0x70, 0x2a, 0x5f, 0x2a, 0x57, 0x2a, 0x47);             // ldh (70),a  e,d = dest  b = len
  const cp = here();
  emit(0x2a, 0x12, 0x13, 0x05, 0x20, (cp - (here() + 6)) & 0xff);   // a=(hl+) (de)=a inc de dec b jr nz,cp
  emit(0x18, (rec - (here() + 2)) & 0xff);                          // jr rec
  out[jrDone] = (here() - (base + jrDone + 1)) & 0xff;
  const regs = c.snap.apuState.regs;
  emit(0x3e, 0x80, 0xe0, 0x26, 0x3e, regs[0x14], 0xe0, 0x24, 0x3e, regs[0x15], 0xe0, 0x25);
  emit(0x3e, snapSvbk, 0xe0, 0x70);
  emit(0x3e, c.snap.romOff / 0x4000 + 1, 0xea, 0x00, 0x20);         // bank as the game had it
  if (c.pre !== undefined) {
    emit(0x3e, c.pre, 0xcd, ...w16(selStub), 0x06, 8);              // a=pre call sel b=8
    const lp = here();
    emit(0xc5, 0xcd, ...w16(playStub), 0xc1, 0x05, 0x20, (lp - (here() + 8)) & 0xff); // push bc call play pop bc dec b jr nz
  }
  emit(0xf1, 0xc3, ...w16(selStub));                                // pop af jp sel
  const table = here();
  out[tableRef] = table & 0xff; out[tableRef + 1] = table >> 8;
  for (const t of tracks) emit(t.id);
  if (out.length > free.len - 16) throw new Error('gbs.noSpace');

  // ---- assemble the file ------------------------------------------------------
  const image = new Uint8Array((dataBank + 1) * 0x4000);
  image.set(rom.subarray(0, Math.min(rom.length, dataBank * 0x4000)));
  image.set(out, base);
  image.set(records, dataBank * 0x4000);
  // A GBS player sends RST n to load address + n: put a jump to the (moved)
  // handler there, provided the driver does not use those bytes itself.
  for (const v of prof.rsts) {
    const m = moved(v);
    if (m < 0 || touched[LOAD + v] || touched[LOAD + v + 1] || touched[LOAD + v + 2]) throw new Error('gbs.rst');
    image.set([0xc3, m & 0xff, m >> 8], LOAD + v);
  }
  const ds = !!c.snap.ds;
  let tac = ds ? 0x80 : 0, tma = 0;
  if (p.tickDots !== FRAME_DOTS) {
    let best = Infinity;
    for (let r = 0; r < 4; r++) {
      const unit = (1 << [10, 4, 6, 8][r]) / (ds ? 2 : 1);
      const cnt = Math.max(1, Math.min(256, Math.round(p.tickDots / unit)));
      const err = Math.abs(cnt * unit - p.tickDots);
      if (err < best) { best = err; tac = (ds ? 0x80 : 0) | 4 | r; tma = 256 - cnt; }
    }
  }
  const file = new Uint8Array(0x70 + image.length - LOAD);
  file.set([0x47, 0x42, 0x53, 1, tracks.length, 1, ...w16(LOAD), ...w16(initStub), ...w16(playStub), ...w16(sp), tma & 0xff, tac]);
  const put = (s, o) => { for (let i = 0; i < Math.min(31, (s || '').length); i++) { const ch = s.charCodeAt(i); file[o + i] = ch < 0x7f && ch >= 0x20 ? ch : 0x3f; } };
  put(tags.title || session.meta.title, 0x10); put(tags.author || session.meta.publisher, 0x30); put(tags.copyright || '', 0x50);
  file.set(image.subarray(LOAD), 0x70);

  // ---- verify: play the GBS and compare register writes -----------------------
  const g = loadGbs(file);
  const gp = new Player(g.gb, g.cfg);
  const bad = [];
  tracks.forEach((t, k) => {
    const ref = refs[k];
    const writes = [];
    let ok = ref.ok && gp.start(k);
    g.gb.onApu = (a, v) => writes.push((a << 8) | v);
    for (let n = 0; n < ref.ticks && ok; n++) ok = gp.tick();
    g.gb.onApu = null;
    const same = ok && nearlyEqual(writes, ref.writes);
    if (!same) {
      bad.push(t.id);
      if (tags.debug) {
        let i = 0; while (i < writes.length && i < ref.writes.length && writes[i] === ref.writes[i]) i++;
        tags.debug(`id ${t.id}: ok=${ok} len ${writes.length} vs ref ${ref.writes.length}, first diff at ${i}: gbs ${(writes[i] || 0).toString(16)} ref ${(ref.writes[i] || 0).toString(16)} | prev ${ref.writes.slice(Math.max(0, i - 3), i).map((x) => x.toString(16)).join(' ')}`);
      }
    }
  });
  return { data: file, checked: tracks.length, matched: tracks.length - bad.length, bad, dropped, ids: tracks.map((t) => t.id), banks: dataBank + 1, relocated: relocSize };
}
