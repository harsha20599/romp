// What every game shares: the round clock, sound, the players' hands, bursts, and the small geometry of hit-testing.
// (The React shell that mounts a game lives in stage.tsx; nothing here touches React.)
import type { Entity, GraphNode } from 'playcanvas';
import { cutout, players, predict, sim, track, tuning, wantCutout } from './pose.ts';
import { CUT } from './cut.ts';
import { blip, say, sfx, whoosh } from './audio.ts';
import { H, W, cutoutLook, feedUnit, flat, glowLook, instanced, node, mirrorOn, refreshCutouts, ribbon, shapes, show, trailLook, type Scene, type View } from './engine.ts';
export { audio, blip, jingle, music, say, sfx, whoosh } from './audio.ts';
export { H, W, hitStop } from './engine.ts';
export { PLAYER_COLORS } from './pace.ts';
import { PLAYER_COLORS } from './pace.ts';

export const COUNTDOWN = 3;
// `stage` is the difficulty stage (1–5); games scale themselves with hardness(stage) from meta.ts.
// `mode` is one of the game's own modes ('' when it has none). `team`: two players, one shared score (the game must
// then end with the same score for both). `best`: the score to beat, for this player, game, mode and stage.
// `notes` handed to onEnd are one short list per player of what stood out ("Best slash: 5 fruit") for the results screen.
export type GameProps = { n: number; stage: number; mode: string; team: boolean; best: number; onEnd: (scores: number[], notes?: string[][]) => void };
type HudKey = 'clock' | 'big' | 's0' | 's1' | 'h0' | 'h1';
export type Hud = ((key: HudKey, text: string) => void) & {
  flash: (color: string) => void; shake: (amount?: number) => void; p: (kind: 's' | 'h', p: number, text: string) => void;
  banner: (text: string, ms?: number) => void; // a line across the middle of the stage: a twist, a power-up, "New best!"
  pop: (x: number, y: number, text: string, color?: string, z?: number) => void; // a word that rises from a point in the scene and fades
};

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
  if (isFinite(length)) hud('clock', String(left)); // an endless round (length = Infinity) owns the clock face itself: lives, say
  hud('big', t < 0 ? String(left) : t < 0.7 ? 'Go!' : '');
  if (cue === lastCue) return;
  lastCue = cue;
  if (t < 0 || cue === 'go') say(cue); // the announcer counts you in: "3, 2, 1, go"
  else if (left === 10) say('hurry_up');
  else if (cue && left <= 5) sfx('tick', { vol: 0.6, jitter: 0 }) || blip(1000, 0.04);
}

// Call the returned tick(dt) once per frame: seconds into the round (negative during the countdown), or null once over.
// `extra` seconds of overtime after the clock reaches zero are the game's finale: t keeps counting past `length`.
export function round(hud: Hud, length: number, finish: () => void, extra = 0) {
  const g = { t: -COUNTDOWN, done: false };
  return (dt: number) => {
    if (g.done) return null;
    g.t += Math.min(dt, 0.05);
    countdown(hud, Math.min(g.t, length), length);
    if (g.t < length + extra) return g.t;
    g.done = true;
    say('time_over');
    finish();
    return null;
  };
}

export const scoreHud = (hud: Hud, n: number, scores: number[]) => {
  for (let p = 0; p < n; p++) hud.p('s', p, players[p].present ? String(Math.round(scores[p])) : 'Step into view');
};
// The score to beat. Call the returned function with the running score: the moment it passes the old best (once per
// round, and only if there was one), the stage says so — beating yourself should be felt while it happens, not read afterwards.
export function bestLine(hud: Hud, best: number) {
  let told = best <= 0;
  return (score: number) => {
    if (told || score <= best) return;
    told = true;
    hud.banner('New best!', 1600); hud.flash('#fde047'); sfx('powerUp', { vol: 0.7 }); say('new_highscore');
  };
}
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
  // Glass hands: a bead of light with a halo in the player's colour, and a trail that is brightest at the hand and
  // fades to nothing — light, not paint, so fast hands never hide what they are about to hit.
  const bead = shapes.quad(2, 2);
  const all = Array.from({ length: n * 2 }, (_, i) => {
    const hex = PLAYER_COLORS[i >> 1], trail = ribbon(scene.root, TRAIL, trailLook(hex)), cursor: Entity = node(scene.root, bead, glowLook(hex));
    cursor.setLocalScale(1, 1, 1);
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
      const swell = 0.95 + Math.min(0.7, s.speed * 0.04); // a fast hand burns brighter
      cursor.setLocalScale(swell, swell, 1);
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
        const dx = pts[b] - pts[a], dy = pts[b + 1] - pts[a + 1], len = Math.hypot(dx, dy) || 1, w = (0.2 + Math.min(0.22, s.speed * 0.018)) * (1 - (k / TRAIL) * 0.85);
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

// The player's whole body on the stage, for games played with more than hands. Two looks, one interface:
//  · their own picture, lifted out of the room and lit in their colour (or the same shape as a glowing shadow) —
//    drawn from the tracker's person mask, so it is only there on devices and routes that can make one;
//  · a drawn character built on the skeleton — round limbs with an outline, gloves, shoes, a face that looks where
//    the action is and puffs when you work. It needs nothing but the landmarks, so it is also what ?sim shows.
// Either way the "pads" — the parts that can touch things (hands, head, elbows, knees, feet), in stage units — come
// from the same rig, so a game never knows which look is on. `at` is where the middle of the shoulders sits;
// `scale` is stage units per shoulder-width (1.2 fits a standing adult, arms up, into the 9-unit-high stage).
const BONES: [number, number, number][] = [[11, 13, 0.15], [13, 15, 0.13], [12, 14, 0.15], [14, 16, 0.13], [23, 25, 0.19], [25, 27, 0.16], [24, 26, 0.19], [26, 28, 0.16]];
export type Pad = { part: 'hand' | 'head' | 'elbow' | 'knee' | 'foot'; side: number; x: number; y: number; vx: number; vy: number; seen: boolean };
const PADS: [Pad['part'], number, number[]][] = [['hand', 0, [15, 19]], ['hand', 1, [16, 20]], ['head', 0, [0]], ['elbow', 0, [13]], ['elbow', 1, [14]], ['knee', 0, [25]], ['knee', 1, [26]], ['foot', 0, [27, 31]], ['foot', 1, [28, 32]]];
const INK = '#1b1240', DEG = 180 / Math.PI;
export function figure(scene: Scene, p: number, at: { x: number; y: number; scale: number }) {
  const hex = PLAYER_COLORS[p], k = at.scale, group = node(scene.root, undefined, undefined, [at.x, at.y, 0.6]);
  // Under the Mirror look nothing is drawn here at all — the player is already in the picture — and `at` follows
  // them around the room instead: wherever they stand, that is where their game is.
  const inRoom = mirrorOn();
  const pads: Pad[] = PADS.map(([part, side]) => ({ part, side, x: 0, y: 0, vx: 0, vy: 0, seen: false }));

  // ---- their own picture ----
  const wantsPicture = (tuning.look === 'camera' || tuning.look === 'shadow') && !sim, look = wantsPicture ? cutoutLook(hex, tuning.look === 'shadow') : null;
  const picture = look ? node(group, shapes.quad(CUT.left * 2, CUT.up + CUT.down), look, [0, ((CUT.up - CUT.down) / 2) * k, 0]) : null;
  picture?.setLocalScale(k, k, 1);
  if (wantsPicture) { wantCutout(true); scene.cleanup(() => wantCutout(false)); }
  const ground = node(group, shapes.circle(1, 24), flat('#000000', { opacity: 0.3 }), [0, -3.95 * k, -0.2]); // a soft footing under whoever it is
  ground.setLocalScale(1.5 * k, 0.2 * k, 1);

  // ---- the drawn character ----
  const puppet = node(group), ink = flat(INK), skin = flat(hex), white = flat('#ffffff'), dark = flat('#0f0a2a');
  const limb = (r: number, z: number) => { const e = node(puppet, shapes.limb(r * k), skin, [0, 0, z]); node(e, shapes.limb((r + 0.05) * k), ink, [0, 0, -0.02]); return e; };
  const round = (r: number, mat = skin, z = 0.04) => { const e = node(puppet, shapes.circle(r * k, 24), mat, [0, 0, z]); node(e, shapes.circle((r + 0.05) * k, 24), ink, [0, 0, -0.02]); return e; };
  const torso = limb(0.44, 0), bones = BONES.map(([, , r]) => limb(r, 0.02)), head = round(0.5, skin, 0.06);
  const mitts = [0, 1].map(() => round(0.22, white, 0.08)), shoes = [0, 1].map(() => round(0.2, white, 0.03));
  const eyes = [-1, 1].map((side) => { const e = node(head, shapes.circle(0.13 * k, 16), white, [side * 0.18 * k, 0.06 * k, 0.02]); return { e, pupil: node(e, shapes.circle(0.065 * k, 12), dark, [0, 0, 0.01]) }; });
  const mouth = node(head, shapes.circle(0.09 * k, 14), dark, [0, -0.2 * k, 0.02]);
  const face = { blink: 2, puff: 0, lx: 0, ly: 0 };
  const place = (e: Entity, A: number[], B: number[]) => { e.setLocalPosition(A[0] * k, A[1] * k, e.getLocalPosition().z); e.setLocalEulerAngles(0, 0, Math.atan2(B[1] - A[1], B[0] - A[0]) * DEG); e.setLocalScale(Math.max(0.01, Math.hypot(B[0] - A[0], B[1] - A[1]) * k), 1, 1); };

  // `lookAt`: the stage point the character's eyes should follow (the nearest balloon, the newest crack).
  const update = (dt = 1 / 60, lookAt?: { x: number; y: number }) => {
    const pl = players[p], rig = pl.rig, on = pl.present && rig.length === 33;
    if (inRoom && on) {
      const f = pl.frame, unit = feedUnit(f.aspect);
      at.x = (f.x - f.aspect / 2) * unit; at.y = (0.5 - f.y) * unit; at.scale = f.sw * unit;
    }
    if (!show(group, on && !inRoom)) {
      for (const pad of pads) pad.seen = false;
      if (!on) return pads;
    }
    const drawn = !inRoom && !(picture && tuning.look !== 'avatar' && refreshCutouts() > p); // (the look can fall back to the character mid-round: see pose.ts)
    if (picture) { show(picture, !drawn); look!.setParameter('uSlot', [p, 1 / Math.max(1, cutout.slots), 0, 0]); look!.setParameter('uTime', performance.now() / 1000); }
    if (show(puppet, drawn)) {
      const mid = (a: number, b: number) => [(rig[a][0] + rig[b][0]) / 2, (rig[a][1] + rig[b][1]) / 2];
      place(torso, mid(11, 12), mid(23, 24));
      BONES.forEach(([a, b], i) => { if (show(bones[i], rig[a][2] > 0.4 && rig[b][2] > 0.4)) place(bones[i], rig[a], rig[b]); });
      head.setLocalPosition(rig[0][0] * k, (rig[0][1] + 0.08) * k, 0.06);
      [15, 16].forEach((j, h) => { if (show(mitts[h], rig[j][2] > 0.4)) mitts[h].setLocalPosition((rig[j][0] * 0.4 + rig[j + 4][0] * 0.6) * k, (rig[j][1] * 0.4 + rig[j + 4][1] * 0.6) * k, 0.08); });
      [27, 28].forEach((j, h) => { if (show(shoes[h], rig[j][2] > 0.4)) { shoes[h].setLocalPosition((rig[j][0] + rig[j + 4][0]) * 0.5 * k, (rig[j][1] + rig[j + 4][1]) * 0.5 * k - 0.04 * k, 0.03); shoes[h].setLocalScale(1.35, 0.8, 1); } });
      // The face: eyes follow the action, blink now and then; the mouth opens with effort.
      const tx = lookAt ? lookAt.x - (at.x + rig[0][0] * k) : 0, ty = lookAt ? lookAt.y - (at.y + rig[0][1] * k) : 0, far = Math.hypot(tx, ty) || 1;
      face.lx += ((tx / far) * 0.05 * k - face.lx) * Math.min(1, dt * 10); face.ly += ((ty / far) * 0.05 * k - face.ly) * Math.min(1, dt * 10);
      face.blink -= dt; if (face.blink < -0.12) face.blink = 2 + Math.random() * 3;
      const speed = Math.hypot(rig[15][3], rig[15][4]) + Math.hypot(rig[16][3], rig[16][4]) + Math.hypot(rig[27][3], rig[27][4]) + Math.hypot(rig[28][3], rig[28][4]);
      face.puff += (Math.min(1, speed / 9) - face.puff) * Math.min(1, dt * 5);
      for (const eye of eyes) { eye.e.setLocalScale(1, face.blink < 0 ? 0.12 : 1, 1); eye.pupil.setLocalPosition(face.lx, face.ly, 0.01); }
      mouth.setLocalScale(1 + face.puff * 0.6, 0.45 + face.puff * 1.3, 1);
    }
    PADS.forEach(([, , joints], i) => {
      const pad = pads[i];
      let x = 0, y = 0, vx = 0, vy = 0, vis = 1;
      for (const j of joints) { x += rig[j][0]; y += rig[j][1]; vx += rig[j][3]; vy += rig[j][4]; vis = Math.min(vis, rig[j][2]); }
      const c = at.scale / joints.length;
      Object.assign(pad, { x: at.x + x * c, y: at.y + y * c, vx: vx * c, vy: vy * c, seen: vis > 0.45 });
    });
    return pads;
  };
  return { update, pads, at };
}
