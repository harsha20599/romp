// A chart for Pulse, made from the song itself: every note the player hits is a note they hear (lead melody → orbs,
// slashes and rails; the wind-up → a climbing run; the break → gates for the legs). Pure and deterministic, so it is
// checked in check.ts: spacing a human can play at each stage, everything within reach, hands sharing the work.
// Positions are in zone units (-1..1 across and up the player's reach), like hands in pose.ts.
import { arrange, type Song } from './song.ts';

export type Note = { t: number; kind: 'orb' | 'slash' | 'rail' | 'duck' | 'lean'; hand: number; x: number; y: number; dx: number; dy: number; len: number; x2: number; y2: number };
const GAP = [0.6, 0.5, 0.4, 0.32, 0.26]; // seconds between notes for one stage: what a body can do, not what fingers can
const SLASH = [[-1, 0], [-0.7, -0.7], [0, -1], [-0.7, 0.7]]; // for the left hand; mirrored for the right: out, out-and-down, down, out-and-up

export function chart(song: Song, stage: number) {
  const { events, seconds } = arrange(song), spb = 60 / song.bpm, gap = GAP[Math.max(0, Math.min(4, stage - 1))], notes: Note[] = [];
  const leads = events.filter((e) => e.kind === 'lead'), lo = Math.min(...leads.map((e) => e.semi)), hi = Math.max(...leads.map((e) => e.semi));
  const free = [-9, -9]; // when each hand is next free
  let last = -9, hand = 0, count = 0;
  const place = (semi: number, h: number, k: number) => ({ x: (h ? 1 : -1) * (0.28 + 0.5 * ((k * 0.618) % 1)), y: -0.3 + 1.05 * ((semi - lo) / Math.max(1, hi - lo)) });
  const put = (n: Partial<Note> & { t: number; kind: Note['kind']; hand: number; x: number; y: number }) => { notes.push({ dx: 0, dy: 0, len: 0, x2: n.x, y2: n.y, ...n }); free[n.hand] = n.t + (n.len ?? 0) + gap * 0.9; last = n.t; count++; };
  for (const e of events) {
    const t = e.beat * spb, inBar = e.beat % 4;
    if (e.section === 'intro' && e.kind === 'kick' && e.beat >= 8 && e.beat % 2 === 0) { hand = 1 - hand; put({ t, kind: 'orb', hand, x: hand ? 0.45 : -0.45, y: 0.1 + 0.25 * ((e.beat / 2) % 2) }); } // the first notes teach: one hand, then the other
    if (e.section === 'build' && e.kind === 'kick' && t - last >= gap) { hand = 1 - hand; const rise = (e.beat % 16) / 16; put({ t, kind: 'orb', hand, x: (hand ? 1 : -1) * (0.65 - 0.3 * rise), y: -0.3 + 1.0 * rise }); } // a run that climbs with the snare roll
    if (e.section === 'break' && e.kind === 'pad') { // the break belongs to the legs
      put({ t: t + spb * 0.001, kind: 'duck', hand: 0, x: 0, y: 0 }); free[0] = free[1] = -9;
      if (stage >= 2) notes.push({ t: t + spb * 2, kind: 'lean', hand: (e.beat / 4) % 2, x: 0, y: 0, dx: 0, dy: 0, len: 0, x2: 0, y2: 0 });
    }
    if (e.kind !== 'lead' || t - last < gap * 0.98) continue;
    hand = free[1 - hand] <= t ? 1 - hand : hand; // alternate, unless the other hand is still busy (on a rail)
    if (free[hand] > t) continue;
    const at = place(e.semi, hand, count), long = e.len >= 1.4 && stage >= 2, snare = inBar === 1 || inBar === 3;
    if (long) { const to = place(e.semi + (count % 2 ? 5 : -4), hand, count + 3); put({ t, kind: 'rail', hand, ...at, len: Math.min(1.5, e.len * spb * 0.9), x2: to.x, y2: Math.max(-0.3, Math.min(0.75, to.y)) }); }
    else if (snare) { const d = SLASH[count % SLASH.length]; put({ t, kind: 'slash', hand, ...at, dx: d[0] * (hand ? -1 : 1), dy: d[1] }); }
    else put({ t, kind: 'orb', hand, ...at });
    // On the drop's downbeats both hands land together: the big moments of the song are the big moves of the body.
    if (e.section === 'drop' && inBar === 0 && stage >= 2 && !long && free[1 - hand] <= t) put({ t, kind: 'orb', hand: 1 - hand, x: -at.x, y: at.y });
  }
  return { notes: notes.sort((a, b) => a.t - b.t), seconds, spb };
}
