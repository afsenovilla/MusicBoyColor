// Track playback on top of the emulator core.
//
// A Player knows how to start song `id` and then advance one "tick" (one call
// of the sound driver's play routine). Three ways of starting a song exist:
//   gbs  - GBS file: call INIT with A = id.
//   call - ROM: restore a snapshot taken at the entry of the game's own
//          "play song" function and replace the register holding the id.
//   poke - ROM: restore a snapshot and write the id to the driver's
//          song-request variable in RAM.
// After the song is started only the play routine runs (no game logic), so the
// game can never interrupt the music and playback is fully deterministic.
// `full` runs the whole game instead and is used as a last-resort capture.

import { FRAME_DOTS } from '../core/gb.js';
import { CLOCK_RATE } from '../core/apu.js';

const REGS = ['a', 'b', 'c', 'd', 'e', 'h', 'l'];

export class Player {
  constructor(gb, cfg) {
    this.gb = gb;
    this.cfg = cfg;
    this.tickDots = cfg.tickDots || FRAME_DOTS;
    this.tps = CLOCK_RATE / this.tickDots;
    this.due = 0;
  }

  start(id, skip = false) {
    const gb = this.gb, c = this.cfg;
    gb.load(c.snap);
    gb.tr = null; gb.mt = null; gb.onApu = null;
    if (c.kind === 'gbs') {
      gb.a = id;
      gb.noInt = true;
      if (!gb.call(c.initAddr, FRAME_DOTS * 60)) return false;
    } else if (c.kind === 'call') {
      gb.apu.silence(gb.clock - gb.apuBase);
      const retSp = (gb.sp + 2) & 0xffff;
      const ret = gb.read8(gb.sp) | (gb.read8((gb.sp + 1) & 0xffff) << 8);
      if (skip) { gb.sp = retSp; gb.pc = ret; }
      else {
        if (c.ramId !== undefined) gb.ram[c.ramId] = id & 0xff;
        else if (REGS.includes(c.reg)) gb[c.reg] = id & 0xff;
        else return false;
        const end = gb.clock + FRAME_DOTS * 4;
        while (!(gb.sp === retSp && gb.pc === ret)) {
          if (gb.clock >= end || gb.crashed) return false;
          gb.run(1);
        }
      }
      gb.noInt = true; gb.halted = false;
    } else if (c.kind === 'poke') {
      gb.apu.silence(gb.clock - gb.apuBase);
      if (!skip) gb.ram[c.ramId] = id & 0xff;
      gb.noInt = true; gb.halted = false;
    }
    this.due = gb.clock;
    return !gb.crashed;
  }

  tick() {
    const gb = this.gb, c = this.cfg;
    if (c.kind === 'full') { gb.run(FRAME_DOTS); return !gb.crashed; }
    this.due += this.tickDots;
    if (c.playRomOff !== undefined && c.playAddr >= 0x4000) gb.romOff = c.playRomOff;
    const ok = gb.call(c.playAddr, FRAME_DOTS * 3);
    const rest = Math.floor(this.due - gb.clock);
    if (rest > 0) gb.idle(rest);
    return ok && !gb.crashed;
  }
}

const TRIGGERS = new Set([0xff14, 0xff19, 0xff1e, 0xff23]);
const FREQ_LO = new Set([0xff13, 0xff18, 0xff1d, 0xff22]);

// Run song `id` without generating audio and describe it: is it music at all,
// does it loop (and where), or when does it end.
//   o.maxSec   - how long to listen at most
//   o.detect   - look for loop/end (otherwise just collect a fingerprint)
export function analyze(player, id, o = {}) {
  const gb = player.gb, tps = player.tps;
  const res = { ok: false, id, notes: 0, sustained: false, noteFp: 0, fp: 0, looping: false,
    loopStart: 0, loopLen: 0, loopSig: '', endTick: 0, firstAudible: -1, dubious: false, reason: '' };
  if (!player.start(id, o.skip)) { res.reason = 'crash'; return res; }
  const maxTicks = Math.round((o.maxSec || 4) * tps);
  const sec = Math.round(tps);
  const wild0 = gb.wildWrites;
  let tickHash = 0, fp = 0x811c9dc5, noteFp = 0x811c9dc5, notes = 0, lateNotes = 0, n = 0;
  gb.onApu = (a, v) => {
    tickHash = (Math.imul(tickHash ^ ((a << 8) | v), 0x01000193) + 0x9e3779b9) | 0;
    if (n < sec * 10) fp = Math.imul(fp ^ ((n << 16) | ((a & 0xff) << 8) | v), 0x01000193);
    if ((TRIGGERS.has(a) && (v & 0x80)) || (FREQ_LO.has(a) && gb.apu.regs[a - 0xff10] !== v)) {
      notes++;
      if (n >= maxTicks >> 1) lateNotes++;
      if (notes <= 40) noteFp = Math.imul(noteFp ^ ((a & 0xff) << 8 | v), 0x01000193);
    }
  };
  const dirty = [], flag = new Uint8Array(gb.ram.length);
  if (o.detect) gb.mt = { r() {}, w(i) { if (!flag[i]) { flag[i] = 1; dirty.push(i); } } };
  const seen = new Map(), states = [], wh = [];
  let lastAud = -1, cand = 0, verified = 0;
  const finish = () => {
    gb.onApu = null; gb.mt = null;
    res.notes = notes; res.fp = fp >>> 0; res.noteFp = notes >= 6 ? noteFp >>> 0 : 0;
    res.sustained = notes >= 6 && lateNotes >= 2;
    if (res.looping) {
      // Phase-independent identity of the loop: the same song entered at a
      // different position still gets the same signature.
      let sum = 0, xor = 0;
      for (let i = res.loopStart; i < res.loopStart + res.loopLen && i < wh.length; i++) {
        const h = Math.imul(wh[i] ^ (wh[i] >>> 15), 0x2c1b3c6d);
        sum = (sum + h) | 0; xor ^= Math.imul(h, 0x297a2d39);
      }
      res.loopSig = `${res.loopLen}:${sum >>> 0}:${xor >>> 0}`;
    }
    res.dubious = player.cfg.kind !== 'full' && gb.wildWrites !== wild0;
    return res;
  };
  for (; n < maxTicks; n++) {
    tickHash = 0;
    if (!player.tick()) { res.reason = 'crash'; return finish(); }
    gb.endAudioFrame();
    if (gb.apu.audible()) { lastAud = n; if (res.firstAudible < 0) res.firstAudible = n; }
    if (!o.detect) continue;
    wh.push(tickHash);
    if (n === sec * 5 && notes < 3) { res.reason = 'silent'; return finish(); }
    if (n > sec && n - lastAud > sec * 2) {
      if (lastAud < 0) { res.reason = 'silent'; return finish(); }
      res.ok = true; res.endTick = lastAud + 1; return finish();
    }
    // Driver state hash: when the complete state repeats, the song has looped.
    let h1 = 0x811c9dc5, h2 = 0x12345678;
    const ram = gb.ram;
    for (let k = 0; k < dirty.length; k++) {
      const b = ram[dirty[k]];
      h1 = Math.imul(h1 ^ b, 0x01000193); h2 = (Math.imul(h2, 31) + b + k) | 0;
    }
    const key = (h1 >>> 0) * 0x200000 + (h2 & 0x1fffff);
    states.push(key);
    if (cand) {
      if (states[n - cand] === key) {
        if (++verified >= Math.min(cand, sec * 2) + 30) {
          const m = n - verified - cand;
          res.ok = true;
          if (cand <= 8) { res.endTick = Math.min(m + sec * 2, lastAud + 1); }
          else {
            // The state hash only becomes comparable once every driver byte has
            // been touched, so walk back to where the output really starts repeating.
            let st = Math.max(0, m);
            while (st > 0 && wh[st - 1] === wh[st - 1 + cand]) st--;
            res.looping = true; res.loopStart = st; res.loopLen = cand;
          }
          return finish();
        }
      } else { cand = 0; verified = 0; }
    }
    if (!cand && seen.has(key)) { cand = n - seen.get(key); verified = 0; }
    seen.set(key, n);
  }
  if (o.detect) {
    res.ok = true;
    // No state recurrence (e.g. free-running counter in driver RAM): fall back
    // to periodicity of the register-write stream itself.
    const N = wh.length;
    let found = false;
    for (let p = Math.round(sec / 2); p <= N / 3 && !found; p++) {
      let i = N - 1;
      while (i >= p && wh[i] === wh[i - p]) i--;
      const run = N - 1 - i;
      if (run >= 2 * p && run >= N * 0.45) {
        res.looping = true; res.loopLen = p; res.loopStart = Math.max(0, i - p + 1); found = true;
      }
    }
    if (!found) res.endTick = N;
  } else res.ok = true;
  return finish();
}

// Render song `id` to stereo float PCM.
//   plan: { ticks, fadeSec, skipTicks }
export function render(player, id, plan, sampleRate, onProgress) {
  const gb = player.gb;
  if (!player.start(id)) return null;
  gb.endAudioFrame();
  gb.apu.attach(sampleRate);
  const per = player.tickDots * sampleRate / CLOCK_RATE;
  const cap = Math.ceil((plan.ticks + 2) * per) + 4096;
  const L = new Float32Array(cap), R = new Float32Array(cap);
  let pos = 0;
  for (let n = 0; n < plan.ticks; n++) {
    player.tick();
    pos += gb.endAudioFrame(L, R, pos);
    if (onProgress && (n & 255) === 0) onProgress(n / plan.ticks);
  }
  const skip = Math.min(pos, Math.max(0, Math.floor((plan.skipTicks || 0) * per)));
  const len = pos - skip;
  const fade = Math.min(len, Math.round((plan.fadeSec || 0) * sampleRate));
  const l = L.subarray(skip, pos), r = R.subarray(skip, pos);
  for (let i = 0; i < fade; i++) {
    const g = (fade - i) / fade, k = len - fade + i;
    l[k] *= g * g; r[k] *= g * g;
  }
  return { l, r, sampleRate };
}

// Decide how many ticks to render for an analysed track.
export function planFor(player, info, opts) {
  const tps = player.tps;
  const skipTicks = Math.max(0, (info.firstAudible > 0 ? info.firstAudible : 0) - 2);
  if (info.looping) {
    const fadeSec = opts.fadeSec;
    const ticks = Math.min(info.loopStart + info.loopLen * opts.loops + Math.ceil(fadeSec * tps), Math.round(opts.maxSec * tps));
    return { ticks, fadeSec, skipTicks };
  }
  const natural = info.endTick + Math.ceil(tps);
  const capTicks = Math.round(opts.maxSec * tps);
  if (natural > capTicks) return { ticks: capTicks, fadeSec: opts.fadeSec, skipTicks };
  return { ticks: natural, fadeSec: 0.05, skipTicks };
}

export function planSeconds(player, plan) {
  return Math.max(0, (plan.ticks - plan.skipTicks) / player.tps);
}
