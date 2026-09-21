// A chart for Pulse, made from the song itself: every move the player makes is a note they hear. Pulse is played with
// GESTURES, not positions — a note says which hand and which way to swing (or "either way"), a clap, or an arm held
// high; nothing is ever aimed at. Lead melody → swipes (a hand's swipes alternate out / in, the way an arm naturally
// goes back and forth; snare beats go up or down), long notes → holds, the drop's downbeats → claps and double swipes,
// the wind-up → a run that alternates hands, the break → gates for the legs. Pure and deterministic; checked in check.ts.
import { arrange, type Song } from './song.ts';

// dx, dy: the way to swing (unit vector, screen space: +x is screen-right, +y is up); 0, 0 = any way. hand 2 = both.
export type Note = { t: number; kind: 'swipe' | 'clap' | 'hold' | 'duck' | 'lean'; hand: number; dx: number; dy: number; len: number };
const GAP = [0.62, 0.52, 0.42, 0.34, 0.28]; // seconds between notes for one stage: what arms can do, not fingers

export function chart(song: Song, stage: number) {
  const { events, seconds } = arrange(song), spb = 60 / song.bpm, gap = GAP[Math.max(0, Math.min(4, stage - 1))], notes: Note[] = [];
  const free = [-9, -9], out = [1, 1]; // when each hand is next free; whether its next sideways swipe goes outward
  let last = -9, hand = 0, count = 0;
  const put = (t: number, kind: Note['kind'], h: number, dx = 0, dy = 0, len = 0) => { notes.push({ t, kind, hand: h, dx, dy, len }); for (const k of h === 2 ? [0, 1] : [h]) free[k] = t + len + gap * 0.9; last = t; count++; };
  const sideways = (h: number) => { const dir = (h ? 1 : -1) * out[h]; out[h] = -out[h]; return dir; }; // left hand: out = screen-left
  for (const e of events) {
    const t = e.beat * spb, inBar = e.beat % 4;
    if (e.section === 'intro' && e.kind === 'kick' && e.beat >= 8 && e.beat % 2 === 0) { hand = 1 - hand; put(t, 'swipe', hand); } // the first notes teach: one hand, then the other, any way you like
    if (e.section === 'build' && e.kind === 'kick' && t - last >= gap) { hand = 1 - hand; put(t, 'swipe', hand, 0, 1); } // the wind-up: alternate hands, punching upward
    if (e.section === 'break' && e.kind === 'pad') { // the break belongs to the legs
      put(t + 0.001, 'duck', 0); free[0] = free[1] = -9;
      if (stage >= 2) notes.push({ t: t + spb * 2, kind: 'lean', hand: (e.beat / 4) % 2, dx: 0, dy: 0, len: 0 });
    }
    if (e.kind !== 'lead' || t - last < gap * 0.98) continue;
    hand = free[1 - hand] <= t ? 1 - hand : hand; // alternate, unless the other hand is still busy (holding)
    if (free[hand] > t) continue;
    const long = e.len >= 1.4 && stage >= 2, snare = inBar === 1 || inBar === 3, downbeat = e.section === 'drop' && inBar === 0 && stage >= 2 && free[1 - hand] <= t;
    if (long) put(t, 'hold', hand, 0, 1, Math.min(1.5, e.len * spb * 0.9));
    else if (downbeat && count % 3 === 0) put(t, 'clap', 2);
    else if (downbeat) { put(t, 'swipe', 0, sideways(0), 0); put(t, 'swipe', 1, sideways(1), 0); } // both arms at once on the big beats, each the way it is ready to go
    else if (stage === 1 && !snare) put(t, 'swipe', hand);
    else if (snare) put(t, 'swipe', hand, 0, count % 2 ? 1 : -1);
    else put(t, 'swipe', hand, sideways(hand), 0);
  }
  return { notes: notes.sort((a, b) => a.t - b.t), seconds, spb };
}
