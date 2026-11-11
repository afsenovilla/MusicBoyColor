// UI glue. The worker does the emulation; this file only shows state.

import { LANGS, t, has, getLang, setLang } from './i18n.js';

const $ = (id) => document.getElementById(id);
const worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });

const state = { meta: null, method: '', tracks: [], busy: false, playing: -1, fileName: '', logs: [], progress: null };
let audioCtx = null, source = null;


function options() {
  return {
    format: $('o-format').value, sampleRate: +$('o-rate').value, bps: +$('o-bps').value,
    loops: +$('o-loops').value, fadeSec: +$('o-fade').value, normalize: $('o-norm').checked, maxSec: 900,
  };
}

function duration(t) {
  const o = options();
  const data = o.format === 'mid' || o.format === 'vgm';
  const raw = t.looping ? t.introSec + t.loopSec * (o.format === 'vgm' ? 1 : o.loops) + (data ? 0 : o.fadeSec) : t.endSec + 1;
  return Math.max(0, Math.min(raw, o.maxSec) - t.skipSec);
}

function clock(sec) {
  const s = Math.round(sec);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function setBusy(busy) {
  state.busy = busy;
  for (const b of document.querySelectorAll('#result button, #result select')) b.disabled = busy;
  if (!busy) syncOptions();
  if (!busy) refreshSummary();
}

// Audio-only options make no sense for the data formats.
function syncOptions() {
  const f = $('o-format').value, data = f === 'mid' || f === 'vgm';
  for (const id of ['o-rate', 'o-bps', 'o-fade', 'o-norm']) $(id).disabled = data || state.busy;
  $('o-loops').disabled = f === 'vgm' || state.busy;
  $('format-hint').textContent = data ? t(`hint.${f}`) : '';
}

function show(id, on) { $(id).hidden = !on; }

function setProgress(value, label, params) {
  state.progress = { value, label, params };
  $('status-label').textContent = t(label, { file: state.fileName, ...params });
  $('status-pct').textContent = `${Math.round(value * 100)} %`;
  $('bar-fill').style.width = `${value * 100}%`;
}

function fail(message) {
  state.lastError = () => (has(message) ? t(message) : t('err.internal', { msg: message }));
  $('error').textContent = state.lastError();
  show('error', true);
  show('status', false);
  setBusy(false);
}

function openFile(file) {
  if (!file || state.busy) return;
  stopAudio();
  state.fileName = file.name;
  show('drop', false); show('result', false); show('error', false); show('status', true);
  state.logs = []; renderLog();
  setProgress(0, 'p.analyze');
  state.busy = true;
  file.arrayBuffer().then((bytes) => worker.postMessage({ type: 'open', bytes }, [bytes]));
}

function selected() { return state.tracks.filter((tk) => tk.selected); }

function refreshSummary() {
  const sel = selected();
  const total = sel.reduce((s, tk) => s + duration(tk), 0);
  $('count').textContent = t('count', { sel: sel.length, n: state.tracks.length, time: clock(total) });
  $('all').checked = sel.length === state.tracks.length;
  $('all').indeterminate = sel.length > 0 && sel.length < state.tracks.length;
  $('export').disabled = state.busy || sel.length === 0;
  let n = 0;
  state.tracks.forEach((tk, i) => {
    const row = $('rows').children[i];
    row.classList.toggle('off', !tk.selected);
    row.querySelector('.n').textContent = tk.selected ? String(++n).padStart(2, '0') : '–';
    row.querySelector('.dur').textContent = clock(duration(tk));
  });
}

function buildRows() {
  const rows = $('rows');
  rows.textContent = '';
  state.tracks.forEach((tk, i) => {
    const tr = document.createElement('tr');
    const cell = (cls) => { const td = document.createElement('td'); if (cls) td.className = cls; tr.append(td); return td; };
    const cb = Object.assign(document.createElement('input'), { type: 'checkbox', checked: tk.selected });
    cb.setAttribute('aria-label', t('a.include', { n: i + 1 }));
    cb.addEventListener('change', () => { tk.selected = cb.checked; refreshSummary(); });
    const check = document.createElement('label'); check.className = 'check'; check.append(cb);
    cell().append(check);
    cell('num n');
    const title = Object.assign(document.createElement('input'), { type: 'text', value: tk.title });
    title.setAttribute('aria-label', t('a.title', { n: i + 1 }));
    title.addEventListener('input', () => { tk.title = title.value; tk.custom = true; });
    cell().append(title);
    const label = t(`kind.${tk.kind}`), cls = tk.kind === 'loop' ? 'loop' : '';
    const kind = cell();
    kind.append(Object.assign(document.createElement('span'), { className: `badge ${cls}`, textContent: label }));
    if (tk.dubious) kind.append(' ', Object.assign(document.createElement('span'), { className: 'badge warn', textContent: t('dubious'), title: t('dubious.tip') }));
    cell('num dur');
    const actions = cell();
    const play = Object.assign(document.createElement('button'), { type: 'button', className: 'icon play', textContent: '▶', title: t('a.play') });
    play.addEventListener('click', () => togglePlay(i));
    const dl = Object.assign(document.createElement('button'), { type: 'button', className: 'icon', textContent: '↓', title: t('a.dl') });
    dl.addEventListener('click', () => exportTracks([tk], true));
    actions.append(play, ' ', dl);
    rows.append(tr);
  });
  refreshSummary();
}

const trackName = (i) => t('track', { n: String(i + 1).padStart(Math.max(2, String(state.tracks.length).length), '0') });
const fileBase = () => state.fileName.replace(/\.[^.]+$/, '').replace(/\s*[([].*$/, '');

function renderMeta() {
  const meta = state.meta;
  if (!meta) return;
  const chips = [meta.system, meta.mapper !== 'GBS' ? `${meta.mapper} · ${Math.round(meta.size / 1024)} KB` : 'GBS',
    meta.region && t(`chip.${meta.region}`), meta.checksum && t('chip.sum', { v: meta.checksum })].filter(Boolean);
  $('chips').textContent = '';
  for (const c of chips) $('chips').append(Object.assign(document.createElement('li'), { textContent: c }));
  $('hint').textContent = state.method === 'full' ? t('hint.full')
    : state.tracks.length === 0 ? t('hint.none') : meta.type === 'rom' ? t('hint.rom') : '';
}

function onOpened({ meta, method, tracks }) {
  state.meta = meta; state.method = method;
  state.tracks = tracks.map((tk, i) => ({ ...tk, index: i, selected: tk.kind !== 'sfx' && !tk.dubious, title: '', custom: false }));
  state.tracks.forEach((tk, i) => { tk.title = trackName(i); });
  $('f-album').value = meta.title || fileBase();
  $('f-artist').value = meta.author || meta.publisher || '';
  $('f-year').value = meta.year || '';
  $('f-genre').value = t('genre'); $('f-genre').dataset.auto = '1';
  $('cart-label').textContent = meta.rawTitle || fileBase();
  renderMeta();
  buildRows();
  show('status', false); show('result', true);
  setBusy(false);
}

function renderLog() {
  $('log').textContent = '';
  for (const [key, params] of state.logs) $('log').append(Object.assign(document.createElement('li'), { textContent: t(key, params) }));
}

function applyLang() {
  document.documentElement.lang = getLang();
  document.title = t('doc.title');
  for (const el of document.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n, el.dataset);
  $('drop').setAttribute('aria-label', t('drop.aria'));
  $('lang').setAttribute('aria-label', t('lang'));
  syncOptions();
  if ($('f-genre').dataset.auto) $('f-genre').value = t('genre');
  state.tracks.forEach((tk, i) => { if (!tk.custom) tk.title = trackName(i); });
  renderLog();
  if (state.progress) setProgress(state.progress.value, state.progress.label, state.progress.params);
  if (state.lastError) $('error').textContent = state.lastError();
  if (state.meta) { renderMeta(); const playing = state.playing; buildRows(); if (playing >= 0) { const b = $('rows').children[playing].querySelector('.play'); b.textContent = '■'; b.classList.add('on'); } }
}

function stopAudio() {
  if (source) { source.onended = null; try { source.stop(); } catch { /* already stopped */ } source = null; }
  if (state.playing >= 0) {
    const b = $('rows').children[state.playing]?.querySelector('.play');
    if (b) { b.textContent = '▶'; b.classList.remove('on'); }
  }
  state.playing = -1;
}

function togglePlay(i) {
  const was = state.playing;
  stopAudio();
  if (was === i || state.busy) return;
  audioCtx = audioCtx || new AudioContext();
  audioCtx.resume();
  state.playing = i;
  const b = $('rows').children[i].querySelector('.play');
  b.textContent = '…'; b.classList.add('on');
  setBusy(true);
  worker.postMessage({ type: 'preview', index: i, opts: options() });
}

function onPreview({ index, l, r, sampleRate }) {
  setBusy(false);
  if (state.playing !== index) return;
  const buf = audioCtx.createBuffer(2, l.length, sampleRate);
  buf.copyToChannel(l, 0); buf.copyToChannel(r, 1);
  source = audioCtx.createBufferSource();
  source.buffer = buf; source.connect(audioCtx.destination);
  source.onended = () => stopAudio();
  source.start();
  $('rows').children[index].querySelector('.play').textContent = '■';
}

function exportTracks(list, single) {
  if (state.busy || !list.length) return;
  stopAudio();
  const album = {
    album: $('f-album').value.trim() || 'Game Boy', artist: $('f-artist').value.trim(), comment: t('comment'),
    year: $('f-year').value.trim(), genre: $('f-genre').value.trim(), total: single ? selected().length || 1 : list.length,
  };
  const order = selected();
  const tracks = list.map((tk, k) => ({
    index: tk.index, title: tk.title.trim() || trackName(tk.index),
    number: single ? Math.max(1, order.indexOf(tk) + 1) : k + 1,
  }));
  setBusy(true);
  show('status', true); state.logs = []; renderLog();
  setProgress(0, 'p.pack');
  worker.postMessage({ type: 'export', tracks, album, opts: options(), single });
}

function onExported({ name, blob }) {
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: name });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 60000);
  show('status', false);
  setBusy(false);
}

worker.onmessage = ({ data }) => {
  switch (data.type) {
    case 'log': state.logs.push([data.key, data.params]); renderLog(); break;
    case 'progress': setProgress(data.value, data.label, data.params); break;
    case 'opened': onOpened(data); break;
    case 'preview': onPreview(data); break;
    case 'exported': onExported(data); break;
    case 'error':
      if (data.during === 'open') { show('drop', true); fail(data.message); state.busy = false; }
      else { stopAudio(); fail(data.message); }
      break;
  }
};
worker.onerror = (e) => fail(e.message || 'worker');

const drop = $('drop');
drop.addEventListener('click', () => $('file').click());
drop.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('file').click(); } });
$('file').addEventListener('change', (e) => { openFile(e.target.files[0]); e.target.value = ''; });
window.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
window.addEventListener('dragleave', () => drop.classList.remove('over'));
window.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('over'); openFile(e.dataTransfer.files[0]); });
$('all').addEventListener('change', (e) => { state.tracks.forEach((tk, i) => { tk.selected = e.target.checked; $('rows').children[i].querySelector('input').checked = tk.selected; }); refreshSummary(); });
$('export').addEventListener('click', () => exportTracks(selected(), false));
$('another').addEventListener('click', () => { stopAudio(); show('result', false); show('error', false); show('drop', true); });
for (const id of ['o-loops', 'o-fade']) $(id).addEventListener('change', refreshSummary);
$('o-format').addEventListener('change', () => { syncOptions(); refreshSummary(); });
$('f-genre').addEventListener('input', () => { delete $('f-genre').dataset.auto; });
for (const [code, name] of Object.entries(LANGS)) $('lang').append(Object.assign(document.createElement('option'), { value: code, textContent: name }));
$('lang').value = getLang();
$('lang').addEventListener('change', (e) => { setLang(e.target.value); applyLang(); });
applyLang();
