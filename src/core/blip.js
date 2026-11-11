// Band-limited step synthesis (in the spirit of Blargg's blip_buf).
// Amplitude changes ("deltas") arrive at clock-resolution timestamps; each one
// is added as a windowed-sinc band-limited impulse, and integrating the result
// yields alias-free output at the target sample rate.

const TAPS = 64;
const PHASES = 256;
const kernelCache = new Map();

function besselI0(x) {
  let sum = 1, term = 1;
  for (let k = 1; k < 40; k++) { term *= (x / (2 * k)) ** 2; sum += term; if (term < 1e-12 * sum) break; }
  return sum;
}

function makeKernel(cutoff) {
  const key = cutoff.toFixed(5);
  if (kernelCache.has(key)) return kernelCache.get(key);
  const rows = new Float64Array((PHASES + 1) * TAPS);
  const beta = 9.0, half = TAPS / 2, i0b = besselI0(beta);
  for (let p = 0; p <= PHASES; p++) {
    const frac = p / PHASES;
    let sum = 0;
    for (let j = 0; j < TAPS; j++) {
      const x = j - half + 1 - frac;
      const w = Math.abs(x) >= half ? 0 : besselI0(beta * Math.sqrt(1 - (x / half) ** 2)) / i0b;
      const s = x === 0 ? 1 : Math.sin(Math.PI * cutoff * x) / (Math.PI * cutoff * x);
      const v = cutoff * s * w;
      rows[p * TAPS + j] = v; sum += v;
    }
    for (let j = 0; j < TAPS; j++) rows[p * TAPS + j] /= sum; // unity DC gain per phase
  }
  kernelCache.set(key, rows);
  return rows;
}

export class Blip {
  constructor(sampleRate, clockRate) {
    this.sampleRate = sampleRate;
    this.factor = sampleRate / clockRate;
    // Pass everything up to ~20 kHz (or 0.9 Nyquist), stop by Nyquist.
    this.kernel = makeKernel(Math.min(0.94, 2 * 21500 / sampleRate));
    this.size = 8192;
    this.l = new Float64Array(this.size);
    this.r = new Float64Array(this.size);
    this.offset = 0;   // fractional sample position of clock time 0
    this.avail = 0;    // complete samples ready to read
    this.accL = 0; this.accR = 0;
  }

  static get latency() { return TAPS / 2 - 1; }

  ensure(n) {
    if (n <= this.size) return;
    let s = this.size; while (s < n) s *= 2;
    const l = new Float64Array(s), r = new Float64Array(s);
    l.set(this.l); r.set(this.r);
    this.l = l; this.r = r; this.size = s;
  }

  add(t, dl, dr) {
    const pos = this.offset + t * this.factor;
    const i = Math.floor(pos);
    const ph = (pos - i) * PHASES;
    const p0 = Math.floor(ph), w = ph - p0;
    if (i + TAPS > this.size) this.ensure(i + TAPS + 1024);
    const k = this.kernel, l = this.l, r = this.r;
    let a = p0 * TAPS, b = a + TAPS;
    for (let j = 0; j < TAPS; j++, a++, b++) {
      const v = k[a] + (k[b] - k[a]) * w;
      l[i + j] += v * dl; r[i + j] += v * dr;
    }
  }

  // Mark clock time t as the end of the current frame; time restarts at 0.
  endFrame(t) {
    const pos = this.offset + t * this.factor;
    this.avail = Math.floor(pos);
    this.offset = pos - this.avail;
    if (this.avail + TAPS > this.size) this.ensure(this.avail + TAPS + 1024);
  }

  // Integrate and remove all available samples into outL/outR at `at`.
  read(outL, outR, at) {
    const n = this.avail, l = this.l, r = this.r;
    let aL = this.accL, aR = this.accR;
    for (let i = 0; i < n; i++) { aL += l[i]; aR += r[i]; outL[at + i] = aL; outR[at + i] = aR; }
    this.accL = aL; this.accR = aR;
    l.copyWithin(0, n, n + TAPS); r.copyWithin(0, n, n + TAPS);
    l.fill(0, TAPS, n + TAPS); r.fill(0, TAPS, n + TAPS);
    this.avail = 0;
    return n;
  }
}
