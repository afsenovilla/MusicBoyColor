// Automatic song discovery in a ROM.
//
// There is no standard music format inside a Game Boy cartridge: every game
// ships its own sound driver. Instead of knowing drivers, we watch the game:
//
//  1. Boot the ROM (tapping START/A if nothing plays) while tracing the call
//     stack of every write to a sound register. The routine that is entered
//     once per tick and covers practically all sound writes is the driver's
//     "play" routine.
//  2. Record which RAM bytes that routine reads: that is the driver's state.
//  3. Find game code *outside* the driver that writes into that state. One of
//     those functions (or one of those bytes) is how the game says "play song
//     N": either a function taking the song id in a register, or a request
//     variable the driver polls.
//  4. Prove it: replay from a snapshot substituting other ids and check that
//     different, sustained music comes out. Then enumerate every id.
//
// Emulation is deterministic, so each step simply re-runs the boot sequence.

import { GameBoy, FRAME_DOTS } from '../core/gb.js';
import { Player, analyze } from './player.js';

const MAX_FRAMES = 150 * 60;
const QUIET_FRAMES = 25 * 60;
const INT_KEY = 2 ** 40;
const REG_ORDER = ['a', 'e', 'c', 'b', 'd', 'l', 'h'];

function keysAt(frame) {
  if (frame < QUIET_FRAMES) return 0;
  const k = frame - QUIET_FRAMES;
  if (k % 120 >= 6) return 0;
  return Math.floor(k / 120) & 1 ? 0x10 : 0x80; // alternate START and A
}

class Tracer {
  constructor(gb) {
    this.gb = gb; this.depth = 0; this.seq = 0;
    this.keys = []; this.sps = []; this.seqs = [];
  }
  call(target, isInt) {
    const gb = this.gb, sp = gb.sp;
    while (this.depth && this.sps[this.depth - 1] <= sp) this.pop();
    const bank = target >= 0x4000 && target < 0x8000 ? gb.romBank : 0;
    const key = (isInt ? INT_KEY : 0) + bank * 0x10000 + target;
    const d = this.depth++;
    this.keys[d] = key; this.sps[d] = sp; this.seqs[d] = ++this.seq;
    this.onPush(d, key);
  }
  ret() {
    const sp = this.gb.sp;
    while (this.depth && this.sps[this.depth - 1] < sp) this.pop();
  }
  pop() { this.onPop(--this.depth); }
  onPush() {}
  onPop() {}
}

function boot(rom, frames, setup, perFrame) {
  const gb = new GameBoy(rom);
  const tr = new Tracer(gb);
  gb.tr = tr;
  setup(gb, tr);
  for (let f = 0; f < frames && !gb.crashed; f++) {
    gb.keys = keysAt(f);
    gb.run(FRAME_DOTS);
    gb.endAudioFrame();
    if (perFrame && perFrame(f, gb) === false) return { gb, tr, frames: f + 1 };
  }
  return { gb, tr, frames };
}

// Pass 1: find the play routine and decide how long to observe.
function findPlay(rom, progress) {
  const stats = new Map();
  const slot = [], wrote = [], wild = [];
  const trig = new Uint16Array(MAX_FRAMES);
  let total = 0, frame = 0, firstTrig = -1;
  const run = boot(rom, MAX_FRAMES, (gb, tr) => {
    tr.onPush = (d, key) => {
      let st = stats.get(key);
      if (!st) { st = { key, calls: 0, impure: 0, inv: 0, writes: 0, depthSum: 0 }; stats.set(key, st); }
      st.calls++;
      slot[d] = st; wrote[d] = 0; wild[d] = gb.wildWrites;
    };
    tr.onPop = (d) => { if (gb.wildWrites !== wild[d]) slot[d].impure++; };
    gb.onApu = (a, v) => {
      if (a >= 0xff26) return;
      total++;
      for (let i = 0; i < tr.depth; i++) {
        const st = slot[i];
        st.writes++;
        if (!wrote[i]) { wrote[i] = 1; st.inv++; st.depthSum += i; }
      }
      if ((a === 0xff14 || a === 0xff19 || a === 0xff1e || a === 0xff23) && (v & 0x80)) {
        trig[frame]++;
        if (firstTrig < 0) firstTrig = frame;
      }
    };
  }, (f) => {
    frame = f + 1;
    if (f % 60 === 0 && progress) progress(f / MAX_FRAMES);
    if (f < 480 || f % 30) return true;
    let sum = 0;
    for (let q = 0; q < 4; q++) {
      let s = 0;
      for (let i = f - 480 + q * 120; i < f - 360 + q * 120; i++) s += trig[i];
      if (s < 2) return true;
      sum += s;
    }
    return sum < 20; // stop once 8 s of sustained music has been heard
  });
  const frames = run.frames;
  const sustained = frames < MAX_FRAMES;
  let cands = [...stats.values()].filter((s) => s.inv >= 10 && s.writes >= total * 0.9);
  if (!cands.length) cands = [...stats.values()].filter((s) => s.inv >= 10 && s.writes >= total * 0.5);
  let play = null;
  if (cands.length) {
    const minInv = Math.min(...cands.map((s) => s.inv));
    const pool = cands.filter((s) => s.inv <= minInv * 1.15 + 1);
    const depth = (s) => s.depthSum / s.inv;
    // Prefer the outermost routine that only ever does sound work (it is the
    // real per-tick entry point); otherwise the innermost one covering it all.
    const pure = pool.filter((s) => s.impure <= s.calls * 0.02);
    if (pure.length) play = pure.sort((x, y) => depth(x) - depth(y))[0].key;
    else play = pool.sort((x, y) => depth(y) - depth(x))[0].key;
  }
  return { frames, sustained, play, total, firstTrig };
}

// Pass 2: driver RAM footprint, tick rate and a base snapshot.
function profileDriver(rom, frames, playKey) {
  let playDepth = -1, snap = null, romOff = 0;
  const entries = [];
  const R = new Uint8Array(0x8080);
  const playAddr = playKey % 0x10000;
  boot(rom, frames, (gb, tr) => {
    tr.onPush = (d, key) => {
      if (key !== playKey || playDepth >= 0) return;
      playDepth = d;
      entries.push(gb.clock);
      romOff = gb.romOff;
      if (!snap && gb.clock >= (frames - 60) * FRAME_DOTS) {
        snap = gb.save();
        snap.pc = gb.read8(gb.sp) | (gb.read8((gb.sp + 1) & 0xffff) << 8);
        snap.sp = (gb.sp + 2) & 0xffff;
        snap.halted = false;
      }
    };
    tr.onPop = (d) => { if (d === playDepth) playDepth = -1; };
    gb.mt = { r(i) { if (playDepth >= 0) R[i] = 1; }, w() {} };
  });
  const gaps = [];
  for (let i = Math.max(1, entries.length - 400); i < entries.length; i++) gaps.push(entries[i] - entries[i - 1]);
  gaps.sort((a, b) => a - b);
  let tickDots = gaps.length ? gaps[gaps.length >> 1] : FRAME_DOTS;
  if (Math.abs(tickDots - FRAME_DOTS) < FRAME_DOTS * 0.01) tickDots = FRAME_DOTS;
  return { snap, R, tickDots, playAddr, playRomOff: romOff };
}

// Pass 3: who writes into the driver's state from outside the driver?
function findWriters(rom, frames, playKey, R) {
  let playDepth = -1;
  const ids = new Map();      // ram id -> { count, events }
  const invCount = new Map(); // function key -> invocations
  boot(rom, frames, (gb, tr) => {
    tr.onPush = (d, key) => {
      invCount.set(key, (invCount.get(key) || 0) + 1);
      if (key === playKey && playDepth < 0) playDepth = d;
    };
    tr.onPop = (d) => { if (d === playDepth) playDepth = -1; };
    gb.mt = {
      r() {},
      w(i, v) {
        if (playDepth >= 0 || !R[i]) return;
        let info = ids.get(i);
        if (!info) { info = { count: 0, events: [] }; ids.set(i, info); }
        if (++info.count > 64) return;
        const chain = [];
        for (let d = tr.depth - 1, lvl = 0; d >= 0 && lvl < 5; d--, lvl++) {
          chain.push({ key: tr.keys[d], seq: tr.seqs[d], level: lvl });
        }
        info.events.push({ v, chain });
        if (info.events.length > 4) info.events.shift();
      },
    };
  });
  return { ids, invCount };
}

// Pass 4: snapshots at the entry of specific call instances.
function snapshotCalls(rom, frames, seqs) {
  const want = new Set(seqs), snaps = new Map();
  boot(rom, frames, (gb, tr) => {
    tr.onPush = (d) => { if (want.has(tr.seqs[d])) snaps.set(tr.seqs[d], gb.save()); };
  }, () => snaps.size < want.size);
  return snaps;
}

function testIds(v0) {
  return [v0 + 1, v0 + 2, v0 + 3, v0 > 0 ? v0 - 1 : v0 + 4].map((x) => x & 0xff);
}

function score(gb, cfg, v0) {
  const p = new Player(gb, cfg);
  const fps = new Set();
  for (const id of testIds(v0)) {
    const r = analyze(p, id, { maxSec: 3 });
    if (r.ok && r.sustained && r.noteFp) fps.add(r.noteFp);
  }
  return fps.size;
}

// Full-game capture used when the driver cannot be isolated.
function captureFallback(rom, p1, log) {
  if (p1.firstTrig < 0) return { ok: false, error: 'err.silent' };
  const start = Math.max(0, p1.firstTrig - 2);
  const { gb } = boot(rom, start, () => {});
  gb.tr = null;
  log('log.fallback');
  return { ok: true, method: 'full', gb, cfg: { kind: 'full', snap: gb.save(), tickDots: FRAME_DOTS }, ids: [0] };
}

// Returns { ok, method, gb, cfg, ids, tracks } describing how to play each song.
// `validate(gb, cfg, ids)` must enumerate the songs a candidate configuration
// produces; a real song selector yields at least two different ones.
export function scanRom(rom, validate, log = () => {}, progress = () => {}) {
  log('log.boot');
  const p1 = findPlay(rom, (f) => progress(f * 0.3));
  if (p1.play === null) return captureFallback(rom, p1, log);
  const addr = (p1.play % 0x10000).toString(16).toUpperCase().padStart(4, '0');
  const bank = Math.floor((p1.play % INT_KEY) / 0x10000);
  log('log.play', { addr: `${bank.toString(16).toUpperCase().padStart(2, '0')}:${addr}`, sec: (p1.frames / 59.73).toFixed(0) });
  progress(0.3);

  const prof = profileDriver(rom, p1.frames, p1.play);
  if (!prof.snap) return captureFallback(rom, p1, log);
  const base = { tickDots: prof.tickDots, playAddr: prof.playAddr, playRomOff: prof.playRomOff };
  const gb = new GameBoy(rom);
  log('log.rate', { hz: (4194304 / prof.tickDots).toFixed(2) });

  // Does the music keep going when only the driver runs?
  const iso = analyze(new Player(gb, { ...base, kind: 'poke', snap: prof.snap, ramId: 0 }), 0, { maxSec: 4, skip: true });
  if (!iso.ok || !iso.sustained) return captureFallback(rom, p1, log);
  progress(0.4);

  const { ids, invCount } = findWriters(rom, p1.frames, p1.play, prof.R);
  const freqLimit = Math.max(8, p1.frames / 20);
  const pokes = [], calls = new Map();
  for (const [id, info] of ids) {
    if (info.count > freqLimit) continue;
    pokes.push({ ramId: id, v0: info.events[info.events.length - 1].v, count: info.count });
    for (const ev of info.events) {
      for (const c of ev.chain) {
        if (c.key >= INT_KEY || c.key === p1.play) continue;
        if ((invCount.get(c.key) || 0) > Math.max(6, p1.frames / 30)) continue;
        const cur = calls.get(c.key);
        if (!cur) calls.set(c.key, { key: c.key, seq: c.seq, level: c.level, inv: invCount.get(c.key) });
        else { cur.seq = Math.max(cur.seq, c.seq); cur.level = Math.min(cur.level, c.level); }
      }
    }
  }
  const callList = [...calls.values()].sort((a, b) => a.level - b.level || a.inv - b.inv).slice(0, 48);
  pokes.sort((a, b) => a.count - b.count);
  log('log.cands', { fns: callList.length, vars: pokes.length });
  progress(0.5);

  const snaps = snapshotCalls(rom, p1.frames, callList.map((c) => c.seq));
  progress(0.6);
  const all = Array.from({ length: 256 }, (_, i) => i);
  const hex = (n) => n.toString(16).toUpperCase();
  const callStage = (regs) => () => {
    const found = [];
    for (const reg of regs) {
      for (const c of callList) {
        const snap = snaps.get(c.seq);
        if (!snap) continue;
        const cfg = { ...base, kind: 'call', snap, reg };
        const s = score(gb, cfg, snap[reg]);
        if (s >= 2) found.push({ cfg, s, desc: ['log.selCall', { fn: hex(c.key % 0x10000), reg: reg.toUpperCase() }] });
      }
    }
    return found;
  };
  const stages = [
    callStage(['a']),
    () => {
      const found = [];
      for (const pk of pokes.slice(0, 96)) {
        const cfg = { ...base, kind: 'poke', snap: prof.snap, ramId: pk.ramId };
        const s = score(gb, cfg, pk.v0);
        if (s >= 2) found.push({ cfg, s, desc: ['log.selPoke', { id: hex(pk.ramId) }] });
      }
      return found;
    },
    callStage(REG_ORDER.slice(1)),
    () => { // song id passed in memory and consumed by an init function
      const found = [];
      for (const c of callList.slice(0, 12)) {
        const snap = snaps.get(c.seq);
        if (!snap) continue;
        for (const pk of pokes.slice(0, 24)) {
          const cfg = { ...base, kind: 'call', snap, reg: 'a', ramId: pk.ramId };
          const s = score(gb, cfg, snap.ram[pk.ramId]);
          if (s >= 2) found.push({ cfg, s, desc: ['log.selCallRam', { fn: hex(c.key % 0x10000), id: hex(pk.ramId) }] });
        }
      }
      return found;
    },
  ];
  for (let k = 0; k < stages.length; k++) {
    const found = stages[k]().sort((x, y) => y.s - x.s).slice(0, 3);
    let best = null;
    for (const f of found) {
      f.tracks = validate(gb, f.cfg, all);
      // Different songs have different lengths. A variable that merely moves
      // the position inside one song gives many "tracks" with the same loop.
      f.variety = new Set(f.tracks.map((t) => (t.info.looping ? `L${t.info.loopLen}` : `E${t.info.endTick}`))).size;
      // Real soundtracks are mostly looping pieces; ids that are really bytes
      // of a data pointer produce mostly open-ended garbage.
      const long = f.tracks.filter((t) => t.kind !== 'sfx');
      const loops = long.filter((t) => t.info.looping).length;
      const sane = f.tracks.length >= 4 && f.variety >= 2 && f.variety >= f.tracks.length * 0.6 && loops >= long.length * 0.5;
      if (sane && (!best || f.variety > best.variety)) best = f;
    }
    progress(0.6 + 0.1 * (k + 1));
    if (best) {
      log(...best.desc);
      return { ok: true, method: best.cfg.kind, gb, cfg: best.cfg, ids: all, tracks: best.tracks };
    }
  }
  return captureFallback(rom, p1, log);
}
