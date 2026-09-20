// Songs, written as data and played by a small synthesiser — so a rhythm game can be charted from the very notes the
// player hears (the chart cannot drift from the music: it IS the music), nothing is downloaded, and nothing is licensed.
// Synthwave kit: kick, snare, hats, a filtered saw bass, a slow pad, an arpeggio, a lead with vibrato; the pad, bass and
// arp duck under every kick (the "pump"), lead and snare go to a tempo delay and a generated reverb.
// Everything is scheduled on the AudioContext clock a little ahead of time, so pausing the context pauses the song.
import { audio, musicOut } from './audio.ts';

export type Section = 'intro' | 'verse' | 'build' | 'drop' | 'break' | 'outro';
export type SongEvent = { beat: number; kind: 'kick' | 'snare' | 'hat' | 'bass' | 'pad' | 'arp' | 'lead'; semi: number; len: number; section: Section };
type Motif = [step: number, note: number, len: number][]; // 16th-note steps across two bars; note = index into the pentatonic ladder
export type Song = { id: string; name: string; bpm: number; root: number; chords: number[][]; verse: Motif; drop: Motif; alt: Motif };
const LADDER = [0, 3, 5, 7, 10, 12, 15, 17, 19, 22, 24]; // minor pentatonic, two octaves: every note sits over every chord here
const FORM: [Section, number][] = [['intro', 4], ['verse', 8], ['build', 4], ['drop', 8], ['break', 4], ['drop', 8], ['outro', 2]];

export const SONGS: Song[] = [
  { id: '', name: 'Neon Drive', bpm: 112, root: 57, chords: [[0, 3, 7], [-4, 0, 3], [3, 7, 10], [-2, 2, 5]],
    verse: [[0, 3, 3], [4, 4, 2], [6, 5, 2], [8, 4, 4], [14, 3, 2], [16, 2, 3], [20, 3, 2], [22, 4, 2], [24, 3, 6]],
    drop: [[0, 5, 2], [2, 6, 2], [4, 7, 4], [8, 6, 2], [10, 5, 2], [12, 4, 4], [16, 5, 2], [18, 6, 2], [20, 8, 4], [24, 7, 2], [26, 6, 2], [28, 5, 4]],
    alt: [[0, 7, 6], [8, 6, 2], [10, 7, 2], [12, 8, 4], [16, 9, 6], [24, 8, 2], [26, 7, 2], [28, 5, 4]] },
  { id: 'afterglow', name: 'Afterglow', bpm: 124, root: 54, chords: [[0, 3, 7], [-2, 2, 5], [-4, 0, 3], [-2, 2, 5]],
    verse: [[0, 4, 2], [2, 3, 2], [4, 4, 4], [10, 2, 2], [12, 3, 4], [16, 4, 2], [18, 5, 2], [20, 4, 4], [26, 3, 2], [28, 2, 4]],
    drop: [[0, 7, 1], [1, 7, 1], [2, 8, 2], [4, 7, 4], [8, 5, 2], [10, 6, 2], [12, 7, 4], [16, 8, 1], [17, 8, 1], [18, 9, 2], [20, 8, 4], [24, 7, 2], [26, 5, 2], [28, 6, 4]],
    alt: [[0, 9, 4], [4, 8, 4], [8, 7, 4], [12, 8, 4], [16, 9, 2], [18, 8, 2], [20, 7, 4], [24, 5, 8]] },
  { id: 'hyperline', name: 'Hyperline', bpm: 138, root: 50, chords: [[0, 3, 7], [3, 7, 10], [-2, 2, 5], [-4, 0, 3]],
    verse: [[0, 2, 2], [2, 3, 2], [4, 4, 2], [6, 3, 2], [8, 4, 4], [12, 5, 4], [16, 4, 2], [18, 3, 2], [20, 2, 2], [22, 3, 2], [24, 4, 8]],
    drop: [[0, 7, 2], [2, 5, 2], [4, 7, 2], [6, 8, 2], [8, 9, 4], [12, 8, 2], [14, 7, 2], [16, 7, 2], [18, 5, 2], [20, 7, 2], [22, 8, 2], [24, 10, 4], [28, 9, 2], [30, 8, 2]],
    alt: [[0, 10, 2], [2, 9, 2], [4, 8, 2], [6, 7, 2], [8, 8, 8], [16, 9, 2], [18, 8, 2], [20, 7, 2], [22, 5, 2], [24, 7, 8]] },
];

// Every sound of the song, in beats from its start. Also what a chart is built from.
export function arrange(song: Song) {
  const events: SongEvent[] = [], add = (beat: number, kind: SongEvent['kind'], semi = 0, len = 0.25, section: Section = 'intro') => events.push({ beat, kind, semi, len, section });
  let bar = 0, drops = 0;
  for (const [section, bars] of FORM) {
    if (section === 'drop') drops++;
    for (let b = 0; b < bars; b++, bar++) {
      const at = bar * 4, chord = song.chords[bar % 4], last = b === bars - 1, drums = section === 'verse' || section === 'drop' || (section === 'intro' && b >= 2);
      if (section !== 'outro' || b === 0) add(at, 'pad', 0, 4, section);
      for (let s = 0; s < 16; s++) {
        const beat = at + s / 4;
        if (drums && s % 4 === 0) add(beat, 'kick', 0, 0.25, section);
        if (section === 'intro' && b < 2 && s % 8 === 0) add(beat, 'kick', 0, 0.25, section);
        if ((section === 'verse' || section === 'drop') && s % 8 === 4) add(beat, 'snare', 0, 0.25, section);
        if (section === 'build') { if (s % (b < 2 ? 4 : b < 3 ? 2 : 1) === 0) add(beat, 'snare', b * 4 + s, 0.25, section); if (b < 3 && s % 4 === 0) add(beat, 'kick', 0, 0.25, section); } // the roll that winds up the drop
        if (section !== 'break' && section !== 'outro' && (s % 2 === 0 || section === 'drop')) add(beat, 'hat', s % 4 === 2 ? 1 : 0, 0.25, section);
        if (section !== 'intro' || b >= 2) { if (section === 'drop' ? s % 2 === 0 : s % 4 === 0 || s % 8 === 6) add(beat, 'bass', chord[0] - 24, section === 'drop' ? 0.4 : 0.7, section); }
        if (section === 'build' || section === 'break' || section === 'drop') add(beat, 'arp', chord[[0, 1, 2, 1][s % 4]] + (s % 8 >= 4 ? 12 : 0) + (section === 'build' ? b * 2 : 0), 0.22, section);
      }
      if ((section === 'verse' || section === 'drop') && b % 2 === 0) {
        const motif = section === 'verse' ? song.verse : drops === 2 && b % 4 === 0 ? song.alt : song.drop;
        for (const [step, note, len] of motif) add(at + step / 4, 'lead', LADDER[note] + (section === 'drop' ? 12 : 0), len / 4, section);
      }
      if (section === 'drop' && last) add(at + 3.5, 'snare', 0, 0.25, section);
    }
  }
  return { events: events.sort((a, b) => a.beat - b.beat), beats: bar * 4, seconds: (bar * 4 * 60) / song.bpm };
}

const hz = (midi: number) => 440 * 2 ** ((midi - 69) / 12);
let rig: { out: GainNode; pump: GainNode; wet: GainNode; echo: GainNode; noise: AudioBuffer } | null = null;
function desk(bpm: number) {
  const ctx = audio();
  if (!rig) {
    const out = ctx.createGain(), pump = ctx.createGain(), wet = ctx.createGain(), echo = ctx.createGain(), verb = ctx.createConvolver(), delay = ctx.createDelay(1), back = ctx.createGain();
    const tail = ctx.createBuffer(2, ctx.sampleRate * 2.2, ctx.sampleRate), noise = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) { const d = tail.getChannelData(ch); for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / d.length) ** 3; } // a generated room: noise that dies away
    const nd = noise.getChannelData(0); for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1;
    verb.buffer = tail; wet.gain.value = 0.22; back.gain.value = 0.34; echo.gain.value = 0.3;
    out.connect(musicOut()); pump.connect(out); wet.connect(verb).connect(out); echo.connect(delay); delay.connect(back).connect(delay); delay.connect(out);
    rig = { out, pump, wet, echo, noise };
    (rig as unknown as { delay: DelayNode }).delay = delay;
  }
  (rig as unknown as { delay: DelayNode }).delay.delayTime.value = (60 / bpm) * 0.75; // a dotted-eighth echo, in time
  rig.out.gain.cancelScheduledValues(0); rig.out.gain.value = 0.95; // (the last song faded this out)
  return rig;
}
function voice(kind: SongEvent['kind'], at: number, midi: number, dur: number, r: NonNullable<typeof rig>, level: number) {
  const ctx = audio(), g = ctx.createGain(), osc = (type: OscillatorType, f: number, detune = 0) => { const o = ctx.createOscillator(); o.type = type; o.frequency.value = f; o.detune.value = detune; o.start(at); o.stop(at + dur + 0.4); return o; };
  const burst = (len: number) => { const n = ctx.createBufferSource(); n.buffer = r.noise; n.start(at, Math.random() * 0.5, len); return n; };
  if (kind === 'kick') {
    const o = osc('sine', 150); o.frequency.exponentialRampToValueAtTime(44, at + 0.11); g.gain.setValueAtTime(1.0 * level, at); g.gain.exponentialRampToValueAtTime(0.001, at + 0.26); o.connect(g).connect(r.out);
    r.pump.gain.cancelScheduledValues(at); r.pump.gain.setValueAtTime(0.32, at); r.pump.gain.linearRampToValueAtTime(1, at + 0.24); // everything else ducks: the pump
  } else if (kind === 'snare') {
    const f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = 1900; f.Q.value = 0.7; g.gain.setValueAtTime(0.5 * level, at); g.gain.exponentialRampToValueAtTime(0.001, at + 0.19);
    burst(0.2).connect(f).connect(g); const o = osc('triangle', 190); const og = ctx.createGain(); og.gain.setValueAtTime(0.35 * level, at); og.gain.exponentialRampToValueAtTime(0.001, at + 0.1); o.connect(og).connect(r.out); g.connect(r.out); g.connect(r.wet);
  } else if (kind === 'hat') {
    const f = ctx.createBiquadFilter(); f.type = 'highpass'; f.frequency.value = 8000; g.gain.setValueAtTime((midi ? 0.16 : 0.09) * level, at); g.gain.exponentialRampToValueAtTime(0.001, at + (midi ? 0.09 : 0.035)); burst(0.1).connect(f).connect(g).connect(r.out);
  } else if (kind === 'bass') {
    const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.Q.value = 6; f.frequency.setValueAtTime(900, at); f.frequency.exponentialRampToValueAtTime(160, at + dur);
    g.gain.setValueAtTime(0.34 * level, at); g.gain.setValueAtTime(0.34 * level, at + dur * 0.7); g.gain.linearRampToValueAtTime(0, at + dur); osc('sawtooth', hz(midi)).connect(f); osc('square', hz(midi - 12)).connect(f); f.connect(g).connect(r.pump);
  } else if (kind === 'pad') {
    const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 1400; g.gain.setValueAtTime(0, at); g.gain.linearRampToValueAtTime(0.085 * level, at + 0.6); g.gain.setValueAtTime(0.085 * level, at + dur - 0.3); g.gain.linearRampToValueAtTime(0, at + dur + 0.3);
    for (const d of [-9, 0, 8]) osc('sawtooth', hz(midi), d).connect(f); f.connect(g); g.connect(r.pump); g.connect(r.wet);
  } else if (kind === 'arp') {
    const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 2600; f.Q.value = 3; g.gain.setValueAtTime(0.10 * level, at); g.gain.exponentialRampToValueAtTime(0.001, at + dur); osc('square', hz(midi)).connect(f).connect(g); g.connect(r.pump); g.connect(r.echo);
  } else {
    const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.setValueAtTime(5200, at); f.frequency.exponentialRampToValueAtTime(1800, at + dur + 0.1); f.Q.value = 2;
    g.gain.setValueAtTime(0, at); g.gain.linearRampToValueAtTime(0.17 * level, at + 0.012); g.gain.setValueAtTime(0.15 * level, at + dur * 0.8); g.gain.linearRampToValueAtTime(0, at + dur + 0.08);
    const a = osc('sawtooth', hz(midi), -6), b = osc('sawtooth', hz(midi), 7), lfo = osc('sine', 5.5), depth = ctx.createGain(); depth.gain.value = dur > 0.4 ? 9 : 0; lfo.connect(depth); depth.connect(a.detune); depth.connect(b.detune); // long notes sing
    a.connect(f); b.connect(f); f.connect(g); g.connect(r.out); g.connect(r.echo); g.connect(r.wet);
  }
}

// Play `song` with beat zero at audio-clock time `at`. Returns the clock (beats now) and a stop.
export function play(song: Song, at: number) {
  const { events } = arrange(song), beat = 60 / song.bpm, r = desk(song.bpm);
  let next = 0;
  const timer = window.setInterval(() => {
    const now = audio().currentTime;
    for (; next < events.length && at + events[next].beat * beat < now + 0.18; next++) {
      const e = events[next], when = at + e.beat * beat;
      if (when < now - 0.02) continue; // a stall: skip what is already past, never bunch it up
      const chordy = e.kind === 'pad';
      if (chordy) for (const semi of song.chords[Math.floor(e.beat / 4) % 4]) voice('pad', when, song.root + semi, e.len * beat, r, 1);
      else voice(e.kind, when, song.root + e.semi, e.len * beat, r, e.kind === 'snare' && e.section === 'build' ? 0.4 + Math.min(0.6, e.semi / 16) : 1);
    }
  }, 25);
  return { beats: () => (audio().currentTime - at) / beat, stop: () => { clearInterval(timer); if (rig) { rig.out.gain.cancelScheduledValues(0); rig.out.gain.setTargetAtTime(0, audio().currentTime, 0.08); } } };
}
