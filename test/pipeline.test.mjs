import test from 'node:test';
import assert from 'node:assert/strict';
import { makeRom, makeGbs, SONGS } from './makerom.mjs';
import { openSource, renderTrack, trackPlan } from '../src/rip/pipeline.js';
import { exportTrack, playlist } from '../src/rip/export.js';
import { quantize } from '../src/enc/pcm.js';
import { encodeFlac } from '../src/enc/flac.js';
import { md5 } from '../src/enc/md5.js';
import { makeZip, crc32 } from '../src/enc/zip.js';
import { parseRomHeader, looksLikeRom } from '../src/meta/header.js';

const OPTS = { loops: 2, fadeSec: 8, maxSec: 600, sampleRate: 44100, bps: 16, format: 'flac' };
// Loop lengths in frames for the synthetic songs (notes x frames per note).
const LOOPS = [0, 8 * 15, 12 * 20, 13 * 12, 18 * 10];

function checkTracks(s, idOffset) {
  assert.equal(s.tracks.length, SONGS.length);
  s.tracks.forEach((t, i) => {
    assert.equal(t.id, i + idOffset);
    if (i === 0) { assert.equal(t.info.looping, false); assert.equal(t.kind, 'sfx'); }
    else { assert.equal(t.info.looping, true); assert.equal(t.info.loopLen, LOOPS[i]); }
  });
}

test('ROM whose game calls PlaySong(A): finds the function and every song', () => {
  const s = openSource(makeRom('call'));
  assert.equal(s.method, 'call');
  checkTracks(s, 0);
});

test('ROM whose driver polls a request variable: finds the variable', () => {
  const s = openSource(makeRom('poke'));
  assert.equal(s.method, 'poke');
  checkTracks(s, 1);
});

test('GBS file: header metadata and songs', () => {
  const s = openSource(makeGbs());
  assert.equal(s.meta.title, 'Test Songs');
  assert.equal(s.meta.author, 'MusicBoyColor');
  assert.equal(s.meta.year, '2026');
  checkTracks(s, 0);
});

test('rendering is deterministic, the right length and plays the right pitch', () => {
  const s = openSource(makeRom('call'));
  const a = renderTrack(s, s.tracks[1], OPTS), b = renderTrack(s, s.tracks[1], OPTS);
  assert.deepEqual(a.l, b.l);
  const { seconds } = trackPlan(s, s.tracks[1], OPTS);
  assert.ok(Math.abs(a.l.length / 44100 - seconds) < 0.1);
  // First note is C4 (262 Hz): count rising zero crossings over 0.2 s.
  let crossings = 0;
  for (let i = 2000; i < 2000 + 8820; i++) if (a.l[i - 1] < 0 && a.l[i] >= 0) crossings++;
  assert.ok(Math.abs(crossings / 0.2 - 262) < 8, `measured ${crossings / 0.2} Hz`);
  let peak = 0;
  for (const v of a.l) peak = Math.max(peak, Math.abs(v));
  assert.ok(peak > 0.1 && peak <= 1);
  assert.ok(Math.abs(a.l[a.l.length - 1]) < 1e-3, 'fades to silence');
});

test('FLAC: valid structure, tags and MD5 of the PCM', () => {
  const s = openSource(makeGbs());
  const f = exportTrack(s, { index: 2, title: 'Canción: ñ/2', number: 3 }, { album: 'Test', artist: 'A', year: '1998', genre: 'G', total: 5 }, OPTS);
  assert.equal(f.name, '03 - Canción ñ 2.flac');
  assert.equal(String.fromCharCode(...f.data.subarray(0, 4)), 'fLaC');
  const text = new TextDecoder().decode(f.data.subarray(0, 600));
  for (const tag of ['TITLE=Canción: ñ/2', 'ALBUM=Test', 'TRACKNUMBER=3', 'TRACKTOTAL=5', 'DATE=1998', 'LOOPLENGTH=']) assert.ok(text.includes(tag), tag);
  const pcm = renderTrack(s, s.tracks[2], OPTS);
  const [l, r] = quantize(pcm, 16);
  const raw = new Uint8Array(l.length * 4);
  for (let i = 0; i < l.length; i++) { raw[i * 4] = l[i]; raw[i * 4 + 1] = l[i] >> 8; raw[i * 4 + 2] = r[i]; raw[i * 4 + 3] = r[i] >> 8; }
  assert.deepEqual(encodeFlac(l, r, 44100, 16).subarray(26, 42), md5(raw));
});

test('helpers: md5, crc32, zip, header', () => {
  const hex = (u) => [...u].map((x) => x.toString(16).padStart(2, '0')).join('');
  assert.equal(hex(md5(new TextEncoder().encode('abc'))), '900150983cd24fb0d6963f7d28e17f72');
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
  const zip = makeZip([{ name: 'a/b.txt', data: new Uint8Array([1, 2, 3]) }]);
  assert.equal(zip.reduce((n, p) => n + p.length, 0), 30 + 7 + 3 + 46 + 7 + 22);
  const rom = makeRom('call', 'SUPER TEST II');
  assert.ok(looksLikeRom(rom));
  const h = parseRomHeader(rom);
  assert.equal(h.title, 'Super Test II');
  assert.equal(h.publisher, 'Nintendo');
  assert.ok(playlist([{ name: '01 - a.flac', title: 'a', seconds: 3.4 }]).includes('#EXTINF:3,a\n01 - a.flac'));
});
