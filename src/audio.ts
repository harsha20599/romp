// Sound: CC0 samples (Kenney) for effects, an announcer voice, jingles, and a procedural music engine
// whose layers come in as `music.intensity` rises — so the soundtrack builds with your combo.
// Everything is scheduled on the AudioContext clock. Nothing here touches React.
let ctx: AudioContext | undefined, master: DynamicsCompressorNode, musicBus: GainNode, fxBus: GainNode;
export function audio() {
  if (!ctx) {
    ctx = new AudioContext();
    master = ctx.createDynamicsCompressor(); // stops a big combo of overlapping hits from clipping the TV speakers
    master.connect(ctx.destination);
    (musicBus = ctx.createGain()).connect(master);
    (fxBus = ctx.createGain()).connect(master);
    musicBus.gain.value = 0.5;
  }
  return ctx;
}

const buffers = new Map<string, AudioBuffer[]>();
export async function loadAudio() {
  const index: Record<string, string[]> = await (await fetch('/assets/audio.json')).json();
  await Promise.all(Object.entries(index).map(async ([family, files]) => {
    const decoded = await Promise.all(files.map(async (f) => audio().decodeAudioData(await (await fetch(`/assets/${f}`)).arrayBuffer())));
    buffers.set(family, decoded);
  }));
}

// A synth blip: the fallback while samples are still decoding, and handy for pitched feedback (combos rising).
export function blip(freq: number, dur = 0.08, type: OscillatorType = 'sine', at = audio().currentTime, vol = 0.15, bus: AudioNode = fxBus) {
  const o = audio().createOscillator(), g = audio().createGain();
  o.type = type;
  o.frequency.value = freq;
  g.gain.setValueAtTime(vol, at);
  g.gain.exponentialRampToValueAtTime(0.001, at + dur);
  o.connect(g).connect(bus);
  o.start(at);
  o.stop(at + dur);
}

// A swing through the air: filtered noise, swept upward, louder and brighter the harder the swing. Played the instant
// a fast hand is seen — before it has hit anything — so every movement the player makes is answered straight away.
let noise: AudioBuffer | undefined;
function whiteNoise() { // one second of it, shared by the whoosh and the drum kit
  if (!noise) { noise = audio().createBuffer(1, audio().sampleRate, audio().sampleRate); noise.getChannelData(0).forEach((_, i, a) => (a[i] = Math.random() * 2 - 1)); }
  return noise;
}
export function whoosh(power = 0.5) {
  const c = audio(), at = c.currentTime, dur = 0.16;
  const src = c.createBufferSource(), band = c.createBiquadFilter(), g = c.createGain();
  src.buffer = whiteNoise();
  band.type = 'bandpass'; band.Q.value = 1.2;
  band.frequency.setValueAtTime(500 + 500 * power, at);
  band.frequency.exponentialRampToValueAtTime(1800 + 2200 * power, at + dur);
  g.gain.setValueAtTime(0.0001, at);
  g.gain.exponentialRampToValueAtTime(0.1 + 0.22 * power, at + 0.04);
  g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
  src.connect(band).connect(g).connect(fxBus);
  src.start(at); src.stop(at + dur);
}

// Play one of a family's samples at random, slightly re-pitched each time so repeats never sound machine-gunned.
export function sfx(family: string, { vol = 0.8, rate = 1, jitter = 0.08 } = {}) {
  const set = buffers.get(family);
  if (!set) return false;
  const src = audio().createBufferSource(), g = audio().createGain();
  src.buffer = set[Math.floor(Math.random() * set.length)];
  src.playbackRate.value = rate * (1 + (Math.random() * 2 - 1) * jitter);
  g.gain.value = vol;
  src.connect(g).connect(fxBus);
  src.start();
  return src.buffer.duration / rate;
}

// The announcer. Lines queue instead of talking over each other, and the music ducks under her.
let voiceFree = 0;
export function say(...lines: string[]) {
  for (const line of lines) {
    const set = buffers.get(`say_${line}`);
    if (!set) continue;
    const at = Math.max(audio().currentTime, voiceFree), src = audio().createBufferSource(), g = audio().createGain();
    src.buffer = set[0];
    g.gain.value = 1.1;
    src.connect(g).connect(master);
    src.start(at);
    voiceFree = at + set[0].duration + 0.05;
    musicBus.gain.setTargetAtTime(0.2, at, 0.05);
    musicBus.gain.setTargetAtTime(0.5, voiceFree, 0.3);
  }
}
export const jingle = (kind: 'win' | 'level') => sfx(`jingle_${kind}`, { vol: 0.9, jitter: 0 });

// ---- Music -------------------------------------------------------------------------------------------
// 16 steps to the bar, four-bar chord loop. Layers by intensity: 0 kick+hat · .25 bass · .5 snare+arp · .75 pad+16th hats.
const THEMES = {
  run: { bpm: 132, root: 45, chords: [[0, 3, 7], [5, 8, 12], [-4, 0, 3], [-2, 2, 5]], lead: 'square' },
  beat: { bpm: 104, root: 45, chords: [[0, 3, 7], [-4, 0, 3], [-2, 2, 5], [-5, -1, 2]], lead: 'triangle' },
  dance: { bpm: 122, root: 48, chords: [[0, 4, 7], [-3, 0, 4], [5, 9, 12], [7, 11, 14]], lead: 'sawtooth' },
  arcade: { bpm: 116, root: 43, chords: [[0, 3, 7], [3, 7, 10], [-2, 2, 5], [-4, 0, 3]], lead: 'square' },
  calm: { bpm: 96, root: 50, chords: [[0, 4, 7], [-3, 0, 4], [-5, -1, 2], [5, 9, 12]], lead: 'sine' },
} as const;
export type Theme = keyof typeof THEMES;
const hz = (midi: number) => 440 * 2 ** ((midi - 69) / 12);

function hit(at: number, dur: number, vol: number, highpass: number) {
  const src = audio().createBufferSource(), f = audio().createBiquadFilter(), g = audio().createGain();
  src.buffer = whiteNoise();
  f.type = 'highpass';
  f.frequency.value = highpass;
  g.gain.setValueAtTime(vol, at);
  g.gain.exponentialRampToValueAtTime(0.001, at + dur);
  src.connect(f).connect(g).connect(musicBus);
  src.start(at, Math.random() * 0.5, dur + 0.02);
}
function kick(at: number) {
  const o = audio().createOscillator(), g = audio().createGain();
  o.frequency.setValueAtTime(140, at);
  o.frequency.exponentialRampToValueAtTime(42, at + 0.12);
  g.gain.setValueAtTime(0.9, at);
  g.gain.exponentialRampToValueAtTime(0.001, at + 0.22);
  o.connect(g).connect(musicBus);
  o.start(at);
  o.stop(at + 0.25);
}

const m = { theme: null as null | (typeof THEMES)[Theme], start: 0, step: 0, level: 0, target: 0, on: true, timer: 0 };
export const music = {
  get beat() { return m.theme ? 60 / m.theme.bpm : 0.5; },
  // `at` = the audio-clock moment of beat zero, so a game can lock its own timing to the music.
  start(theme: Theme, at = audio().currentTime + 0.1, intensity = 0.3) {
    music.stop();
    Object.assign(m, { theme: THEMES[theme], start: at, step: 0, level: intensity, target: intensity, on: true });
    m.timer = window.setInterval(schedule, 25);
  },
  stop() { clearInterval(m.timer); m.theme = null; },
  intensity(v: number) { m.target = Math.max(0, Math.min(1, v)); },
  gate(on: boolean) { m.on = on; }, // Freeze: the band stops dead, and comes back in
};
function schedule() {
  const t = m.theme;
  if (!t) return;
  const stepLen = 60 / t.bpm / 4;
  for (; m.start + m.step * stepLen < audio().currentTime + 0.12; m.step++) {
    const at = m.start + m.step * stepLen, s = m.step % 16, bar = Math.floor(m.step / 16) % 4, chord = t.chords[bar];
    m.level += (m.target - m.level) * 0.04;
    if (!m.on || at < audio().currentTime) continue;
    const L = m.level;
    if (s % 4 === 0) kick(at);
    if (s % 4 === 2 || (L > 0.75 && s % 2 === 1)) hit(at, 0.04, 0.12, 7000);
    if (L > 0.5 && s % 8 === 4) hit(at, 0.16, 0.35, 1500);
    if (L > 0.25 && (s % 4 === 0 || s % 8 === 6)) blip(hz(t.root - 12 + chord[0]), stepLen * 1.8, 'sawtooth', at, 0.16, musicBus);
    if (L > 0.5) blip(hz(t.root + 12 + chord[[0, 1, 2, 1][s % 4]] + (s % 8 === 7 ? 12 : 0)), stepLen * 0.9, t.lead, at, 0.05, musicBus);
    if (L > 0.75 && s === 0) for (const n of chord) blip(hz(t.root + n), stepLen * 15, 'triangle', at, 0.05, musicBus);
  }
}
