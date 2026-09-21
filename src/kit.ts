// What every game shares: the round clock, sound, the players' hands, bursts, and the small geometry of hit-testing.
// (The React shell that mounts a game lives in stage.tsx; nothing here touches React.)
import type { Entity, GraphNode } from 'playcanvas';
import { cutout, playerCount, players, predict, sim, track, tuning, wantCutout } from './pose.ts';
import { CUT } from './cut.ts';
import { blip, say, sfx, whoosh } from './audio.ts';
import { BODY_JOINTS, H, W, bodyLook, cutoutLook, feedUnit, flat, glowLook, instanced, node, mirrorOn, refreshCutouts, ribbon, shapes, show, trailLook, type Scene, type View } from './engine.ts';
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
// `tones`: a colour per hand ([left, right]) instead of one per player — for games where which hand matters.
export function hands(scene: Scene, n: number, map: HandMap = { cx: (p) => zoneX(n, p), hw: zoneHalf(n), hh: H / 2 }, swing = 6, tones?: string[]) {
  // Glass hands: a bead of light with a halo in the player's colour, and a trail that is brightest at the hand and
  // fades to nothing — light, not paint, so fast hands never hide what they are about to hit.
  const bead = shapes.quad(2, 2);
  const all = Array.from({ length: n * 2 }, (_, i) => {
    const hex = tones ? tones[i & 1] : PLAYER_COLORS[i >> 1], trail = ribbon(scene.root, TRAIL, trailLook(hex)), cursor: Entity = node(scene.root, bead, glowLook(hex));
    cursor.setLocalScale(1, 1, 1);
    const pts = new Float32Array(TRAIL * 2);
    return { trail, cursor, pts, age: new Float32Array(TRAIL), armed: true, pace: 0, state: { p: i >> 1, x: 0, y: 0, px: 0, py: 0, speed: 0, on: false, pts } as StageHand };
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
      // How hard to chase the tracker depends on how far behind we are: close to it (a still or slow hand) the dot
      // moves gently, so tracker noise — and the 20-odd readings a second arriving as little steps — never shows;
      // far from it (a real swing) it goes almost at once. Steady at rest, immediate in motion.
      const at = predict(hand), tx = map.cx(s.p) + at.x * map.hw, ty = (map.cy ?? 0) + at.y * map.hh, far = was ? Math.hypot(tx - s.x, ty - s.y) : 0;
      const k = was ? 1 - Math.exp(-dt * (11 + 36 * Math.min(1, far / 1.1))) : 1;
      s.px = was ? s.x : tx;
      s.py = was ? s.y : ty;
      s.x = s.px + (tx - s.px) * k;
      s.y = s.py + (ty - s.py) * k;
      cursor.setLocalPosition(s.x, s.y, 1);
      const swell = 0.95 + Math.min(0.7, own.pace * 0.04); // a fast hand burns brighter
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
      own.pace += (s.speed - own.pace) * Math.min(1, dt * 8); // the trail's width follows a calmed speed, or it flickers
      if (swing && own.armed && s.speed > swing) { own.armed = false; whoosh(Math.min(1, s.speed / swing / 3)); }
      else if (s.speed < swing * 0.5) own.armed = true; // one whoosh per swing: re-arms only once the hand has slowed right down
      const pos = trail.positions;
      for (let k = 0; k < TRAIL; k++) {
        // Drawn through a rounded copy of the path (each point eased toward its neighbours), so a noisy sample is a
        // gentle bend in the ribbon, not a kink; hit-testing (swept) still uses the true points.
        const a = Math.max(k - 1, 0) * 2, b = Math.min(k + 1, TRAIL - 1) * 2, c = 2 * k, px = k && k < TRAIL - 1 ? pts[a] * 0.25 + pts[c] * 0.5 + pts[b] * 0.25 : pts[c], py = k && k < TRAIL - 1 ? pts[a + 1] * 0.25 + pts[c + 1] * 0.5 + pts[b + 1] * 0.25 : pts[c + 1];
        const dx = pts[b] - pts[a], dy = pts[b + 1] - pts[a + 1], len = Math.hypot(dx, dy), w = len < 0.02 ? 0 : (0.2 + Math.min(0.22, own.pace * 0.018)) * (1 - (k / TRAIL) * 0.85);
        pos.set([px - (dy / (len || 1)) * w, py + (dx / (len || 1)) * w, 0.9, px + (dy / (len || 1)) * w, py - (dx / (len || 1)) * w, 0.9], k * 6);
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

// The player's whole body on the stage, for games played with more than hands. One interface, three looks:
//  · Shadow (the default): a figure of light in halftone dots, grown around the skeleton in a shader — no person mask,
//    so it costs the tracker nothing, works for two players, and is what ?sim shows;
//  · Camera: the player's own picture lifted out of the room (one player only: it needs the model's person mask);
//  · Mirror: nothing drawn at all — the player is already in the picture behind the game — and `at` follows them.
// In every look the parts that play — hand tips and foot tips — glow, and the "pads" (hands, head, elbows, knees,
// feet, in stage units) come from the same rig, so a game never knows which look is on. `at` is where the middle of
// the shoulders sits; `scale` is stage units per shoulder-width (1.2 fits a standing adult, arms up, into the stage).
export type Pad = { part: 'hand' | 'head' | 'elbow' | 'knee' | 'foot'; side: number; x: number; y: number; vx: number; vy: number; seen: boolean };
const PADS: [Pad['part'], number, number[]][] = [['hand', 0, [15, 19]], ['hand', 1, [16, 20]], ['head', 0, [0]], ['elbow', 0, [13]], ['elbow', 1, [14]], ['knee', 0, [25]], ['knee', 1, [26]], ['foot', 0, [27, 31]], ['foot', 1, [28, 32]]];
export function figure(scene: Scene, p: number, at: { x: number; y: number; scale: number }) {
  const hex = PLAYER_COLORS[p], group = node(scene.root, undefined, undefined, [at.x, at.y, 0.6]);
  const pads: Pad[] = PADS.map(([part, side]) => ({ part, side, x: 0, y: 0, vx: 0, vy: 0, seen: false }));
  const inRoom = mirrorOn(), wantsPicture = tuning.look === 'camera' && !sim && !inRoom;
  const window_ = shapes.quad(CUT.left * 2 + 1, CUT.up + CUT.down + 1), lift = (CUT.up - CUT.down) / 2;
  const cut = wantsPicture ? cutoutLook(hex) : null, picture = cut ? node(group, shapes.quad(CUT.left * 2, CUT.up + CUT.down), cut, [0, lift, 0]) : null;
  if (wantsPicture) { wantCutout(true); scene.cleanup(() => wantCutout(false)); }
  const look = bodyLook(hex), body = node(group, window_, look, [0, lift, 0.05]);
  // The figure tells the truth about where you are. Its home (`at` as the game gave it) is where you should stand —
  // marked by a ring on the floor — and it is drawn as far from home as you are from your place in front of the
  // camera, and as far up or down as your jump or squat. Drift off to one side and you SEE it, and step back.
  const home = { x: at.x, y: at.y }, seatAt = playerCount() === 2 ? 0.27 + 0.46 * p : 0.5; // where in the picture this player's place is
  const spot = node(scene.root, shapes.ring(0.86, 1, 40), flat(hex, { opacity: 0.35 }), [home.x, home.y - 3.95 * at.scale, 0.2]), ground = node(scene.root, shapes.circle(1, 24), flat('#000000', { opacity: 0.3 }), [home.x, home.y - 3.95 * at.scale, 0.25]);
  spot.setLocalScale(1.7 * at.scale, 0.24 * at.scale, 1); ground.setLocalScale(1.5 * at.scale, 0.2 * at.scale, 1);
  const joints = new Float32Array(34), seen = new Float32Array(17);

  const update = () => {
    const pl = players[p], rig = pl.rig, on = pl.present && rig.length === 33;
    show(spot, on && !inRoom);
    if (!show(group, on)) { show(ground, false); for (const pad of pads) pad.seen = false; return pads; }
    if (!inRoom) { // true to the room: sideways from your place, up and down with your body
      const f = pl.frame, off = sim ? pl.lean * 1.5 : (f.x / f.aspect - seatAt) * W * 0.9;
      at.x = Math.max(-W / 2 + 1.2, Math.min(W / 2 - 1.2, home.x + off)); at.y = home.y + pl.lift * at.scale;
      ground.setLocalPosition(at.x, home.y - 3.95 * at.scale, 0.25); const air = 1 / (1 + Math.max(0, pl.lift) * 1.2); ground.setLocalScale(1.5 * at.scale * air, 0.2 * at.scale * air, 1);
    }
    if (inRoom) { const f = pl.frame, unit = feedUnit(f.aspect); at.x = (f.x - f.aspect / 2) * unit; at.y = (0.5 - f.y) * unit; at.scale = f.sw * unit; }
    group.setLocalPosition(at.x, at.y, 0.6); group.setLocalScale(at.scale, at.scale, 1); // everything inside is in shoulder-widths
    // The picture, if there is one to show this frame (one player, mask arriving); otherwise the shadow body.
    const pictured = !!picture && tuning.look === 'camera' && cutout.slots === 1 && refreshCutouts() > 0;
    if (picture && show(picture, pictured)) { cut!.setParameter('uSlot', [0, 1, 0, 0]); cut!.setParameter('uTime', performance.now() / 1000); }
    show(ground, !inRoom);
    BODY_JOINTS.forEach((j, i) => { joints[i * 2] = rig[j][0]; joints[i * 2 + 1] = rig[j][1] - lift; seen[i] = rig[j][2]; });
    look.setParameter('uJ[0]', joints); look.setParameter('uSeen[0]', seen); look.setParameter('uTips', pictured || inRoom ? 1 : 0);
    PADS.forEach(([, , js], i) => {
      const pad = pads[i];
      let x = 0, y = 0, vx = 0, vy = 0, vis = 1;
      for (const j of js) { x += rig[j][0]; y += rig[j][1]; vx += rig[j][3]; vy += rig[j][4]; vis = Math.min(vis, rig[j][2]); }
      const c = at.scale / js.length;
      Object.assign(pad, { x: at.x + x * c, y: at.y + y * c, vx: vx * c, vy: vy * c, seen: vis > 0.45 });
    });
    return pads;
  };
  void body;
  return { update, pads, at };
}
