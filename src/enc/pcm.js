// Float PCM -> integer samples, with TPDF dither when reducing to 16 bits.

export function quantize(pcm, bps) {
  const n = pcm.l.length, scale = 2 ** (bps - 1), max = scale - 1, min = -scale;
  const out = [new Int32Array(n), new Int32Array(n)];
  let seed = 0x2545f491;
  const rnd = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) / 4294967296; };
  [pcm.l, pcm.r].forEach((src, c) => {
    const dst = out[c];
    for (let i = 0; i < n; i++) {
      let v = src[i] * scale;
      if (bps === 16) v += rnd() - rnd();
      v = Math.round(v);
      dst[i] = v > max ? max : v < min ? min : v;
    }
  });
  return out;
}

export function safeName(s) {
  return String(s).replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').replace(/^[. ]+|[. ]+$/g, '').slice(0, 120) || 'untitled';
}
