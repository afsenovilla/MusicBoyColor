// From file bytes to a list of playable, described tracks.

import { isGbs, looksLikeRom, parseRomHeader } from '../meta/header.js';
import { loadGbs } from './gbs.js';
import { scanRom } from './scan.js';
import { Player, analyze, render, planFor, planSeconds } from './player.js';

const LISTEN_SEC = 300; // how long to follow one song looking for its loop

// Play every id and keep the ones that are distinct pieces of music.
export function enumerate(gb, cfg, ids, progress = () => {}, strict = false) {
  const player = new Player(gb, cfg);
  const driver = cfg.kind === 'call' || cfg.kind === 'poke';
  const tracks = [], seen = new Set();
  let skip = null;
  if (driver) {
    // What we hear when the id is ignored: the old song carrying on. Not a track.
    skip = analyze(player, 0, { maxSec: LISTEN_SEC, detect: true, skip: true });
  }
  if (driver && cfg.pre === undefined) {
    // Look for an id that stops the music. Starting every song from silence
    // lets jingles and effects be heard alone instead of over the old song.
    for (const id of ids) {
      const q = analyze(player, id, { maxSec: 3 });
      if (q.ok && q.notes === 0 && q.lastAudible < player.tps && q.fp !== skip.fp) { cfg.pre = id; break; }
    }
  }
  if (cfg.pre !== undefined) skip = null;
  // An id that only plays a sound effect leaves the old song running underneath:
  // tick for tick the same register writes as the "ignored" run once the effect
  // is over. A real song change (even to the same song) shifts the timeline.
  const carriesOn = (info) => {
    if (!skip) return false;
    if (info.fp === skip.fp) return true;
    const n = Math.min(info.wh.length, skip.wh.length), from = Math.round(player.tps * 4);
    if (n - from < player.tps * 4) return false;
    let same = 0, active = 0;
    for (let i = from; i < n; i++) { if (skip.wh[i] === info.wh[i]) same++; }
    for (let i = from + 1; i < n; i++) if (skip.wh[i] !== skip.wh[i - 1]) active++;
    return active > (n - from) * 0.05 && same >= (n - from) * 0.8;
  };
  let rejected = false;
  ids.forEach((id, k) => {
    if (rejected) return;
    progress(k / ids.length);
    if (strict) {
      // A candidate selector that keeps producing open-ended noise is not one;
      // stop early instead of listening to 256 of those.
      const long = tracks.filter((t) => t.kind !== 'sfx');
      if (long.length >= 12 && long.filter((t) => t.info.looping).length < long.length * 0.3) { rejected = true; return; }
    }
    if (driver) {
      const quick = analyze(player, id, { maxSec: 3 });
      if (!quick.ok || quick.notes < 3) return;
    }
    const info = analyze(player, id, { maxSec: cfg.kind === 'full' ? 240 : LISTEN_SEC, detect: true });
    if (!info.ok || carriesOn(info)) return;
    const key = info.looping ? `L${info.loopSig}` : `E${info.fp}:${info.endTick}`;
    if (seen.has(key)) return;
    seen.add(key);
    const sec = info.looping ? info.loopLen / player.tps : info.endTick / player.tps;
    tracks.push({
      id, info,
      kind: info.looping ? 'loop' : info.unresolved ? 'open' : sec < 3 ? 'sfx' : 'once',
      loopSec: info.looping ? info.loopLen / player.tps : 0,
      introSec: info.looping ? info.loopStart / player.tps : 0,
      dubious: info.dubious,
    });
  });
  progress(1);
  return rejected ? [] : tracks;
}

export function openSource(bytes, log = () => {}, progress = () => {}) {
  let src, meta, tracks;
  if (isGbs(bytes)) {
    src = loadGbs(bytes);
    meta = src.meta;
    log('log.gbs', { n: meta.songs });
  } else {
    if (bytes.length < 0x8000) throw new Error('err.notRom');
    if (!looksLikeRom(bytes)) log('log.badHeader');
    meta = parseRomHeader(bytes);
    src = scanRom(bytes, (gb, cfg, ids) => enumerate(gb, cfg, ids, undefined, true), log, (f) => progress(f * 0.9));
    if (!src.ok) throw new Error(src.error);
    tracks = src.tracks;
  }
  if (!tracks) {
    log('log.analyze');
    const base = meta.type === 'gbs' ? 0 : 0.9;
    tracks = enumerate(src.gb, src.cfg, src.ids, (f) => progress(base + (1 - base) * f));
  }
  progress(1);
  log('log.found', { n: tracks.length });
  return { meta, player: new Player(src.gb, src.cfg), tracks, method: src.cfg.kind };
}

export function trackPlan(session, track, opts) {
  const plan = planFor(session.player, track.info, opts);
  return { plan, seconds: planSeconds(session.player, plan) };
}

export function renderTrack(session, track, opts, onProgress) {
  const { plan } = trackPlan(session, track, opts);
  const pcm = render(session.player, track.id, plan, opts.sampleRate, onProgress);
  if (!pcm) throw new Error('err.render');
  let peak = 0;
  for (let i = 0; i < pcm.l.length; i++) {
    const a = Math.abs(pcm.l[i]), b = Math.abs(pcm.r[i]);
    if (a > peak) peak = a; if (b > peak) peak = b;
  }
  // Never clip: a track that would exceed full scale is turned down as a whole.
  const target = 0.944; // -0.5 dBFS
  if (peak > 1e-4 && (opts.normalize || peak > target)) {
    const g = target / peak;
    for (let i = 0; i < pcm.l.length; i++) { pcm.l[i] *= g; pcm.r[i] *= g; }
  }
  return pcm;
}
