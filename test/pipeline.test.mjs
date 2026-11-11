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

function parseMidi(data) {
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  assert.equal(String.fromCharCode(...data.subarray(0, 4)), 'MThd');
  const ntracks = dv.getUint16(10), tracks = [];
  let o = 14;
  for (let k = 0; k < ntracks; k++) {
    assert.equal(String.fromCharCode(...data.subarray(o, o + 4)), 'MTrk');
    const end = o + 8 + dv.getUint32(o + 4);
    o += 8;
    const ev = [];
    let tick = 0;
    while (o < end) {
      let d = 0, b;
      do { b = data[o++]; d = (d << 7) | (b & 0x7f); } while (b & 0x80);
      tick += d;
      const st = data[o++];
      if (st === 0xff) { const type = data[o++], len = data[o++]; ev.push({ tick, meta: type, text: new TextDecoder().decode(data.subarray(o, o + len)) }); o += len; }
      else { const n = (st & 0xf0) === 0xc0 ? 1 : 2; ev.push({ tick, st, a: data[o], b: n === 2 ? data[o + 1] : 0 }); o += n; }
    }
    assert.equal(o, end);
    tracks.push(ev);
  }
  return tracks;
}

test('MIDI export: right notes, timing and loop markers', () => {
  const s = openSource(makeRom('call'));
  const f = exportTrack(s, { index: 1, title: 'Scale', number: 2 }, { album: 'T', artist: '', year: '', genre: '', total: 5 }, { ...OPTS, format: 'mid', loops: 2 });
  assert.equal(f.name, '02 - Scale.mid');
  const tracks = parseMidi(f.data);
  assert.equal(tracks.length, 2); // conductor + pulse 1
  const ons = tracks[1].filter((e) => (e.st & 0xf0) === 0x90);
  // C major scale C4..C5, played twice (2 loops), 15 frames per note.
  assert.deepEqual(ons.map((e) => e.a), [60, 62, 64, 65, 67, 69, 71, 72, 60, 62, 64, 65, 67, 69, 71, 72]);
  const step = ons[1].tick - ons[0].tick;
  assert.ok(Math.abs(step - 15 / 59.7275 * 960) <= 1, `step ${step}`);
  assert.equal(tracks[1].filter((e) => (e.st & 0xf0) === 0x80).length, ons.length);
  assert.deepEqual(tracks[0].filter((e) => e.meta === 6).map((e) => e.text), ['loopStart', 'loopEnd']);
});

test('VGM export: header, loop point and register log', () => {
  const s = openSource(makeRom('call'));
  const f = exportTrack(s, { index: 1, title: 'Scale', number: 2 }, { album: 'T', artist: 'A', year: '1998', genre: '', total: 5 }, { ...OPTS, format: 'vgm' });
  const d = f.data, dv = new DataView(d.buffer, d.byteOffset, d.byteLength);
  assert.equal(String.fromCharCode(...d.subarray(0, 4)), 'Vgm ');
  assert.equal(dv.getUint32(4, true), d.length - 4);
  assert.equal(dv.getUint32(0x80, true), 4194304);
  const total = dv.getUint32(0x18, true);
  assert.ok(Math.abs(total / 44100 - 120 / 59.7275) < 0.01);
  assert.equal(dv.getUint32(0x20, true), total); // whole song is the loop
  // Walk the command stream: it must end exactly at the GD3 tag.
  let o = 0x100, samples = 0, writes = 0, triggers = 0;
  for (;;) {
    const c = d[o];
    if (c === 0x66) { o++; break; }
    if (c === 0x61) { samples += d[o + 1] | (d[o + 2] << 8); o += 3; }
    else { assert.equal(c, 0xb3); writes++; if (d[o + 1] === 4 && (d[o + 2] & 0x80)) triggers++; o += 3; }
  }
  assert.equal(samples, total);
  assert.equal(triggers, 8);
  assert.equal(o, 0x14 + dv.getUint32(0x14, true));
  assert.equal(String.fromCharCode(...d.subarray(o, o + 4)), 'Gd3 ');
});

test('GBS export: relocates low code, restores RAM and matches the ROM', async () => {
  const { buildGbs } = await import('../src/rip/gbsexport.js');
  for (const variant of ['call', 'poke']) {
    const rom = makeRom(variant, 'TESTSONGS', true);
    const s = openSource(rom);
    const r = buildGbs(s, rom, { title: 'Test', author: 'Me' });
    assert.equal(r.checked, SONGS.length);
    assert.equal(r.matched, SONGS.length);
    assert.ok(r.relocated > 0);
    const g = openSource(r.data);
    assert.equal(g.meta.title, 'Test');
    assert.deepEqual(g.tracks.map((t) => t.info.loopLen), s.tracks.map((t) => t.info.loopLen));
  }
  // Sound data below 0x400 cannot live in a GBS.
  const low = makeRom('call');
  assert.throws(() => buildGbs(openSource(low), low), /gbs\.lowData/);
});
