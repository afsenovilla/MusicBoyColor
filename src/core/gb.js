// Game Boy / Game Boy Color machine: memory bus, cartridge mappers, timer,
// LCD timing (no rendering - only what software can observe), joypad, serial.
// Time unit: "dots" at 4194304 Hz. In CGB double-speed mode the CPU simply
// consumes half as many dots per cycle.

import { step } from './cpu.js';
import { Apu } from './apu.js';

export const FRAME_DOTS = 70224;
const SENTINEL = 0xfea0; // return address used by call(): never executed
const TIMER_SHIFT = [10, 4, 6, 8];
const RAM_SIZES = [0, 0x800, 0x2000, 0x8000, 0x20000, 0x10000];

function mbcKind(type) {
  if (type === 0 || type === 8 || type === 9) return 0;
  if (type <= 3 || type === 0xff) return 1;
  if (type === 5 || type === 6) return 2;
  if ((type >= 0x0f && type <= 0x13) || type === 0xfe) return 3;
  return 5;
}

export class GameBoy {
  // opts.gbs: treat `rom` as a flat GBS image with a simple bank register.
  constructor(rom, opts = {}) {
    const banks = Math.max(2, Math.ceil(rom.length / 0x4000));
    let size = 2; while (size < banks) size *= 2;
    this.rom = new Uint8Array(size * 0x4000);
    this.rom.set(rom);
    this.bankMask = size - 1;
    this.gbs = !!opts.gbs;
    this.cgb = opts.cgb !== undefined ? !!opts.cgb : (rom[0x143] & 0x80) !== 0;
    this.mbc = this.gbs ? 5 : mbcKind(rom[0x147]);
    this.ram = new Uint8Array(0x8080);   // WRAM (8 x 4K) followed by HRAM
    this.vram = new Uint8Array(0x4000);
    this.oam = new Uint8Array(0xa0);
    this.io = new Uint8Array(0x80);
    this.cram = new Uint8Array(Math.max(0x2000, this.gbs ? 0x2000 : RAM_SIZES[rom[0x149]] || 0));
    this.cramMask = this.cram.length - 1;
    this.apu = new Apu(this.cgb);
    // Hooks (not part of saved state).
    this.tr = null;        // call tracer: { call(target, isInterrupt), ret() }
    this.mt = null;        // RAM tracer: { r(id), w(id, value) }
    this.onApu = null;     // (addr, value) on every APU register write
    this.reset();
  }

  reset() {
    this.ram.fill(0); this.vram.fill(0); this.oam.fill(0); this.io.fill(0); this.cram.fill(0);
    const c = this.cgb;
    this.a = c ? 0x11 : 0x01; this.f = c ? 0x80 : 0xb0;
    this.b = 0; this.c = c ? 0 : 0x13; this.d = c ? 0xff : 0; this.e = c ? 0x56 : 0xd8;
    this.h = c ? 0 : 0x01; this.l = c ? 0x0d : 0x4d;
    this.sp = 0xfffe; this.pc = 0x100;
    this.ime = false; this.eiPending = false; this.halted = false; this.crashed = false;
    this.noInt = false;
    this.ie = 0; this.ifl = 1;
    this.clock = 0; this.apuBase = 0;
    this.ds = false; this.key1 = 0;
    this.div16 = 0xabcc; this.tima = 0; this.tma = 0; this.tac = 0;
    this.romOff = 0; this.mbcLo = 1; this.mbcHi = 0; this.mbcMode = 0;
    this.ramEn = false; this.cramOff = 0; this.rtcSel = false;
    this.vbk = 0; this.wbk = 0x1000;
    this.lcdc = 0x91; this.stat = 0; this.ly = 0; this.lyc = 0; this.mode = 2;
    this.lcdOn = true; this.dot = 0; this.ppuNext = 80;
    this.p1 = 0x30; this.keys = 0;
    this.sb = 0; this.sc = 0; this.serialCnt = 0;
    this.hdmaActive = false; this.hdmaLeft = 0; this.hdmaSrc = 0; this.hdmaDst = 0;
    // wildWrites counts things a sound driver has no business doing (video
    // memory, OAM, LCD control, reading the joypad): it tells game logic apart.
    this.romWrites = 0; this.wildWrites = 0;
    this.io[0x47] = 0xfc;
    this.apu = new Apu(this.cgb);
    for (const [r, v] of [[0x26, 0x80], [0x24, 0x77], [0x25, 0xf3], [0x11, 0x80], [0x12, 0xf3]]) this.apu.write(0xff00 + r, v, 0);
  }

  save() {
    const s = {};
    for (const k of Object.keys(this)) {
      const v = this[k];
      if (typeof v === 'number' || typeof v === 'boolean') s[k] = v;
      else if (v instanceof Uint8Array && k !== 'rom') s[k] = v.slice();
    }
    s.apuState = this.apu.save();
    return s;
  }
  load(s) {
    for (const k of Object.keys(s)) {
      if (k === 'apuState') continue;
      if (s[k] instanceof Uint8Array) this[k].set(s[k]); else this[k] = s[k];
    }
    this.apu = new Apu(this.cgb);
    this.apu.load(s.apuState);
  }

  // ---- memory -------------------------------------------------------------
  read8(a) {
    if (a < 0x4000) return this.rom[a];
    if (a < 0x8000) return this.rom[this.romOff + a];
    if (a < 0xa000) return this.vram[this.vbk + a - 0x8000];
    if (a < 0xc000) {
      if (!this.ramEn || this.rtcSel) return this.rtcSel ? 0 : 0xff;
      const v = this.cram[(this.cramOff + a - 0xa000) & this.cramMask];
      return this.mbc === 2 ? v | 0xf0 : v;
    }
    if (a < 0xfe00) {
      const i = (a & 0x1000) ? this.wbk + (a & 0xfff) : (a & 0xfff);
      if (this.mt) this.mt.r(i);
      return this.ram[i];
    }
    if (a >= 0xff80) {
      if (a === 0xffff) return this.ie;
      const i = a - 0x7f80;
      if (this.mt) this.mt.r(i);
      return this.ram[i];
    }
    if (a < 0xfea0) return this.oam[a - 0xfe00];
    if (a < 0xff00) return 0xff;
    return this.readIo(a);
  }

  write8(a, v) {
    if (a < 0x8000) { this.romWrites++; this.mbcWrite(a, v); return; }
    if (a < 0xa000) { this.wildWrites++; this.vram[this.vbk + a - 0x8000] = v; return; }
    if (a < 0xc000) {
      if (this.ramEn && !this.rtcSel) this.cram[(this.cramOff + a - 0xa000) & this.cramMask] = v;
      return;
    }
    if (a < 0xfe00) {
      const i = (a & 0x1000) ? this.wbk + (a & 0xfff) : (a & 0xfff);
      this.ram[i] = v;
      if (this.mt) this.mt.w(i, v);
      return;
    }
    if (a >= 0xff80) {
      if (a === 0xffff) { this.ie = v; return; }
      const i = a - 0x7f80;
      this.ram[i] = v;
      if (this.mt) this.mt.w(i, v);
      return;
    }
    if (a < 0xfea0) { this.wildWrites++; this.oam[a - 0xfe00] = v; return; }
    if (a < 0xff00) return;
    this.writeIo(a, v);
  }

  mbcWrite(a, v) {
    switch (this.mbc) {
      case 0: return;
      case 1:
        if (a < 0x2000) this.ramEn = (v & 15) === 10;
        else if (a < 0x4000) this.mbcLo = (v & 0x1f) || 1;
        else if (a < 0x6000) this.mbcHi = v & 3;
        else this.mbcMode = v & 1;
        this.setRomBank((this.mbcHi << 5) | this.mbcLo);
        this.cramOff = this.mbcMode ? this.mbcHi * 0x2000 : 0;
        return;
      case 2:
        if (a < 0x4000) { if (a & 0x100) this.setRomBank((v & 15) || 1); else this.ramEn = (v & 15) === 10; }
        return;
      case 3:
        if (a < 0x2000) this.ramEn = (v & 15) === 10;
        else if (a < 0x4000) this.setRomBank(v || 1);
        else if (a < 0x6000) { this.rtcSel = v >= 8; if (!this.rtcSel) this.cramOff = (v & 7) * 0x2000; }
        return;
      default:
        if (this.gbs) { if (a >= 0x2000 && a < 0x4000) this.setRomBank(v || 1); else if (a < 0x2000) this.ramEn = true; return; }
        if (a < 0x2000) this.ramEn = (v & 15) === 10;
        else if (a < 0x3000) { this.mbcLo = v; this.setRomBank((this.mbcHi << 8) | v); }
        else if (a < 0x4000) { this.mbcHi = v & 1; this.setRomBank((this.mbcHi << 8) | this.mbcLo); }
        else if (a < 0x6000) this.cramOff = (v & 15) * 0x2000;
    }
  }
  setRomBank(n) { this.romOff = ((n & this.bankMask) - 1) * 0x4000; }
  get romBank() { return this.romOff / 0x4000 + 1; }

  readIo(a) {
    if (a >= 0xff10 && a < 0xff40) return this.apu.read(a, this.clock - this.apuBase);
    switch (a) {
      case 0xff00: {
        this.wildWrites++;
        let n = 0x0f;
        if (!(this.p1 & 0x10)) n &= ~this.keys;
        if (!(this.p1 & 0x20)) n &= ~(this.keys >> 4);
        return 0xc0 | this.p1 | (n & 15);
      }
      case 0xff01: return this.sb;
      case 0xff02: return this.sc | 0x7e;
      case 0xff04: return this.div16 >> 8;
      case 0xff05: return this.tima;
      case 0xff06: return this.tma;
      case 0xff07: return this.tac | 0xf8;
      case 0xff0f: return this.ifl | 0xe0;
      case 0xff40: return this.lcdc;
      case 0xff41: return 0x80 | (this.stat & 0x78) | (this.lcdOn && this.ly === this.lyc ? 4 : 0) | (this.lcdOn ? this.mode : 0);
      case 0xff44: return this.ly;
      case 0xff45: return this.lyc;
      case 0xff4d: return this.cgb ? this.key1 | (this.ds ? 0x80 : 0) | 0x7e : 0xff;
      case 0xff4f: return this.cgb ? (this.vbk ? 0xff : 0xfe) : 0xff;
      case 0xff55: return this.cgb ? (this.hdmaActive ? (this.hdmaLeft >> 4) - 1 : 0xff) : 0xff;
      case 0xff70: return this.cgb ? 0xf8 | (this.wbk >> 12) : 0xff;
    }
    if (a >= 0xff4c && !this.cgb) return 0xff;
    return this.io[a - 0xff00];
  }

  writeIo(a, v) {
    if (a >= 0xff10 && a < 0xff40) {
      if (this.onApu) this.onApu(a, v);
      this.apu.write(a, v, this.clock - this.apuBase);
      return;
    }
    switch (a) {
      case 0xff00: this.p1 = v & 0x30; return;
      case 0xff01: this.sb = v; return;
      case 0xff02:
        this.sc = v & 0x83;
        if ((v & 0x81) === 0x81) this.serialCnt = 4096;
        return;
      case 0xff04: this.div16 = 0; return;
      case 0xff05: this.tima = v; return;
      case 0xff06: this.tma = v; return;
      case 0xff07: this.tac = v & 7; return;
      case 0xff0f: this.ifl = v & 0x1f; return;
      case 0xff40: {
        this.wildWrites++;
        const on = (v & 0x80) !== 0;
        if (on !== this.lcdOn) {
          this.lcdOn = on; this.ly = 0; this.dot = 0;
          this.mode = on ? 2 : 0; this.ppuNext = 80;
        }
        this.lcdc = v; return;
      }
      case 0xff41: this.stat = v & 0x78; return;
      case 0xff44: return;
      case 0xff45:
        this.lyc = v;
        if (this.lcdOn && this.ly === v && (this.stat & 0x40)) this.ifl |= 2;
        return;
      case 0xff46: {
        this.wildWrites++;
        const src = v << 8;
        for (let i = 0; i < 0xa0; i++) this.oam[i] = this.read8(src + i);
        this.io[0x46] = v; return;
      }
    }
    if (this.cgb) {
      switch (a) {
        case 0xff4d: this.key1 = v & 1; return;
        case 0xff4f: this.vbk = (v & 1) * 0x2000; return;
        case 0xff55: {
          if (this.hdmaActive && !(v & 0x80)) { this.hdmaActive = false; return; }
          this.hdmaSrc = ((this.io[0x51] << 8) | this.io[0x52]) & 0xfff0;
          this.hdmaDst = 0x8000 | (((this.io[0x53] << 8) | this.io[0x54]) & 0x1ff0);
          this.hdmaLeft = ((v & 0x7f) + 1) * 16;
          if (v & 0x80) this.hdmaActive = true; else this.hdmaCopy(this.hdmaLeft);
          return;
        }
        case 0xff70: this.wbk = ((v & 7) || 1) * 0x1000; return;
      }
    }
    this.io[a - 0xff00] = v;
  }

  hdmaCopy(n) {
    for (let i = 0; i < n; i++) {
      this.vram[this.vbk + ((this.hdmaDst++) & 0x1fff)] = this.read8((this.hdmaSrc++) & 0xffff);
    }
    this.hdmaLeft -= n;
    if (this.hdmaLeft <= 0) this.hdmaActive = false;
  }

  stop() {
    if (this.cgb && (this.key1 & 1)) { this.ds = !this.ds; this.key1 = 0; }
  }

  // ---- timing -------------------------------------------------------------
  advance(d, cyc) {
    this.clock += d;
    const old = this.div16;
    this.div16 = (old + cyc) & 0xffff;
    if (this.tac & 4) {
      const sh = TIMER_SHIFT[this.tac & 3];
      const n = ((old & ((1 << sh) - 1)) + cyc) >> sh;
      if (n) {
        let t = this.tima + n;
        if (t > 255) { this.ifl |= 4; const span = 256 - this.tma; t = this.tma + ((t - 256) % span); }
        this.tima = t;
      }
    }
    if (this.lcdOn) { this.dot += d; if (this.dot >= this.ppuNext) this.ppuEvent(); }
    if (this.serialCnt > 0 && (this.serialCnt -= cyc) <= 0) { this.sb = 0xff; this.sc &= 0x7f; this.ifl |= 8; }
  }

  ppuEvent() {
    while (this.dot >= this.ppuNext) {
      if (this.mode === 2) { this.mode = 3; this.ppuNext = 252; }
      else if (this.mode === 3) {
        this.mode = 0; this.ppuNext = 456;
        if (this.stat & 0x08) this.ifl |= 2;
        if (this.hdmaActive) this.hdmaCopy(16);
      } else {
        this.dot -= 456;
        this.ly++;
        if (this.ly === 144) { this.mode = 1; this.ppuNext = 456; this.ifl |= 1; if (this.stat & 0x10) this.ifl |= 2; }
        else if (this.ly > 153) { this.ly = 0; this.mode = 2; this.ppuNext = 80; if (this.stat & 0x20) this.ifl |= 2; }
        else if (this.ly < 144) { this.mode = 2; this.ppuNext = 80; if (this.stat & 0x20) this.ifl |= 2; }
        else this.ppuNext = 456;
        if (this.ly === this.lyc && (this.stat & 0x40)) this.ifl |= 2;
      }
    }
  }

  // Run the CPU for at least `dots`.
  run(dots) {
    const end = this.clock + dots;
    while (this.clock < end && !this.crashed) {
      const cyc = step(this);
      this.advance(this.ds ? cyc >> 1 : cyc, cyc);
    }
  }

  // Let time pass without running the CPU.
  idle(dots) {
    if (dots > 0) this.advance(dots, this.ds ? dots * 2 : dots);
  }

  // Call a subroutine and run until it returns. False on timeout/crash.
  call(addr, maxDots) {
    const sp = this.sp;
    this.sp = (this.sp - 1) & 0xffff; this.write8(this.sp, SENTINEL >> 8);
    this.sp = (this.sp - 1) & 0xffff; this.write8(this.sp, SENTINEL & 0xff);
    this.pc = addr;
    const end = this.clock + maxDots;
    while (!(this.pc === SENTINEL && this.sp === sp)) {
      if (this.clock >= end || this.crashed) return false;
      const cyc = step(this);
      this.advance(this.ds ? cyc >> 1 : cyc, cyc);
    }
    return true;
  }

  // Close the current audio frame; appends samples when synthesis is on.
  endAudioFrame(outL, outR, at) {
    const n = this.apu.endFrame(this.clock - this.apuBase, outL, outR, at);
    this.apuBase = this.clock;
    return n;
  }
}
