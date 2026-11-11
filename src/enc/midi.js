// Sound-register log -> Standard MIDI File (format 1).
//
// The Game Boy has no notes, only frequencies and volumes, so this is an
// interpretation: a channel trigger becomes a note-on at the nearest pitch,
// silence (volume 0, DAC off, length or envelope running out) becomes a
// note-off, frequency changes inside a note become pitch bend (or a new note
// when they move more than a whole tone). Drivers that shape a note by
// re-triggering it at falling volumes, or by gating the wave channel with its
// volume register, are recognised so one played note stays one MIDI note.
// Pulse 1/2 and wave get MIDI channels 1-3, noise becomes drums on channel 10.

const PPQ = 480, TICKS_PER_SEC = 960; // 120 bpm
const PROGRAM = [80, 80, 38];         // square lead, square lead, synth bass
const NAMES = ['Pulse 1', 'Pulse 2', 'Wave', 'Noise'];
const BASE = [0, 5, 10, 15];          // register index of NRx0 per channel

function vlq(n) {
  const out = [n & 0x7f];
  while ((n >>= 7)) out.unshift((n & 0x7f) | 0x80);
  return out;
}

function chunk(id, bytes) {
  const out = new Uint8Array(8 + bytes.length), dv = new DataView(out.buffer);
  for (let i = 0; i < 4; i++) out[i] = id.charCodeAt(i);
  dv.setUint32(4, bytes.length);
  out.set(bytes, 8);
  return out;
}

function track(events) {
  events.sort((a, b) => a.tick - b.tick || a.order - b.order);
  const bytes = [];
  let last = 0;
  for (const e of events) { bytes.push(...vlq(e.tick - last), ...e.data); last = e.tick; }
  bytes.push(0, 0xff, 0x2f, 0);
  return chunk('MTrk', bytes);
}

const meta = (type, text) => { const b = [...new TextEncoder().encode(text)]; return [0xff, type, ...vlq(b.length), ...b]; };

export function encodeMidi(events, seconds, opts = {}) {
  const tracks = [[], [], [], []];
  let order = 0;
  const put = (ch, t, data) => tracks[ch].push({ tick: Math.max(0, Math.round(t * TICKS_PER_SEC)), order: order++, data });
  const st = [0, 1, 2, 3].map((ch) => ({
    ch, midi: ch === 3 ? 9 : ch, freq: 0, nr2: 0, dac: false, waveVol: 0, len: 0, lenEn: false,
    note: -1, vel: 0, onAt: 0, offAt: Infinity, bend: 8192, noise: 0,
    running: false, runUntil: Infinity, pendAt: -1, trig: false, gate: false, tune: false,
  }));
  const pitch = (c) => {
    const hz = (c.ch === 2 ? 65536 : 131072) / (2048 - c.freq);
    return 69 + 12 * Math.log2(hz / 440);
  };
  const setBend = (c, t, v) => { if (v !== c.bend) { c.bend = v; put(c.ch, t, [0xe0 | c.midi, v & 0x7f, v >> 7]); } };
  const off = (c, t) => {
    if (c.note < 0) return;
    put(c.ch, Math.max(t, c.onAt + 1 / TICKS_PER_SEC), [0x80 | c.midi, c.note, 0]);
    c.note = -1; c.offAt = Infinity;
  };
  const velocity = (c) => (c.ch === 2 ? [0, 127, 80, 50][c.waveVol] : Math.round((c.nr2 >> 4) / 15 * 127));
  const bendFor = (dev) => Math.max(0, Math.min(16383, 8192 + Math.round(dev / 2 * 8191)));
  const lifetime = (c, t) => {
    let dur = c.runUntil - t;
    if (c.ch !== 2) {
      const per = c.nr2 & 7, up = c.nr2 & 8;
      if (per && !up) dur = Math.min(dur, (c.nr2 >> 4) * per / 64);
    }
    if (c.ch === 3) dur = Math.min(dur, 0.25);
    return t + dur;
  };
  const on = (c, t) => {
    let note;
    if (c.ch === 3) {
      const shift = c.noise >> 4;
      note = shift <= 2 ? 42 : shift <= 5 ? 38 : 36; // hi-hat / snare / kick by noise pitch
    } else {
      const p = pitch(c);
      note = Math.max(0, Math.min(127, Math.round(p)));
      const dev = p - note;
      setBend(c, t, Math.abs(dev) > 0.2 ? bendFor(dev) : 8192);
    }
    c.note = note; c.onAt = t; c.vel = velocity(c);
    put(c.ch, t, [0x90 | c.midi, note, Math.max(1, c.vel)]);
    c.offAt = lifetime(c, t);
  };
  const retune = (c, t) => {
    if (c.note < 0 || c.ch === 3) return;
    const dev = pitch(c) - c.note;
    if (Math.abs(dev) <= 2) setBend(c, t, bendFor(dev));
    else { const keep = c.offAt; off(c, t); on(c, t); c.offAt = Math.min(c.offAt, keep); }
  };
  const audible = (c, t) => c.running && t < c.runUntil && c.dac
    && (c.ch === 2 ? c.waveVol > 0 : (c.nr2 >> 4) > 0 || (c.nr2 & 8) !== 0);
  // A driver updates a channel with a burst of writes (volume, frequency low,
  // frequency high + trigger). Decide what the burst meant once it is over.
  const resolve = (c) => {
    const t = c.pendAt;
    if (t < 0) return;
    if (c.trig || c.gate) {
      if (!audible(c, t)) off(c, t);
      else {
        const same = c.note >= 0 && (c.ch === 3 || Math.abs(pitch(c) - c.note) < 0.5);
        if (same && velocity(c) < c.vel) { c.vel = velocity(c); c.offAt = lifetime(c, t); } // decay step, same note
        else { off(c, t); on(c, t); }
      }
    } else if (c.tune) retune(c, t);
    c.pendAt = -1; c.trig = c.gate = c.tune = false;
  };
  const mark = (c, t, what) => { if (c.pendAt < 0) c.pendAt = t; c[what] = true; };

  for (const e of events) {
    const t = Math.min(e.t, seconds);
    for (const c of st) {
      if (c.pendAt >= 0 && t > c.pendAt + 0.004) resolve(c);
      if (c.offAt <= t) off(c, c.offAt);
    }
    const r = e.reg - 0xff10, v = e.val;
    if (r === 0x16) { if (!(v & 0x80)) for (const c of st) { resolve(c); c.running = false; off(c, t); } continue; }
    if (r === 0x15) {
      for (const c of st) {
        const l = (v >> (4 + c.ch)) & 1, rr = (v >> c.ch) & 1;
        if (!l && !rr) { resolve(c); off(c, t); }
        else if (c.ch !== 3) put(c.ch, t, [0xb0 | c.midi, 10, l && rr ? 64 : l ? 16 : 112]);
      }
      continue;
    }
    if (r > 0x13) continue;
    const ch = r >= 15 ? 3 : r >= 10 ? 2 : r >= 5 ? 1 : 0, c = st[ch], idx = r - BASE[ch];
    switch (idx) {
      case 0: if (ch === 2) { c.dac = (v & 0x80) !== 0; if (!c.dac) { c.running = false; mark(c, t, 'gate'); } } break;
      case 1: c.len = ch === 2 ? 256 - v : 64 - (v & 63); break;
      case 2:
        if (ch === 2) {
          const vol = (v >> 5) & 3, louder = vol && (!c.waveVol || [0, 3, 2, 1][vol] > [0, 3, 2, 1][c.waveVol]);
          c.waveVol = vol;
          if (!vol || louder || c.note < 0) mark(c, t, 'gate'); else { c.vel = velocity(c); }
        } else { c.nr2 = v; c.dac = (v & 0xf8) !== 0; if (!c.dac) { c.running = false; mark(c, t, 'gate'); } }
        break;
      case 3:
        if (ch === 3) c.noise = v; else { c.freq = (c.freq & 0x700) | v; mark(c, t, 'tune'); }
        break;
      default:
        if (ch !== 3) { c.freq = (c.freq & 0xff) | ((v & 7) << 8); mark(c, t, 'tune'); }
        c.lenEn = (v & 0x40) !== 0;
        if (v & 0x80) {
          c.running = c.dac;
          c.runUntil = c.lenEn ? t + c.len / 256 : Infinity;
          mark(c, t, 'trig');
        }
    }
  }
  for (const c of st) { resolve(c); off(c, Math.min(c.offAt, seconds)); }

  const end = Math.round(seconds * TICKS_PER_SEC);
  const conductor = [
    { tick: 0, order: 0, data: meta(0x03, opts.title || 'Game Boy') },
    { tick: 0, order: 1, data: [0xff, 0x51, 3, 0x07, 0xa1, 0x20] },
    { tick: 0, order: 2, data: [0xff, 0x58, 4, 4, 2, 24, 8] },
  ];
  if (opts.comment) conductor.push({ tick: 0, order: 3, data: meta(0x01, opts.comment) });
  if (opts.loopStartSec >= 0) {
    conductor.push({ tick: Math.round(opts.loopStartSec * TICKS_PER_SEC), order: 4, data: meta(0x06, 'loopStart') });
    conductor.push({ tick: end, order: 5, data: meta(0x06, 'loopEnd') });
  }
  conductor.push({ tick: end, order: 6, data: meta(0x01, '') });
  const chunks = [track(conductor)];
  st.forEach((c) => {
    const ev = tracks[c.ch];
    if (!ev.some((e) => (e.data[0] & 0xf0) === 0x90)) return;
    ev.push({ tick: 0, order: -2, data: meta(0x03, NAMES[c.ch]) });
    if (c.ch !== 3) ev.push({ tick: 0, order: -1, data: [0xc0 | c.midi, PROGRAM[c.ch]] });
    chunks.push(track(ev));
  });
  const head = chunk('MThd', [0, 1, 0, chunks.length, PPQ >> 8, PPQ & 0xff]);
  const out = new Uint8Array(head.length + chunks.reduce((n, c) => n + c.length, 0));
  let o = 0;
  for (const c of [head, ...chunks]) { out.set(c, o); o += c.length; }
  return out;
}
