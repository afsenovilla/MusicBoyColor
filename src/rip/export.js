// Turning rendered tracks into tagged, well-named files.

import { renderTrack, trackPlan } from './pipeline.js';
import { quantize, safeName } from '../enc/pcm.js';
import { encodeFlac } from '../enc/flac.js';
import { encodeWav } from '../enc/wav.js';
import { encodeMidi } from '../enc/midi.js';
import { encodeVgm } from '../enc/vgm.js';
import { capture, dataTicks } from './capture.js';
import { planFor } from './player.js';

// sel: { index, title, number }, album: { album, artist, year, genre, total }
export function exportTrack(session, sel, album, opts, onProgress) {
  const track = session.tracks[sel.index];
  const width = Math.max(2, String(album.total).length);
  const base = `${String(sel.number).padStart(width, '0')} - ${safeName(sel.title)}`;
  const note = `${album.comment || 'Ripped with MusicBoyColor'} (song #${track.id})`;
  if (opts.format === 'mid' || opts.format === 'vgm') {
    // Data formats: the register log itself. MIDI plays the loop as many times
    // as requested; VGM stores it once together with its loop point.
    const player = session.player, info = track.info;
    const { skipTicks } = planFor(player, info, opts);
    const ticks = dataTicks(player, info, opts.format === 'mid' ? opts.loops : 1);
    const cap = capture(player, track.id, ticks, skipTicks);
    if (!cap) throw new Error('err.render');
    if (onProgress) onProgress(1);
    const loopStartSec = info.looping ? Math.max(0, info.loopStart - skipTicks) / player.tps : -1;
    const data = opts.format === 'mid'
      ? encodeMidi(cap.events, cap.seconds, { title: sel.title, comment: note, loopStartSec })
      : encodeVgm(cap.events, cap.seconds, loopStartSec, { title: sel.title, album: album.album, artist: album.artist, year: album.year, comment: note, system: session.meta.system });
    return { name: `${base}.${opts.format}`, data, seconds: cap.seconds };
  }
  const pcm = renderTrack(session, track, opts, onProgress);
  const [l, r] = quantize(pcm, opts.bps);
  const tags = [
    ['TITLE', sel.title], ['ARTIST', album.artist], ['ALBUMARTIST', album.artist], ['ALBUM', album.album],
    ['TRACKNUMBER', sel.number], ['TRACKTOTAL', album.total], ['DATE', album.year], ['GENRE', album.genre],
    ['COMMENT', note],
  ];
  if (track.info.looping) {
    const { plan } = trackPlan(session, track, opts);
    const per = session.player.tickDots * opts.sampleRate / 4194304;
    tags.push(['LOOPSTART', Math.max(0, Math.round((track.info.loopStart - plan.skipTicks) * per))]);
    tags.push(['LOOPLENGTH', Math.round(track.info.loopLen * per)]);
  }
  const ext = opts.format === 'wav' ? 'wav' : 'flac';
  const data = ext === 'wav' ? encodeWav(l, r, opts.sampleRate, opts.bps, tags) : encodeFlac(l, r, opts.sampleRate, opts.bps, tags);
  const name = `${base}.${ext}`;
  return { name, data, seconds: l.length / opts.sampleRate };
}

export function albumFolder(album) {
  return safeName(album.year ? `${album.album} (${album.year})` : album.album);
}

export function playlist(entries) {
  return '#EXTM3U\n' + entries.map((e) => `#EXTINF:${Math.round(e.seconds)},${e.title}\n${e.name}\n`).join('');
}
