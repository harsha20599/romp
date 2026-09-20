// What every game shares: the round clock, sound, the players' hands, bursts, and the small geometry of hit-testing.
// (The React shell that mounts a game lives in stage.tsx; nothing here touches React.)
import type { Entity, GraphNode } from 'playcanvas';
import { players, predict, sim, track, tuning } from './pose.ts';
import { blip, say, sfx, whoosh } from './audio.ts';
import { H, W, flat, instanced, node, ribbon, shapes, show, type Scene, type View } from './engine.ts';
export { audio, blip, jingle, music, say, sfx, whoosh } from './audio.ts';
export { H, W, hitStop } from './engine.ts';
export { PLAYER_COLORS } from './pace.ts';
import { PLAYER_COLORS } from './pace.ts';

export const COUNTDOWN = 3;
// `stage` is the difficulty stage (1–5); games scale themselves with hardness(stage) from meta.ts.
export type GameProps = { n: number; stage: number; onEnd: (scores: number[]) => void };
type HudKey = 'clock' | 'big' | 's0' | 's1' | 'h0' | 'h1';
export type Hud = ((key: HudKey, text: string) => void) & { flash: (color: string) => void; shake: (amount?: number) => void; p: (kind: 's' | 'h', p: number, text: string) => void };

// A game is a module: `build` makes the scene and returns the function to run every frame (dt in seconds, already
// slowed during a hit-stop). An optional `view` asks for a perspective camera; the default is the flat 16×9 stage.
export type Game = GameProps & { hud: Hud; scene: Scene; cleanup: (fn: () => void) => void };
export type GameModule = { default: (game: Game) => Promise<(dt: number) => void> | ((dt: number) => void); view?: View };

// How long ago the player actually did what the game is only now seeing: measured frame-to-tracker age, plus the
// measured delay the page cannot see (camera pipeline + screen). Timing games judge against the past by this much.
export const inputLag = () => (sim ? 0 : Math.max(0.06, Math.min(0.4, track.lag / 1000 + tuning.unseen)));

// A player's zone on the orthographic stage: the whole width solo, a half each together.
export const zoneHalf = (n: number) => W / 2 / n;
export const zoneX = (n: number, p: number) => (n === 1 ? 0 : (p - 0.5) * (W / 2));

// Top clock, plus a big 3-2-1-Go in the middle of the stage.
let lastCue = '';
export function countdown(hud: Hud, t: number, length: number) {
  const left = Math.ceil(t < 0 ? -t : length - t), cue = t < 0 ? String(left) : t < 0.7 ? 'go' : length - t <= 10 ? `end${left}` : '';
  hud('clock', String(left));
  hud('big', t < 0 ? String(left) : t < 0.7 ? 'Go!' : '');
  if (cue === lastCue) return;
  lastCue = cue;
  if (t < 0 || cue === 'go') say(cue); // the announcer counts you in: "3, 2, 1, go"
  else if (left === 10) say('hurry_up');
  else if (cue && left <= 5) sfx('tick', { vol: 0.6, jitter: 0 }) || blip(1000, 0.04);
}

// Call the returned tick(dt) once per frame: seconds into the round (negative during the countdown), or null once over.
export function round(hud: Hud, length: number, finish: () => void) {
  const g = { t: -COUNTDOWN, done: false };
  return (dt: number) => {
    if (g.done) return null;
    g.t += Math.min(dt, 0.05);
    countdown(hud, g.t, length);
    if (g.t < length) return g.t;
    g.done = true;
    say('time_over');
    finish();
    return null;
  };
}

export const scoreHud = (hud: Hud, n: number, scores: number[]) => {
  for (let p = 0; p < n; p++) hud.p('s', p, players[p].present ? String(Math.round(scores[p])) : 'Step into view');
};
export const comboText = (combo: number) => (combo >= 5 ? `Combo ×${combo}` : '');

// Rising pitch with the combo is the oldest trick in the book, and it works: a sample for body, a blip for the climb.
export function hitSound(family: string, combo = 0, vol = 0.8) {
  sfx(family, { vol, rate: 1 + Math.min(combo, 12) * 0.03 });
  if (combo >= 3) blip(440 * 2 ** (Math.min(combo, 24) / 12), 0.07, 'triangle', undefined, 0.06);
}

// The line down the middle when two play side by side.
export const divider = (scene: Scene, n: number, hex = '#3f3f46', z = 0, width = 0.04) => { if (n === 2) node(scene.root, shapes.quad(width, H), flat(hex), [0, 0, z]); };

// Particle bursts: one instanced draw for the whole game, however many hits happen at once.
const MAX_BITS = 240;
export function bursts(parent: GraphNode) {
  const mesh = instanced(parent, shapes.facets(0.11), MAX_BITS), bits = Array.from({ length: MAX_BITS }, () => ({ life: 0, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0 }));
  let at = 0;
  const burst = (x: number, y: number, z: number, color: string, count = 14, speed = 6) => {
    for (let k = 0; k < count; k++) {
      const i = (at = (at + 1) % MAX_BITS), a = Math.random() * Math.PI * 2, v = speed * (0.4 + Math.random() * 0.6);
      Object.assign(bits[i], { life: 0.5 + Math.random() * 0.3, x, y, z, vx: Math.cos(a) * v, vy: Math.sin(a) * v + 2, vz: (Math.random() - 0.5) * v });
      mesh.paint(i, color);
    }
  };
  const update = (dt: number) => {
    bits.forEach((bit, i) => {
      if (bit.life > 0) { bit.life -= dt; bit.vy -= 12 * dt; bit.x += bit.vx * dt; bit.y += bit.vy * dt; bit.z += bit.vz * dt; }
      mesh.place(i, bit.x, bit.y, bit.z, Math.max(0, bit.life) * 2);
    });
    mesh.commit();
  };
  return { burst, update };
}

// Hands on the stage: a cursor and a tapering ribbon each. `update(dt)` moves them and returns where they are.
const TRAIL = 12, SPAN = 5;
export type StageHand = { p: number; x: number; y: number; px: number; py: number; speed: number; on: boolean; pts: Float32Array };

// `map` places the zones; the default is the orthographic stage split into n columns.
export type HandMap = { cx: (p: number) => number; hw: number; hh: number; cy?: number };
// `swing`: hand speed (stage units/s) that earns a whoosh the moment it is reached; 0 = silent hands.
export function hands(scene: Scene, n: number, map: HandMap = { cx: (p) => zoneX(n, p), hw: zoneHalf(n), hh: H / 2 }, swing = 6) {
  const ball = shapes.sphere(0.18, 10);
  const all = Array.from({ length: n * 2 }, (_, i) => {
    const hex = PLAYER_COLORS[i >> 1], trail = ribbon(scene.root, TRAIL, flat(hex, { opacity: 0.7, twoSided: true })), cursor: Entity = node(scene.root, ball, flat(hex));
    const pts = new Float32Array(TRAIL * 2);
    return { trail, cursor, pts, age: new Float32Array(TRAIL), armed: true, state: { p: i >> 1, x: 0, y: 0, px: 0, py: 0, speed: 0, on: false, pts } as StageHand };
  });
  const update = (dt: number) =>
    all.map((own, i) => {
      const { trail, cursor, pts, age, state: s } = own;
      const hand = players[s.p].hands[i & 1], was = s.on;
      s.on = players[s.p].present && hand.seen;
      show(trail.entity, s.on); show(cursor, s.on);
      if (!s.on) return s;
      // The camera updates ~30x a second, the screen 60x: glide toward the latest reading so motion is continuous,
      // and take speed from the tracker (measured at camera rate) — never from per-frame screen deltas.
      // …and the reading is already old when it arrives, so aim at where the hand is by now (pose.ts predict).
      const at = predict(hand), tx = map.cx(s.p) + at.x * map.hw, ty = (map.cy ?? 0) + at.y * map.hh, k = was ? 1 - Math.exp(-dt * 45) : 1;
      s.px = was ? s.x : tx;
      s.py = was ? s.y : ty;
      s.x = s.px + (tx - s.px) * k;
      s.y = s.py + (ty - s.py) * k;
      cursor.setLocalPosition(s.x, s.y, 1);
      if (was) { pts.copyWithin(2, 0, (TRAIL - 1) * 2); age.copyWithin(1, 0, TRAIL - 1); for (let k = 1; k < TRAIL; k++) age[k] += dt; }
      else for (let k = 0; k < TRAIL; k++) { pts.set([s.x, s.y], k * 2); age[k] = k ? 1 : 0; }
      pts.set([s.x, s.y], 0);
      age[0] = 0;
      // Speed: the tracker's own estimate is steady but slow off the mark (it is low-passed, ~60ms) — a swing was
      // through the fruit before it "counted" as fast. So also measure straight across the last few drawn positions
      // (net distance, so jitter around a still hand reads as nothing) and believe whichever is higher.
      const across = Math.hypot(pts[0] - pts[2 * SPAN], pts[1] - pts[2 * SPAN + 1]) / Math.max(0.03, age[SPAN]);
      s.speed = Math.max(Math.hypot(hand.vx * map.hw, hand.vy * map.hh), age[SPAN] < 0.25 ? across : 0);
      if (swing && own.armed && s.speed > swing) { own.armed = false; whoosh(Math.min(1, s.speed / swing / 3)); }
      else if (s.speed < swing * 0.5) own.armed = true; // one whoosh per swing: re-arms only once the hand has slowed right down
      const pos = trail.positions;
      for (let k = 0; k < TRAIL; k++) {
        const a = Math.max(k - 1, 0) * 2, b = Math.min(k + 1, TRAIL - 1) * 2;
        const dx = pts[b] - pts[a], dy = pts[b + 1] - pts[a + 1], len = Math.hypot(dx, dy) || 1, w = 0.16 * (1 - k / TRAIL);
        pos.set([pts[2 * k] - (dy / len) * w, pts[2 * k + 1] + (dx / len) * w, 0.9, pts[2 * k] + (dy / len) * w, pts[2 * k + 1] - (dx / len) * w, 0.9], k * 6);
      }
      trail.commit();
      return s;
    });
  return { update };
}

// Did this hand's recent path pass within r of (x, y)? Looks back over the last few drawn positions (~100ms), not
// just this frame's step: a hand is often through the target a moment before it registers as "fast enough", and the
// player rightly feels that as a hit. Forgiving on purpose — use segDist on the last step alone for things to avoid.
export function swept(h: StageHand, x: number, y: number, r: number, steps = 6) {
  for (let k = 0; k < steps; k++) if (segDist(x, y, h.pts[2 * k + 2], h.pts[2 * k + 3], h.pts[2 * k], h.pts[2 * k + 1]) <= r) return true;
  return false;
}

// Distance from point p to segment a→b — "did this swing pass through that thing".
export function segDist(px: number, py: number, ax: number, ay: number, bx: number, by: number) {
  const dx = bx - ax, dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy || 1)));
  return Math.hypot(px - ax - t * dx, py - ay - t * dy);
}
