// SM83 (Game Boy CPU) interpreter. Operates on a GameBoy instance `g` that
// exposes registers (a,f,b,c,d,e,h,l,sp,pc), read8/write8 and interrupt state.
// step() executes one instruction (or an interrupt dispatch) and returns the
// number of CPU T-cycles consumed.

const Z = 0x80, N = 0x40, H = 0x20, C = 0x10;

function getR(g, i) {
  switch (i) {
    case 0: return g.b; case 1: return g.c; case 2: return g.d; case 3: return g.e;
    case 4: return g.h; case 5: return g.l; case 6: return g.read8((g.h << 8) | g.l);
    default: return g.a;
  }
}
function setR(g, i, v) {
  switch (i) {
    case 0: g.b = v; break; case 1: g.c = v; break; case 2: g.d = v; break; case 3: g.e = v; break;
    case 4: g.h = v; break; case 5: g.l = v; break; case 6: g.write8((g.h << 8) | g.l, v); break;
    default: g.a = v;
  }
}
function getRP(g, p) {
  switch (p) {
    case 0: return (g.b << 8) | g.c; case 1: return (g.d << 8) | g.e;
    case 2: return (g.h << 8) | g.l; default: return g.sp;
  }
}
function setRP(g, p, v) {
  switch (p) {
    case 0: g.b = v >> 8; g.c = v & 0xff; break;
    case 1: g.d = v >> 8; g.e = v & 0xff; break;
    case 2: g.h = v >> 8; g.l = v & 0xff; break;
    default: g.sp = v;
  }
}
function push16(g, v) {
  g.sp = (g.sp - 1) & 0xffff; g.write8(g.sp, v >> 8);
  g.sp = (g.sp - 1) & 0xffff; g.write8(g.sp, v & 0xff);
}
function pop16(g) {
  const lo = g.read8(g.sp); g.sp = (g.sp + 1) & 0xffff;
  const hi = g.read8(g.sp); g.sp = (g.sp + 1) & 0xffff;
  return (hi << 8) | lo;
}
function imm8(g) { const v = g.read8(g.pc); g.pc = (g.pc + 1) & 0xffff; return v; }
function imm16(g) { const lo = imm8(g); return (imm8(g) << 8) | lo; }
function cond(g, y) {
  switch (y) {
    case 0: return !(g.f & Z); case 1: return (g.f & Z) !== 0;
    case 2: return !(g.f & C); default: return (g.f & C) !== 0;
  }
}
function alu(g, y, v) {
  const a = g.a;
  let r;
  switch (y) {
    case 0: r = a + v; g.f = ((r & 0xff) ? 0 : Z) | (((a & 15) + (v & 15)) > 15 ? H : 0) | (r > 255 ? C : 0); g.a = r & 0xff; break;
    case 1: { const c = (g.f >> 4) & 1; r = a + v + c; g.f = ((r & 0xff) ? 0 : Z) | (((a & 15) + (v & 15) + c) > 15 ? H : 0) | (r > 255 ? C : 0); g.a = r & 0xff; break; }
    case 2: r = a - v; g.f = ((r & 0xff) ? 0 : Z) | N | ((a & 15) < (v & 15) ? H : 0) | (r < 0 ? C : 0); g.a = r & 0xff; break;
    case 3: { const c = (g.f >> 4) & 1; r = a - v - c; g.f = ((r & 0xff) ? 0 : Z) | N | ((a & 15) < (v & 15) + c ? H : 0) | (r < 0 ? C : 0); g.a = r & 0xff; break; }
    case 4: g.a = a & v; g.f = (g.a ? 0 : Z) | H; break;
    case 5: g.a = a ^ v; g.f = g.a ? 0 : Z; break;
    case 6: g.a = a | v; g.f = g.a ? 0 : Z; break;
    default: r = a - v; g.f = ((r & 0xff) ? 0 : Z) | N | ((a & 15) < (v & 15) ? H : 0) | (r < 0 ? C : 0);
  }
}

function cb(g) {
  const op = imm8(g);
  const x = op >> 6, y = (op >> 3) & 7, z = op & 7;
  let v = getR(g, z);
  if (x === 1) { // BIT
    g.f = (g.f & C) | H | ((v >> y) & 1 ? 0 : Z);
    return z === 6 ? 12 : 8;
  }
  if (x === 2) v &= ~(1 << y);
  else if (x === 3) v |= 1 << y;
  else {
    let c;
    switch (y) {
      case 0: c = v >> 7; v = ((v << 1) | c) & 0xff; break;                     // RLC
      case 1: c = v & 1; v = (v >> 1) | (c << 7); break;                        // RRC
      case 2: c = v >> 7; v = ((v << 1) | ((g.f >> 4) & 1)) & 0xff; break;      // RL
      case 3: c = v & 1; v = (v >> 1) | ((g.f << 3) & 0x80); break;             // RR
      case 4: c = v >> 7; v = (v << 1) & 0xff; break;                           // SLA
      case 5: c = v & 1; v = (v >> 1) | (v & 0x80); break;                      // SRA
      case 6: c = 0; v = ((v << 4) | (v >> 4)) & 0xff; break;                   // SWAP
      default: c = v & 1; v >>= 1;                                              // SRL
    }
    g.f = (v ? 0 : Z) | (c ? C : 0);
  }
  setR(g, z, v);
  return z === 6 ? 16 : 8;
}

export function step(g) {
  if (!g.noInt) {
    const pend = g.ie & g.ifl & 0x1f;
    if (pend) {
      g.halted = false;
      if (g.ime) {
        let bit = 0;
        while (!((pend >> bit) & 1)) bit++;
        g.ifl &= ~(1 << bit);
        g.ime = false;
        push16(g, g.pc);
        g.pc = 0x40 + bit * 8;
        if (g.tr) g.tr.call(g.pc, true);
        return 20;
      }
    }
    if (g.halted) return 4;
  }
  const ei = g.eiPending;
  g.eiPending = false;
  const op = imm8(g);
  let cyc = exec(g, op);
  if (ei && op !== 0xf3) g.ime = true;
  return cyc;
}

function exec(g, op) {
  const x = op >> 6, y = (op >> 3) & 7, z = op & 7;
  if (x === 1) {
    if (op === 0x76) { if (!g.noInt) g.halted = true; return 4; }
    setR(g, y, getR(g, z));
    return (y === 6 || z === 6) ? 8 : 4;
  }
  if (x === 2) { alu(g, y, getR(g, z)); return z === 6 ? 8 : 4; }
  const p = y >> 1, q = y & 1;
  if (x === 0) {
    switch (z) {
      case 0:
        if (y === 0) return 4;
        if (y === 1) { const a = imm16(g); g.write8(a, g.sp & 0xff); g.write8((a + 1) & 0xffff, g.sp >> 8); return 20; }
        if (y === 2) { g.pc = (g.pc + 1) & 0xffff; g.stop(); return 4; }
        { const d = (imm8(g) << 24) >> 24;
          if (y === 3 || cond(g, y - 4)) { g.pc = (g.pc + d) & 0xffff; return 12; }
          return 8; }
      case 1:
        if (q === 0) { setRP(g, p, imm16(g)); return 12; }
        { const hl = (g.h << 8) | g.l, v = getRP(g, p), r = hl + v;
          g.f = (g.f & Z) | (((hl & 0xfff) + (v & 0xfff)) > 0xfff ? H : 0) | (r > 0xffff ? C : 0);
          g.h = (r >> 8) & 0xff; g.l = r & 0xff; return 8; }
      case 2: {
        let a;
        if (p === 0) a = (g.b << 8) | g.c; else if (p === 1) a = (g.d << 8) | g.e;
        else {
          a = (g.h << 8) | g.l;
          const n = (a + (p === 2 ? 1 : 0xffff)) & 0xffff;
          g.h = n >> 8; g.l = n & 0xff;
        }
        if (q === 0) g.write8(a, g.a); else g.a = g.read8(a);
        return 8;
      }
      case 3: setRP(g, p, (getRP(g, p) + (q ? 0xffff : 1)) & 0xffff); return 8;
      case 4: { const v = (getR(g, y) + 1) & 0xff; setR(g, y, v);
        g.f = (g.f & C) | (v ? 0 : Z) | ((v & 15) ? 0 : H); return y === 6 ? 12 : 4; }
      case 5: { const v = (getR(g, y) - 1) & 0xff; setR(g, y, v);
        g.f = (g.f & C) | N | (v ? 0 : Z) | ((v & 15) === 15 ? H : 0); return y === 6 ? 12 : 4; }
      case 6: setR(g, y, imm8(g)); return y === 6 ? 12 : 8;
      default: {
        let a = g.a, c;
        switch (y) {
          case 0: c = a >> 7; g.a = ((a << 1) | c) & 0xff; g.f = c ? C : 0; break;
          case 1: c = a & 1; g.a = (a >> 1) | (c << 7); g.f = c ? C : 0; break;
          case 2: c = a >> 7; g.a = ((a << 1) | ((g.f >> 4) & 1)) & 0xff; g.f = c ? C : 0; break;
          case 3: c = a & 1; g.a = (a >> 1) | ((g.f << 3) & 0x80); g.f = c ? C : 0; break;
          case 4: { // DAA
            let f = g.f;
            if (f & N) { if (f & C) a -= 0x60; if (f & H) a -= 6; }
            else { if ((f & C) || a > 0x99) { a += 0x60; f |= C; } if ((f & H) || (a & 15) > 9) a += 6; }
            a &= 0xff; g.a = a; g.f = (f & (N | C)) | (a ? 0 : Z); break;
          }
          case 5: g.a = a ^ 0xff; g.f |= N | H; break;
          case 6: g.f = (g.f & Z) | C; break;
          default: g.f = (g.f & (Z | C)) ^ C;
        }
        return 4;
      }
    }
  }
  // x === 3
  switch (z) {
    case 0:
      if (y < 4) { if (cond(g, y)) { g.pc = pop16(g); if (g.tr) g.tr.ret(); return 20; } return 8; }
      if (y === 4) { g.write8(0xff00 | imm8(g), g.a); return 12; }
      if (y === 6) { g.a = g.read8(0xff00 | imm8(g)); return 12; }
      { const d = (imm8(g) << 24) >> 24, sp = g.sp, r = (sp + d) & 0xffff;
        g.f = (((sp & 15) + (d & 15)) > 15 ? H : 0) | (((sp & 255) + (d & 255)) > 255 ? C : 0);
        if (y === 5) { g.sp = r; return 16; }
        g.h = r >> 8; g.l = r & 0xff; return 12; }
    case 1:
      if (q === 0) {
        const v = pop16(g);
        if (p === 3) { g.a = v >> 8; g.f = v & 0xf0; } else setRP(g, p, v);
        return 12;
      }
      if (p === 0) { g.pc = pop16(g); if (g.tr) g.tr.ret(); return 16; }
      if (p === 1) { g.pc = pop16(g); g.ime = true; if (g.tr) g.tr.ret(); return 16; }
      if (p === 2) { g.pc = (g.h << 8) | g.l; return 4; }
      g.sp = (g.h << 8) | g.l; return 8;
    case 2:
      if (y < 4) { const a = imm16(g); if (cond(g, y)) { g.pc = a; return 16; } return 12; }
      if (y === 4) { g.write8(0xff00 | g.c, g.a); return 8; }
      if (y === 5) { g.write8(imm16(g), g.a); return 16; }
      if (y === 6) { g.a = g.read8(0xff00 | g.c); return 8; }
      g.a = g.read8(imm16(g)); return 16;
    case 3:
      if (y === 0) { g.pc = imm16(g); return 16; }
      if (y === 1) return cb(g);
      if (y === 6) { g.ime = false; g.eiPending = false; return 4; }
      if (y === 7) { g.eiPending = true; return 4; }
      break;
    case 4:
      if (y < 4) {
        const a = imm16(g);
        if (cond(g, y)) { push16(g, g.pc); g.pc = a; if (g.tr) g.tr.call(a, false); return 24; }
        return 12;
      }
      break;
    case 5:
      if (q === 0) { push16(g, p === 3 ? ((g.a << 8) | g.f) : getRP(g, p)); return 16; }
      if (p === 0) { const a = imm16(g); push16(g, g.pc); g.pc = a; if (g.tr) g.tr.call(a, false); return 24; }
      break;
    case 6: alu(g, y, imm8(g)); return 8;
    default: push16(g, g.pc); g.pc = y * 8; if (g.tr) g.tr.call(g.pc, false); return 16;
  }
  g.crashed = true; // invalid opcode: real hardware locks up
  return 4;
}
