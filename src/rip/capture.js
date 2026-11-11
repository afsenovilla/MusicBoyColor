// Capture a song as data instead of audio: the timed list of sound-register
// writes. This is the rawest faithful form of the music (it is what VGM
// stores) and the input for the MIDI conversion.

import { CLOCK_RATE } from '../core/apu.js';

// How many driver ticks of register data describe the whole song once.
export function dataTicks(player, info, loops = 1) {
  return info.looping ? info.loopStart + info.loopLen * loops : info.endTick + Math.ceil(player.tps);
}

// Returns { events: [{ t (seconds), reg (0xFF10..0xFF3F), val }], seconds }.
// The list starts with the register state at the first instant (triggers
// masked), so a player starting from a blank chip reproduces the song exactly.
export function capture(player, id, ticks, skipTicks = 0) {
  const gb = player.gb;
  const events = [];
  let start = 0, live = false;
  const skipDots = skipTicks * player.tickDots;
  player.onLoaded = () => {
    const regs = gb.apu.regs;
    const push = (r, val) => events.push({ t: 0, reg: 0xff10 + r, val });
    push(0x16, gb.apu.power ? 0x80 : 0);
    for (let r = 0x20; r < 0x30; r++) push(r, regs[r]);
    for (let r = 0; r < 0x16; r++) {
      if (r === 5 || r === 0xf) continue;
      const trig = r === 4 || r === 9 || r === 0xe || r === 0x13;
      push(r, trig ? regs[r] & 0x7f : regs[r]);
    }
    start = gb.clock;
    live = true;
  };
  player.hook = (reg, val) => {
    if (!live) return;
    events.push({ t: Math.max(0, gb.clock - start - skipDots) / CLOCK_RATE, reg, val });
  };
  try {
    if (!player.start(id)) return null;
    start = gb.clock;
    for (let n = 0; n < ticks; n++) player.tick();
  } finally {
    player.onLoaded = null; player.hook = null; gb.onApu = null;
  }
  return { events, seconds: Math.max(0, ticks - skipTicks) / player.tps };
}
