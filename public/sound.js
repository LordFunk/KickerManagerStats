"use strict";

/*
 * Tiny synthesised sound effects (no audio files to download).
 * Browsers only allow audio after the first click or tap, so the audio context
 * is created lazily and resumed on the first interaction.
 */
const Sound = (() => {
  const STORAGE_KEY = "tabletop.muted";
  let ctx = null;
  let muted = false;

  try { muted = localStorage.getItem(STORAGE_KEY) === "1"; } catch { /* storage can be blocked */ }

  function context() {
    if (muted) return null;
    try {
      ctx = ctx || new (window.AudioContext || window.webkitAudioContext)();
      if (ctx.state === "suspended") ctx.resume();
      return ctx;
    } catch {
      return null;
    }
  }

  function tone(c, { freq, at = 0, length = 0.12, type = "sine", volume = 0.09, slideTo = null }) {
    const start = c.currentTime + at;
    const osc = c.createOscillator();
    const gain = c.createGain();

    osc.type = type;
    osc.frequency.setValueAtTime(freq, start);
    if (slideTo) osc.frequency.exponentialRampToValueAtTime(slideTo, start + length);

    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(volume, start + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + length);

    osc.connect(gain).connect(c.destination);
    osc.start(start);
    osc.stop(start + length + 0.02);
  }

  const effects = {
    play: (c) => tone(c, { freq: 520, slideTo: 300, length: 0.09, type: "triangle" }),
    draw: (c) => tone(c, { freq: 260, slideTo: 420, length: 0.1, type: "triangle", volume: 0.07 }),
    turn: (c) => { tone(c, { freq: 660, length: 0.1 }); tone(c, { freq: 880, at: 0.1, length: 0.14 }); },
    uno: (c) => { tone(c, { freq: 700, length: 0.12, type: "square", volume: 0.05 }); tone(c, { freq: 940, at: 0.13, length: 0.2, type: "square", volume: 0.05 }); },
    win: (c) => [523, 659, 784, 1047].forEach((freq, i) => tone(c, { freq, at: i * 0.11, length: 0.2 })),
    round: (c) => { tone(c, { freq: 440, length: 0.14 }); tone(c, { freq: 330, at: 0.15, length: 0.22 }); }
  };

  // Unlock audio on the first interaction.
  const unlock = () => { context(); };
  window.addEventListener("pointerdown", unlock, { once: true });
  window.addEventListener("keydown", unlock, { once: true });

  return {
    play(name) {
      const c = context();
      if (c && effects[name]) effects[name](c);
    },
    get muted() { return muted; },
    toggle() {
      muted = !muted;
      try { localStorage.setItem(STORAGE_KEY, muted ? "1" : "0"); } catch { /* ignore */ }
      if (!muted) this.play("play"); // a small confirmation beep
      return muted;
    }
  };
})();
