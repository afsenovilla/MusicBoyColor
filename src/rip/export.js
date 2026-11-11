// Turning rendered tracks into tagged, well-named files.

import { renderTrack, trackPlan } from './pipeline.js';
import { quantize, safeName } from '../enc/pcm.js';
import { encodeFlac } from '../enc/flac.js';
import { encodeWav } from '../enc/wav.js';

// sel: { index, title, number }, album: { album, artist, year, genre, total }
export function exportTrack(session, sel, album, opts, onProgress) {
  const track = session.tracks[sel.index];
  const pcm = renderTrack(session, track, opts, onProgress);
  const [l, r] = quantize(pcm, opts.bps);
  const tags = [
    ['TITLE', sel.title], ['ARTIST', album.artist], ['ALBUMARTIST', album.artist], ['ALBUM', album.album],
    ['TRACKNUMBER', sel.number], ['TRACKTOTAL', album.total], ['DATE', album.year], ['GENRE', album.genre],
    ['COMMENT', `${album.comment || 'Ripped with MusicBoyColor'} (song #${track.id})`],
  ];
  if (track.info.looping) {
    const { plan } = trackPlan(session, track, opts);
    const per = session.player.tickDots * opts.sampleRate / 4194304;
    tags.push(['LOOPSTART', Math.max(0, Math.round((track.info.loopStart - plan.skipTicks) * per))]);
    tags.push(['LOOPLENGTH', Math.round(track.info.loopLen * per)]);
  }
  const ext = opts.format === 'wav' ? 'wav' : 'flac';
  const data = ext === 'wav' ? encodeWav(l, r, opts.sampleRate, opts.bps, tags) : encodeFlac(l, r, opts.sampleRate, opts.bps, tags);
  const width = Math.max(2, String(album.total).length);
  const name = `${String(sel.number).padStart(width, '0')} - ${safeName(sel.title)}.${ext}`;
  return { name, data, seconds: l.length / opts.sampleRate };
}

export function albumFolder(album) {
  return safeName(album.year ? `${album.album} (${album.year})` : album.album);
}

export function playlist(entries) {
  return '#EXTM3U\n' + entries.map((e) => `#EXTINF:${Math.round(e.seconds)},${e.title}\n${e.name}\n`).join('');
}
