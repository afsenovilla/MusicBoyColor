// Cartridge header parsing and a stable identity for the ROM.

const OLD_LICENSEES = {
  0x01: 'Nintendo', 0x08: 'Capcom', 0x09: 'Hot-B', 0x0a: 'Jaleco', 0x0b: 'Coconuts', 0x0c: 'Elite Systems',
  0x13: 'Electronic Arts', 0x18: 'Hudson Soft', 0x19: 'ITC Entertainment', 0x1a: 'Yanoman', 0x1d: 'Clary',
  0x1f: 'Virgin', 0x24: 'PCM Complete', 0x25: 'San-X', 0x28: 'Kotobuki Systems', 0x29: 'Seta', 0x30: 'Infogrames',
  0x31: 'Nintendo', 0x32: 'Bandai', 0x34: 'Konami', 0x35: 'Hector', 0x38: 'Capcom', 0x39: 'Banpresto',
  0x3c: 'Entertainment i', 0x3e: 'Gremlin', 0x41: 'Ubi Soft', 0x42: 'Atlus', 0x44: 'Malibu', 0x46: 'Angel',
  0x47: 'Spectrum Holobyte', 0x49: 'Irem', 0x4a: 'Virgin', 0x4d: 'Malibu', 0x4f: 'U.S. Gold', 0x50: 'Absolute',
  0x51: 'Acclaim', 0x52: 'Activision', 0x53: 'American Sammy', 0x54: 'GameTek', 0x55: 'Park Place', 0x56: 'LJN',
  0x57: 'Matchbox', 0x59: 'Milton Bradley', 0x5a: 'Mindscape', 0x5b: 'Romstar', 0x5c: 'Naxat Soft', 0x5d: 'Tradewest',
  0x60: 'Titus', 0x61: 'Virgin', 0x67: 'Ocean', 0x69: 'Electronic Arts', 0x6e: 'Elite Systems', 0x6f: 'Electro Brain',
  0x70: 'Infogrames', 0x71: 'Interplay', 0x72: 'Broderbund', 0x73: 'Sculptured Soft', 0x75: 'The Sales Curve',
  0x78: 'THQ', 0x79: 'Accolade', 0x7a: 'Triffix Entertainment', 0x7c: 'MicroProse', 0x7f: 'Kemco',
  0x80: 'Misawa Entertainment', 0x83: 'LOZC', 0x86: 'Tokuma Shoten', 0x8b: 'Bullet-Proof Software', 0x8c: 'Vic Tokai',
  0x8e: 'Ape', 0x8f: "I'Max", 0x91: 'Chunsoft', 0x92: 'Video System', 0x93: 'Tsubaraya', 0x95: 'Varie',
  0x96: "Yonezawa/S'Pal", 0x97: 'Kaneko', 0x99: 'Arc', 0x9a: 'Nihon Bussan', 0x9b: 'Tecmo', 0x9c: 'Imagineer',
  0x9d: 'Banpresto', 0x9f: 'Nova', 0xa1: 'Hori Electric', 0xa2: 'Bandai', 0xa4: 'Konami', 0xa6: 'Kawada',
  0xa7: 'Takara', 0xa9: 'Technos Japan', 0xaa: 'Broderbund', 0xac: 'Toei Animation', 0xad: 'Toho', 0xaf: 'Namco',
  0xb0: 'Acclaim', 0xb1: 'ASCII / Nexoft', 0xb2: 'Bandai', 0xb4: 'Enix', 0xb6: 'HAL Laboratory', 0xb7: 'SNK',
  0xb9: 'Pony Canyon', 0xba: 'Culture Brain', 0xbb: 'Sunsoft', 0xbd: 'Sony Imagesoft', 0xbf: 'Sammy',
  0xc0: 'Taito', 0xc2: 'Kemco', 0xc3: 'Squaresoft', 0xc4: 'Tokuma Shoten', 0xc5: 'Data East', 0xc6: 'Tonkin House',
  0xc8: 'Koei', 0xc9: 'UFL', 0xca: 'Ultra', 0xcb: 'Vap', 0xcc: 'Use', 0xcd: 'Meldac', 0xce: 'Pony Canyon',
  0xcf: 'Angel', 0xd0: 'Taito', 0xd1: 'Sofel', 0xd2: 'Quest', 0xd3: 'Sigma Enterprises', 0xd4: 'Ask Kodansha',
  0xd6: 'Naxat Soft', 0xd7: 'Copya Systems', 0xd9: 'Banpresto', 0xda: 'Tomy', 0xdb: 'LJN', 0xdd: 'NCS',
  0xde: 'Human', 0xdf: 'Altron', 0xe0: 'Jaleco', 0xe1: 'Towachiki', 0xe2: 'Uutaka', 0xe3: 'Varie', 0xe5: 'Epoch',
  0xe7: 'Athena', 0xe8: 'Asmik', 0xe9: 'Natsume', 0xea: 'King Records', 0xeb: 'Atlus', 0xec: 'Epic/Sony Records',
  0xee: 'IGS', 0xf0: 'A Wave', 0xf3: 'Extreme Entertainment', 0xff: 'LJN',
};
const NEW_LICENSEES = {
  '01': 'Nintendo', '08': 'Capcom', '13': 'Electronic Arts', '18': 'Hudson Soft', '19': 'B-AI', '20': 'KSS',
  '22': 'Planning Office WADA', '24': 'PCM Complete', '25': 'San-X', '28': 'Kemco', '29': 'Seta', '30': 'Viacom',
  '31': 'Nintendo', '32': 'Bandai', '33': 'Ocean/Acclaim', '34': 'Konami', '35': 'Hector', '37': 'Taito',
  '38': 'Hudson Soft', '39': 'Banpresto', '41': 'Ubi Soft', '42': 'Atlus', '44': 'Malibu', '46': 'Angel',
  '47': 'Bullet-Proof Software', '49': 'Irem', '50': 'Absolute', '51': 'Acclaim', '52': 'Activision',
  '53': 'American Sammy', '54': 'Konami', '55': 'Hi Tech Expressions', '56': 'LJN', '57': 'Matchbox', '58': 'Mattel',
  '59': 'Milton Bradley', '60': 'Titus', '61': 'Virgin', '64': 'LucasArts', '67': 'Ocean', '69': 'Electronic Arts',
  '70': 'Infogrames', '71': 'Interplay', '72': 'Broderbund', '73': 'Sculptured Soft', '75': 'The Sales Curve',
  '78': 'THQ', '79': 'Accolade', '80': 'Misawa Entertainment', '83': 'LOZC', '86': 'Tokuma Shoten',
  '87': 'Tsukuda Original', '91': 'Chunsoft', '92': 'Video System', '93': 'Ocean/Acclaim', '95': 'Varie',
  '96': "Yonezawa/S'Pal", '97': 'Kaneko', '99': 'Pack-In-Video', 'A4': 'Konami (Yu-Gi-Oh!)', 'BL': 'MTO',
  'DK': 'Kodansha',
};
const CART_TYPES = { 0: 'ROM', 1: 'MBC1', 2: 'MBC1', 3: 'MBC1', 5: 'MBC2', 6: 'MBC2', 0x0f: 'MBC3', 0x10: 'MBC3',
  0x11: 'MBC3', 0x12: 'MBC3', 0x13: 'MBC3', 0x19: 'MBC5', 0x1a: 'MBC5', 0x1b: 'MBC5', 0x1c: 'MBC5', 0x1d: 'MBC5',
  0x1e: 'MBC5', 0x20: 'MBC6', 0x22: 'MBC7', 0xfc: 'Pocket Camera', 0xfd: 'TAMA5', 0xfe: 'HuC3', 0xff: 'HuC1' };

export function isGbs(bytes) {
  return bytes.length > 0x70 && bytes[0] === 0x47 && bytes[1] === 0x42 && bytes[2] === 0x53;
}

export function looksLikeRom(bytes) {
  if (bytes.length < 0x8000) return false;
  let sum = 0;
  for (let i = 0x134; i <= 0x14c; i++) sum = (sum - bytes[i] - 1) & 0xff;
  return sum === bytes[0x14d];
}

function ascii(bytes, from, to) {
  let s = '';
  for (let i = from; i < to; i++) {
    const c = bytes[i];
    if (c === 0) break;
    s += c >= 0x20 && c < 0x7f ? String.fromCharCode(c) : ' ';
  }
  return s.trim();
}

// "SUPER MARIOLAND" -> "Super Marioland"
export function prettyTitle(raw) {
  const t = raw.replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
  if (!t) return '';
  return t.toLowerCase().replace(/(^|[\s\-.:'(])([a-z])/g, (m, a, b) => a + b.toUpperCase())
    .replace(/\b(Ii|Iii|Iv|Dx|Gb|Gbc|Vs)\b/g, (m) => m.toUpperCase());
}

export function parseRomHeader(bytes) {
  const cgbFlag = bytes[0x143];
  const cgb = (cgbFlag & 0x80) !== 0;
  const raw = ascii(bytes, 0x134, cgb ? 0x13f : 0x144);
  const oldLic = bytes[0x14b];
  const publisher = oldLic === 0x33
    ? NEW_LICENSEES[String.fromCharCode(bytes[0x144], bytes[0x145])] || ''
    : OLD_LICENSEES[oldLic] || '';
  return {
    type: 'rom',
    rawTitle: raw,
    title: prettyTitle(raw),
    publisher,
    system: cgbFlag === 0xc0 ? 'Game Boy Color' : cgb ? 'Game Boy / Game Boy Color' : 'Game Boy',
    cgb,
    sgb: bytes[0x146] === 3,
    mapper: CART_TYPES[bytes[0x147]] || '?',
    region: bytes[0x14a] === 0 ? 'jp' : 'intl',
    version: bytes[0x14c],
    size: bytes.length,
    checksum: ((bytes[0x14e] << 8) | bytes[0x14f]).toString(16).toUpperCase().padStart(4, '0'),
  };
}
