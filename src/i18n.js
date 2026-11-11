// UI strings. English is the default; the choice is remembered per browser.

export const LANGS = { en: 'English', es: 'Español' };

const STR = {
  en: {
    'doc.title': 'MusicBoyColor · Rip the music from your Game Boy ROMs',
    tagline: 'Your cartridge’s soundtrack, track by track, lossless.',
    'drop.title': 'Drop a ROM here',
    'drop.sub': '— or click to choose one',
    'drop.aria': 'Choose a ROM',
    privacy: 'The file never leaves your device: the console is emulated in your browser.',
    'f.album': 'Album', 'f.artist': 'Artist', 'f.year': 'Year', 'f.genre': 'Genre',
    'o.format': 'Format', 'o.flac': 'FLAC (lossless)', 'o.mid': 'MIDI (notes)', 'o.vgm': 'VGM (raw chip log)',
    'hint.mid': 'MIDI is an interpretation: pitches, timing and volumes are kept, but the Game Boy’s timbres are not. Pulse 1, Pulse 2 and Wave become three instrument tracks and Noise becomes drums.',
    'hint.vgm': 'VGM is the exact log of what the game writes to the sound chip, with its loop point. It plays in VGM players (VGMPlay, foobar2000, Winamp plug-ins) and converts back to audio without loss.', 'o.rate': 'Sample rate', 'o.bps': 'Bit depth',
    'o.bits': '{n}-bit', 'o.loops': 'Loops', 'o.loop1': 'Play once', 'o.loopN': '{n} times',
    'o.fade': 'Fade-out', 'o.nofade': 'No fade', 'o.norm': 'Normalize volume',
    'btn.zip': 'Download ZIP', 'btn.another': 'Open another ROM',
    'th.title': 'Title', 'th.kind': 'Type', 'th.dur': 'Length',
    footer: 'MusicBoyColor neither includes nor distributes ROMs. Use it with dumps of games you own.',
    lang: 'Language',
    genre: 'Game', track: 'Track {n}', comment: 'Ripped with MusicBoyColor',
    count: '{sel} of {n} tracks · {time}',
    'kind.loop': 'Looping', 'kind.open': 'Loop not found', 'kind.once': 'One-shot', 'kind.sfx': 'Jingle / SFX',
    dubious: 'Dubious', 'dubious.tip': 'The driver did odd things with this id: it may not be a real song.',
    'a.include': 'Include track {n}', 'a.title': 'Title of track {n}', 'a.play': 'Listen', 'a.dl': 'Download this track only',
    'chip.jp': 'Japan', 'chip.intl': 'International', 'chip.sum': 'Checksum {v}',
    'hint.full': 'This game’s sound driver could not be isolated, so only the music it plays on start-up was captured. A .gbs file of the same game will give you every track.',
    'hint.none': 'No songs were found.',
    'hint.rom': 'Cartridges do not store song names: listen and name the tracks before downloading.',
    'p.analyze': 'Analysing {file}', 'p.render': 'Rendering {k}/{n}: {title}', 'p.pack': 'Packing',
    'log.boot': 'Booting the game and looking for its sound routine…',
    'log.play': 'Sound routine at {addr} after {sec} s of play.',
    'log.rate': 'Driver tick rate: {hz} Hz.',
    'log.cands': 'Candidates: {fns} functions and {vars} variables write into the driver’s state.',
    'log.selCall': 'Song selector: function {fn} taking the id in register {reg}.',
    'log.selPoke': 'Song selector: request variable in RAM (#{id}).',
    'log.selCallRam': 'Song selector: function {fn} reading the id from RAM (#{id}).',
    'log.fallback': 'Could not find how the game selects songs: capturing the audio as the game plays it.',
    'log.gbs': 'GBS file with {n} songs.',
    'log.badHeader': 'Warning: the ROM header fails its checksum; trying anyway.',
    'log.analyze': 'Analysing songs (loops and lengths)…',
    'log.found': 'Tracks found: {n}.',
    'err.silent': 'The ROM produced no sound during analysis.',
    'err.notRom': 'This file does not look like a Game Boy ROM or a GBS file.',
    'err.gbs': 'Invalid GBS header.',
    'err.render': 'This track could not be rendered.',
    'err.internal': 'Internal error: {msg}',
  },
  es: {
    'doc.title': 'MusicBoyColor · Extrae la música de tus ROMs de Game Boy',
    tagline: 'La banda sonora de tu cartucho, pista a pista y sin pérdidas.',
    'drop.title': 'Suelta aquí una ROM',
    'drop.sub': '— o haz clic para elegirla',
    'drop.aria': 'Elegir una ROM',
    privacy: 'El archivo no sale de tu equipo: la consola se emula en tu navegador.',
    'f.album': 'Álbum', 'f.artist': 'Artista', 'f.year': 'Año', 'f.genre': 'Género',
    'o.format': 'Formato', 'o.flac': 'FLAC (sin pérdidas)', 'o.mid': 'MIDI (notas)', 'o.vgm': 'VGM (registro del chip)',
    'hint.mid': 'El MIDI es una interpretación: conserva notas, tiempos y volúmenes, pero no los timbres de la Game Boy. Pulso 1, Pulso 2 y Onda salen como tres pistas de instrumento y el Ruido como batería.',
    'hint.vgm': 'El VGM es el registro exacto de lo que el juego escribe en el chip de sonido, con su punto de bucle. Se reproduce en reproductores VGM (VGMPlay, foobar2000, plugins de Winamp) y se convierte a audio sin pérdida.', 'o.rate': 'Frecuencia', 'o.bps': 'Resolución',
    'o.bits': '{n} bits', 'o.loops': 'Bucles', 'o.loop1': '1 vuelta', 'o.loopN': '{n} vueltas',
    'o.fade': 'Fundido final', 'o.nofade': 'Sin fundido', 'o.norm': 'Normalizar volumen',
    'btn.zip': 'Descargar ZIP', 'btn.another': 'Abrir otra ROM',
    'th.title': 'Título', 'th.kind': 'Tipo', 'th.dur': 'Duración',
    footer: 'MusicBoyColor no incluye ni distribuye ROMs. Úsalo con copias de juegos que te pertenezcan.',
    lang: 'Idioma',
    genre: 'Videojuego', track: 'Pista {n}', comment: 'Extraído con MusicBoyColor',
    count: '{sel} de {n} pistas · {time}',
    'kind.loop': 'En bucle', 'kind.open': 'Bucle no hallado', 'kind.once': 'Sin bucle', 'kind.sfx': 'Efecto / jingle',
    dubious: 'Dudosa', 'dubious.tip': 'El driver hizo cosas raras con este id: puede no ser una canción real.',
    'a.include': 'Incluir pista {n}', 'a.title': 'Título de la pista {n}', 'a.play': 'Escuchar', 'a.dl': 'Descargar solo esta pista',
    'chip.jp': 'Japón', 'chip.intl': 'Internacional', 'chip.sum': 'Suma {v}',
    'hint.full': 'No se pudo aislar el driver de sonido de este juego, así que solo se ha capturado la música que suena al arrancarlo. Un archivo .gbs del mismo juego dará todas las pistas.',
    'hint.none': 'No se ha encontrado ninguna canción.',
    'hint.rom': 'Los cartuchos no guardan los nombres de las canciones: escúchalas y ponles título antes de descargar.',
    'p.analyze': 'Analizando {file}', 'p.render': 'Renderizando {k}/{n}: {title}', 'p.pack': 'Empaquetando',
    'log.boot': 'Arrancando el juego y buscando la rutina de sonido…',
    'log.play': 'Rutina de sonido en {addr} tras {sec} s de juego.',
    'log.rate': 'Ritmo del driver: {hz} Hz.',
    'log.cands': 'Candidatos: {fns} funciones y {vars} variables escriben en el estado del driver.',
    'log.selCall': 'Selector de canción: función {fn} con el id en el registro {reg}.',
    'log.selPoke': 'Selector de canción: variable de petición en RAM (#{id}).',
    'log.selCallRam': 'Selector de canción: función {fn} con el id en RAM (#{id}).',
    'log.fallback': 'No se encontró cómo elige canción el juego: se captura el audio tal cual lo reproduce.',
    'log.gbs': 'Archivo GBS con {n} canciones.',
    'log.badHeader': 'Aviso: la cabecera de la ROM no supera la comprobación; se intenta igualmente.',
    'log.analyze': 'Analizando canciones (bucles y duraciones)…',
    'log.found': 'Pistas encontradas: {n}.',
    'err.silent': 'La ROM no produjo ningún sonido durante el análisis.',
    'err.notRom': 'El archivo no parece una ROM de Game Boy ni un GBS.',
    'err.gbs': 'Cabecera GBS no válida.',
    'err.render': 'No se pudo renderizar esta pista.',
    'err.internal': 'Error interno: {msg}',
  },
};

let lang = 'en';
try { const saved = localStorage.getItem('mbc-lang'); if (saved && STR[saved]) lang = saved; } catch { /* storage unavailable */ }

export const getLang = () => lang;
export function setLang(l) {
  if (!STR[l]) return;
  lang = l;
  try { localStorage.setItem('mbc-lang', l); } catch { /* storage unavailable */ }
}
export const has = (key) => key in STR.en;
export function t(key, params = {}) {
  const s = STR[lang][key] ?? STR.en[key] ?? key;
  return s.replace(/\{(\w+)\}/g, (m, k) => (k in params ? params[k] : m));
}
