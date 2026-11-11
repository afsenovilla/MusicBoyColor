// Game Boy APU (2 pulse channels, wave channel, noise channel).
// Time is measured in "dots" (4194304 Hz) relative to the start of the current
// audio frame. Channel waveforms are only generated when a Blip buffer is
// attached; without one the APU still tracks all register-visible state
// (length counters, sweep, envelopes), which makes analysis runs very cheap.

import { Blip } from './blip.js';

export const CLOCK_RATE = 4194304;
const FS_PERIOD = 8192; // 512 Hz frame sequencer
const DUTY = [0b00000001, 0b10000001, 0b10000111, 0b01111110];
const READ_MASK = [
  0x80, 0x3f, 0x00, 0xff, 0xbf, 0xff, 0x3f, 0x00, 0xff, 0xbf, 0x7f, 0xff, 0x9f, 0xff, 0xbf, 0xff,
  0xff, 0x00, 0x00, 0xbf, 0x00, 0x00, 0x70, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
];
const MAX_LEN = [64, 64, 256, 64];
const OUT_SCALE = 1 / 32; // 4 channels x 8 master-volume steps -> full scale 1.0

export class Apu {
  constructor(cgb) {
    this.cgb = !!cgb;
    this.regs = new Uint8Array(0x30);
    this.enabled = new Uint8Array(4);
    this.dac = new Uint8Array(4);
    this.len = new Uint16Array(4);
    this.lenEn = new Uint8Array(4);
    this.vol = new Uint8Array(4);
    this.envPer = new Uint8Array(4);
    this.envDir = new Uint8Array(4);
    this.envTimer = new Uint8Array(4);
    this.freq = new Uint16Array(4);
    this.timer = new Float64Array(4);
    this.duty = new Uint8Array(2);
    this.dutyPos = new Uint8Array(2);
    this.dig = new Uint8Array(4);
    this.lastL = new Float64Array(4);
    this.lastR = new Float64Array(4);
    this.gl = new Float64Array(4);
    this.gr = new Float64Array(4);
    this.swPer = 0; this.swNeg = 0; this.swShift = 0; this.swTimer = 0;
    this.swEnabled = 0; this.swShadow = 0; this.swNegUsed = 0;
    this.wavePos = 0; this.waveShift = 4; this.waveSample = 0;
    this.lfsr = 0x7fff; this.nShift = 0; this.nWidth = 0; this.nDiv = 0;
    this.power = 0; this.fsStep = 0; this.nextFs = FS_PERIOD; this.last = 0;
    this.blip = null;
    this.capL = 0; this.capR = 0; this.charge = 1;
  }

  save() {
    const s = {};
    for (const k of Object.keys(this)) {
      const v = this[k];
      if (typeof v === 'number' || typeof v === 'boolean') s[k] = v;
      else if (ArrayBuffer.isView(v)) s[k] = v.slice();
    }
    return s;
  }
  load(s) {
    for (const k of Object.keys(s)) {
      if (ArrayBuffer.isView(s[k])) this[k].set(s[k]); else this[k] = s[k];
    }
  }

  // Start generating audio. Output levels are primed to the current DC level
  // so the first sample does not begin with a click.
  attach(sampleRate) {
    this.blip = new Blip(sampleRate, CLOCK_RATE);
    this.updateGains();
    let l = 0, r = 0;
    for (let i = 0; i < 4; i++) {
      const a = this.dac[i] ? this.dig[i] / 7.5 - 1 : 0;
      this.lastL[i] = a * this.gl[i]; this.lastR[i] = a * this.gr[i];
      l += this.lastL[i]; r += this.lastR[i];
    }
    this.blip.accL = this.capL = l; this.blip.accR = this.capR = r;
    // ~28 Hz DC-blocking high-pass, like the capacitor on the console output.
    this.charge = Math.pow(0.999958, CLOCK_RATE / sampleRate);
  }

  updateGains() {
    const n50 = this.regs[0x14], n51 = this.regs[0x15];
    for (let i = 0; i < 4; i++) {
      this.gl[i] = (n51 >> (4 + i)) & 1 ? (((n50 >> 4) & 7) + 1) * OUT_SCALE : 0;
      this.gr[i] = (n51 >> i) & 1 ? ((n50 & 7) + 1) * OUT_SCALE : 0;
    }
  }

  emit(i, t) {
    if (!this.blip) return;
    const a = this.dac[i] ? this.dig[i] / 7.5 - 1 : 0;
    const l = a * this.gl[i], r = a * this.gr[i];
    const dl = l - this.lastL[i], dr = r - this.lastR[i];
    if (dl !== 0 || dr !== 0) { this.blip.add(t, dl, dr); this.lastL[i] = l; this.lastR[i] = r; }
  }

  // Recompute a channel's digital output from its state and emit the change.
  refresh(i, t) {
    let d = 0;
    if (this.enabled[i]) {
      if (i < 2) d = (DUTY[this.duty[i]] >> this.dutyPos[i]) & 1 ? this.vol[i] : 0;
      else if (i === 2) d = this.waveSample >> this.waveShift;
      else d = (~this.lfsr & 1) ? this.vol[3] : 0;
    }
    this.dig[i] = d;
    this.emit(i, t);
  }

  runChannels(to) {
    const from = this.last;
    this.last = to;
    if (!this.blip || to <= from) return;
    for (let i = 0; i < 2; i++) {
      if (!this.enabled[i]) continue;
      const per = (2048 - this.freq[i]) * 4, pat = DUTY[this.duty[i]], vol = this.vol[i];
      let tt = from + this.timer[i], pos = this.dutyPos[i];
      while (tt <= to) {
        pos = (pos + 1) & 7;
        const d = (pat >> pos) & 1 ? vol : 0;
        if (d !== this.dig[i]) { this.dig[i] = d; this.emit(i, tt); }
        tt += per;
      }
      this.timer[i] = tt - to; this.dutyPos[i] = pos;
    }
    if (this.enabled[2]) {
      const per = (2048 - this.freq[2]) * 2;
      let tt = from + this.timer[2], pos = this.wavePos;
      while (tt <= to) {
        pos = (pos + 1) & 31;
        const b = this.regs[0x20 + (pos >> 1)];
        this.waveSample = pos & 1 ? b & 15 : b >> 4;
        const d = this.waveSample >> this.waveShift;
        if (d !== this.dig[2]) { this.dig[2] = d; this.emit(2, tt); }
        tt += per;
      }
      this.timer[2] = tt - to; this.wavePos = pos;
    }
    if (this.enabled[3] && this.nShift < 14) {
      const per = (this.nDiv ? this.nDiv * 16 : 8) << this.nShift, vol = this.vol[3];
      let tt = from + this.timer[3], l = this.lfsr;
      while (tt <= to) {
        const bit = (l ^ (l >> 1)) & 1;
        l = (l >> 1) | (bit << 14);
        if (this.nWidth) l = (l & ~0x40) | (bit << 6);
        const d = (~l & 1) ? vol : 0;
        if (d !== this.dig[3]) { this.dig[3] = d; this.emit(3, tt); }
        tt += per;
      }
      this.timer[3] = tt - to; this.lfsr = l;
    }
  }

  runTo(t) {
    while (this.nextFs <= t) {
      this.runChannels(this.nextFs);
      this.clockFs(this.nextFs);
      this.nextFs += FS_PERIOD;
    }
    this.runChannels(t);
  }

  clockFs(t) {
    const s = this.fsStep;
    this.fsStep = (s + 1) & 7;
    if (!this.power) return;
    if (!(s & 1)) {
      for (let i = 0; i < 4; i++) {
        if (this.lenEn[i] && this.len[i] > 0 && --this.len[i] === 0) { this.enabled[i] = 0; this.refresh(i, t); }
      }
    }
    if (s === 2 || s === 6) {
      if (--this.swTimer <= 0) {
        this.swTimer = this.swPer || 8;
        if (this.swEnabled && this.swPer) {
          const f = this.sweepCalc(t);
          if (f <= 2047 && this.swShift) {
            this.swShadow = this.freq[0] = f;
            this.regs[3] = f & 0xff; this.regs[4] = (this.regs[4] & 0xf8) | (f >> 8);
            this.sweepCalc(t);
          }
        }
      }
    }
    if (s === 7) {
      for (let i = 0; i < 4; i++) {
        if (i === 2 || !this.envPer[i]) continue;
        if (--this.envTimer[i] <= 0) {
          this.envTimer[i] = this.envPer[i];
          if (this.envDir[i]) { if (this.vol[i] < 15) this.vol[i]++; }
          else if (this.vol[i] > 0) this.vol[i]--;
          this.refresh(i, t);
        }
      }
    }
  }

  sweepCalc(t) {
    const n = this.swShadow >> this.swShift;
    let f;
    if (this.swNeg) { f = this.swShadow - n; this.swNegUsed = 1; } else f = this.swShadow + n;
    if (f > 2047) { this.enabled[0] = 0; this.refresh(0, t); }
    return f;
  }

  read(addr, t) {
    if (addr >= 0xff30) return this.regs[addr - 0xff10];
    const r = addr - 0xff10;
    if (r === 0x16) {
      this.runTo(t);
      return (this.power ? 0x80 : 0) | 0x70 | this.enabled[0] | (this.enabled[1] << 1) | (this.enabled[2] << 2) | (this.enabled[3] << 3);
    }
    return this.regs[r] | READ_MASK[r];
  }

  write(addr, v, t) {
    this.runTo(t);
    const r = addr - 0xff10;
    if (r >= 0x20) { this.regs[r] = v; return; }
    if (r === 0x16) {
      const on = v >> 7;
      if (this.power && !on) {
        for (let i = 0; i < 0x16; i++) this.writeReg(i, 0, t, true);
        for (let i = 0; i < 4; i++) { this.enabled[i] = 0; this.refresh(i, t); }
        this.power = 0;
      } else if (!this.power && on) { this.power = 1; this.fsStep = 0; }
      return;
    }
    if (r > 0x16) return;
    if (!this.power) {
      // On DMG the length counters stay writable while the APU is off.
      if (this.cgb || !(r === 1 || r === 6 || r === 0xb || r === 0x10)) return;
      if (r === 1 || r === 6) v &= 0x3f;
    }
    this.writeReg(r, v, t, false);
  }

  writeReg(r, v, t, powerOff) {
    const regs = this.regs;
    const old = regs[r];
    regs[r] = v;
    switch (r) {
      case 0x00:
        this.swPer = (v >> 4) & 7; this.swShift = v & 7;
        if (this.swNeg && !(v & 8) && this.swNegUsed) { this.enabled[0] = 0; this.refresh(0, t); }
        this.swNeg = (v >> 3) & 1;
        break;
      case 0x01: case 0x06: {
        const i = r === 1 ? 0 : 1;
        if (!powerOff || this.cgb) this.len[i] = 64 - (v & 0x3f);
        this.duty[i] = v >> 6; this.refresh(i, t);
        break;
      }
      case 0x02: case 0x07: case 0x11: {
        const i = r === 2 ? 0 : r === 7 ? 1 : 3;
        this.envPer[i] = v & 7; this.envDir[i] = (v >> 3) & 1;
        this.dac[i] = (v & 0xf8) ? 1 : 0;
        if (!this.dac[i]) this.enabled[i] = 0;
        this.refresh(i, t);
        break;
      }
      case 0x03: this.freq[0] = (this.freq[0] & 0x700) | v; break;
      case 0x08: this.freq[1] = (this.freq[1] & 0x700) | v; break;
      case 0x0d: this.freq[2] = (this.freq[2] & 0x700) | v; break;
      case 0x04: case 0x09: case 0x0e: case 0x13: {
        const i = r === 4 ? 0 : r === 9 ? 1 : r === 0xe ? 2 : 3;
        if (i < 3) this.freq[i] = (this.freq[i] & 0xff) | ((v & 7) << 8);
        const lenEn = (v >> 6) & 1;
        // Enabling length in the first half of a length period clocks it once.
        if (lenEn && !this.lenEn[i] && (this.fsStep & 1) && this.len[i] > 0) {
          if (--this.len[i] === 0 && !(v & 0x80)) this.enabled[i] = 0;
        }
        this.lenEn[i] = lenEn;
        if (v & 0x80) this.trigger(i);
        this.refresh(i, t);
        break;
      }
      case 0x0a:
        this.dac[2] = v >> 7;
        if (!this.dac[2]) this.enabled[2] = 0;
        this.refresh(2, t);
        break;
      case 0x0b: if (!powerOff || this.cgb) this.len[2] = 256 - v; break;
      case 0x0c: this.waveShift = [4, 0, 1, 2][(v >> 5) & 3]; this.refresh(2, t); break;
      case 0x10: if (!powerOff || this.cgb) this.len[3] = 64 - (v & 0x3f); break;
      case 0x12: this.nShift = v >> 4; this.nWidth = (v >> 3) & 1; this.nDiv = v & 7; break;
      case 0x14: case 0x15:
        if (old !== v) { this.updateGains(); for (let i = 0; i < 4; i++) this.emit(i, t); }
        break;
    }
  }

  trigger(i) {
    this.enabled[i] = this.dac[i];
    if (this.len[i] === 0) {
      this.len[i] = MAX_LEN[i];
      if (this.lenEn[i] && (this.fsStep & 1)) this.len[i]--;
    }
    if (i < 2) {
      this.timer[i] = (2048 - this.freq[i]) * 4;
    } else if (i === 2) {
      this.timer[2] = (2048 - this.freq[2]) * 2 + 6; this.wavePos = 0;
    } else {
      this.timer[3] = (this.nDiv ? this.nDiv * 16 : 8) << this.nShift; this.lfsr = 0x7fff;
    }
    if (i !== 2) {
      const nr = this.regs[i === 0 ? 2 : i === 1 ? 7 : 0x11];
      this.vol[i] = nr >> 4; this.envTimer[i] = this.envPer[i] || 8;
    }
    if (i === 0) {
      this.swShadow = this.freq[0]; this.swTimer = this.swPer || 8;
      this.swEnabled = (this.swPer || this.swShift) ? 1 : 0; this.swNegUsed = 0;
      if (this.swShift) this.sweepCalc(this.last);
    }
  }

  // Mute anything still ringing (used when a new song is started on top of a
  // snapshot in which another song was playing).
  silence(t) {
    this.runTo(t);
    for (let i = 0; i < 4; i++) { this.enabled[i] = 0; this.refresh(i, t); }
  }

  // True while any channel can currently produce sound.
  audible() {
    if (!this.power) return false;
    for (let i = 0; i < 4; i++) {
      if (!this.enabled[i] || !(this.gl[i] || this.gr[i])) continue;
      if (i === 2 ? this.waveShift < 4 : (this.vol[i] > 0 || (this.envDir[i] && this.envPer[i]))) return true;
    }
    return false;
  }

  // Finish the audio frame at time t and append samples to outL/outR.
  endFrame(t, outL, outR, at) {
    this.runTo(t);
    this.last -= t; this.nextFs -= t;
    if (!this.blip) return 0;
    this.blip.endFrame(t);
    const n = this.blip.read(outL, outR, at);
    let cl = this.capL, cr = this.capR;
    const ch = this.charge;
    for (let i = at; i < at + n; i++) {
      const l = outL[i] - cl; cl = outL[i] - l * ch; outL[i] = l;
      const r = outR[i] - cr; cr = outR[i] - r * ch; outR[i] = r;
    }
    this.capL = cl; this.capR = cr;
    return n;
  }
}
