// All heavy work (emulation, analysis, encoding) runs here, off the UI thread.

import { openSource, renderTrack, trackPlan } from './rip/pipeline.js';
import { exportTrack, albumFolder, playlist } from './rip/export.js';
import { makeZip } from './enc/zip.js';

let session = null;
const post = (m, transfer) => self.postMessage(m, transfer || []);
const progress = (value, label, params) => post({ type: 'progress', value, label, params });

function describe(t) {
  const tps = session.player.tps;
  const { plan } = trackPlan(session, t, { loops: 1, fadeSec: 0, maxSec: 1e9 });
  return {
    id: t.id, kind: t.kind, dubious: t.dubious, looping: t.info.looping,
    introSec: t.introSec, loopSec: t.loopSec, endSec: t.info.endTick / tps, skipSec: plan.skipTicks / tps,
  };
}

const handlers = {
  open({ bytes }) {
    session = null;
    session = openSource(new Uint8Array(bytes), (key, params) => post({ type: 'log', key, params }), (v) => progress(v, 'p.analyze'));
    post({ type: 'opened', meta: session.meta, method: session.method, tracks: session.tracks.map(describe) });
  },
  preview({ index, opts }) {
    const pcm = renderTrack(session, session.tracks[index], { ...opts, sampleRate: 44100, maxSec: Math.min(opts.maxSec, 120) });
    const l = pcm.l.slice(), r = pcm.r.slice();
    post({ type: 'preview', index, l, r, sampleRate: 44100 }, [l.buffer, r.buffer]);
  },
  export({ tracks, album, opts, single }) {
    const files = [], entries = [];
    const folder = albumFolder(album);
    tracks.forEach((sel, k) => {
      const params = { k: k + 1, n: tracks.length, title: sel.title };
      progress(k / tracks.length, 'p.render', params);
      const f = exportTrack(session, sel, album, opts, (p) => progress((k + p * 0.7) / tracks.length, 'p.render', params));
      files.push({ name: `${folder}/${f.name}`, data: f.data });
      entries.push({ name: f.name, title: sel.title, seconds: f.seconds });
    });
    progress(1, 'p.pack');
    if (single) {
      const f = files[0];
      post({ type: 'exported', name: f.name.split('/').pop(), blob: new Blob([f.data], { type: { wav: 'audio/wav', flac: 'audio/flac', mid: 'audio/midi', vgm: 'application/octet-stream' }[opts.format] }) });
      return;
    }
    files.push({ name: `${folder}/${folder}.m3u8`, data: new TextEncoder().encode(playlist(entries)) });
    post({ type: 'exported', name: `${folder}.zip`, blob: new Blob(makeZip(files), { type: 'application/zip' }) });
  },
};

self.onmessage = (e) => {
  try { handlers[e.data.type](e.data); }
  catch (err) { post({ type: 'error', message: err && err.message ? err.message : String(err), during: e.data.type }); }
};
