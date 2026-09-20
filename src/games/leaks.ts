// Leaks — you are inside a glass tank and it is cracking. Water sprays in wherever a crack opens; cover a crack with
// anything you have — a hand, a foot, a knee, your head — and hold it there until the patch sets. Cracks come one at a
// time at first, then two, then three and four at once, and that is the game: a hand up here, a foot out there, and
// somehow your head on that one. The water rises while anything is open and drains when you are on top of it.
// Two players share one tank, one water level and one score — and the cracks on the seam between you need one of each
// of you at the same moment.
import type { Entity } from 'playcanvas';
import { hardness } from '../meta.ts';
import { fade, flat, node, shapes, show, tint } from '../engine.ts';
import { H, W, bestLine, bursts as makeBursts, figure, hitSound, hitStop, music, round, say, sfx, zoneX, type Game, type Pad } from '../kit.ts';

const ROUND = 60, FINALE = 9, SCALE = 1.2, SHOULDER_Y = 0.55, SPOT_R = 0.62, SEAL = 0.85, SPOTS = 9;
// Where cracks can open, in shoulder-widths from the middle of the shoulders, and what the spot is asking for.
// Every spot is reachable without taking a step: that is the rule of the room.
const REACH: { x: number; y: number; part: string }[] = [
  { x: -1.7, y: 1.5, part: 'hand' }, { x: 1.7, y: 1.5, part: 'hand' }, { x: -0.7, y: 2.1, part: 'hand' }, { x: 0.7, y: 2.1, part: 'hand' },
  { x: -2.1, y: 0.2, part: 'hand' }, { x: 2.1, y: 0.2, part: 'hand' }, { x: -1.9, y: -1.1, part: 'hand' }, { x: 1.9, y: -1.1, part: 'hand' },
  { x: -1.5, y: -3.1, part: 'foot' }, { x: 1.5, y: -3.1, part: 'foot' }, { x: -0.9, y: -3.7, part: 'foot' }, { x: 0.9, y: -3.7, part: 'foot' },
  { x: -0.75, y: -1.75, part: 'knee' }, { x: 0.75, y: -1.75, part: 'knee' }, { x: -0.95, y: 0.85, part: 'head' }, { x: 0.95, y: 0.85, part: 'head' },
];
const ASK: Record<string, string> = { hand: 'Hand!', foot: 'Foot!', knee: 'Knee!', head: 'Head!' };
type Spot = { on: boolean; x: number; y: number; part: string; zone: number; seam: boolean; gold: boolean; hold: number; age: number; sealed: number; spray: number; crack: Entity; ring: Entity; patch: Entity };

export default function leaks({ n, stage, best, onEnd, hud, scene }: Game) {
  const hard = hardness(stage), shared = n === 2; // two players are always one crew here: the tank is one tank
  const centre = (p: number) => ({ x: zoneX(n, p), y: SHOULDER_Y, scale: SCALE });
  // The tank: a pane of glass, and the water — one sheet across the whole stage, its top edge the thing to watch.
  node(scene.root, shapes.quad(W, H), flat('#38bdf8', { opacity: 0.06 }), [0, 0, -1]);
  const water = node(scene.root, shapes.quad(W, H), flat('#0ea5e9', { opacity: 0.32 }), [0, -H, 0.8]), surface = node(scene.root, shapes.quad(W, 0.09), flat('#e0f2fe', { opacity: 0.9 }), [0, -H, 0.85]);
  const crackMesh = shapes.circle(1, 7), ringMesh = shapes.ring(0.86, 1, 40), patchMesh = shapes.circle(1, 28);
  const crackLook = flat('#0c1a2b', { opacity: 0.9 }), ringLook = flat('#ffffff', { opacity: 1 }), patchLook = flat('#94a3b8', { opacity: 1 });
  const spots: Spot[] = Array.from({ length: SPOTS }, () => {
    const crack = node(scene.root, crackMesh, crackLook), ring = node(scene.root, ringMesh, ringLook), patch = node(scene.root, patchMesh, patchLook);
    crack.enabled = ring.enabled = patch.enabled = false;
    return { on: false, x: 0, y: 0, part: 'hand', zone: 0, seam: false, gold: false, hold: 0, age: 0, sealed: 0, spray: 0, crack, ring, patch };
  });
  const bodies = Array.from({ length: n }, (_, p) => figure(scene, p, centre(p)));
  const bursts = makeBursts(scene.root), passed = bestLine(hud, best);
  const g = { score: 0, water: 0, next: 0.6, wave: 0, sealed: 0, most: 0, fastest: 9, floods: 0, assist: 0, twist: false, finale: false, lastSeal: -9, streak: 0 };
  const finish = () => { music.stop(); const s = Math.round(g.score); onEnd(shared ? [s, s] : [s], Array.from({ length: n }, () => [`${g.sealed} sealed`, g.most >= 3 ? `${g.most} held at once` : '', g.fastest < 9 ? `Fastest patch ${g.fastest.toFixed(1)}s` : '', g.floods ? `Flooded ×${g.floods}` : 'Never flooded'].filter(Boolean))); };
  const tick = round(hud, ROUND, finish);
  music.start('arcade');

  // How many cracks are open at once, by act: teach one, then pairs, then contortions, then the hull goes.
  const want = (t: number) => (t > ROUND - FINALE ? (shared ? 6 : 4) : (t < 9 ? 1 : t < 26 ? 2 : 3) * (shared ? 1.5 : 1));
  const open = (t: number, seam = false, mirror?: Spot) => {
    const spot = spots.find((s) => !s.on && s.sealed <= 0);
    if (!spot) return;
    const zone = seam ? 0 : mirror ? mirror.zone : Math.floor(Math.random() * n), c = centre(zone);
    // Early on only hands, then feet join, then knees and heads: each new body part is introduced on its own.
    const pool = REACH.filter((r) => (t < 6 ? r.part === 'hand' : t < 16 ? r.part === 'hand' || r.part === 'foot' : true) && !spots.some((s) => s.on && s.zone === zone && Math.hypot(s.x - (c.x + r.x * SCALE), s.y - (c.y + r.y * SCALE)) < 1.5));
    const r = mirror ? { x: -(mirror.x - c.x) / SCALE, y: (mirror.y - c.y) / SCALE, part: mirror.part } : pool[Math.floor(Math.random() * pool.length)];
    if (!r && !seam) return;
    Object.assign(spot, seam ? { x: 0, y: SHOULDER_Y + (Math.random() * 2.4 - 0.6) * SCALE, part: 'hand' } : { x: c.x + r.x * SCALE, y: c.y + r.y * SCALE, part: r.part });
    Object.assign(spot, { on: true, zone, seam, gold: !seam && t > 12 && Math.random() < 0.12, hold: 0, age: 0, spray: 0 });
    sfx('impactGlass_heavy', { vol: 0.45, rate: 0.8 + Math.random() * 0.5 });
    hud.pop(spot.x, spot.y + 0.9, seam ? 'Both of you!' : ASK[spot.part], spot.gold ? '#fde047' : '#e0f2fe');
    return spot;
  };

  return (rawDt: number) => {
    const dt = Math.min(rawDt, 0.05), t = tick(rawDt);
    if (t === null) return;
    const pads: (Pad & { p: number })[] = bodies.flatMap((b, p) => b.update().map((pad) => ({ ...pad, p })));
    const finale = t > ROUND - FINALE;
    if (finale && !g.finale) { g.finale = true; hud.banner('The hull is going!', 1700); say('hurry_up'); hud.shake(1.2); sfx('impactMetal_heavy'); }
    if (!g.twist && t > 30) { g.twist = true; hud.banner('Pressure surge · cracks come in pairs', 1900); sfx('zapThreeToneUp', { vol: 0.7 }); }

    // Open new cracks up to what this moment of the round asks for.
    const openNow = spots.filter((s) => s.on).length;
    if (t >= 0 && (g.next -= dt) <= 0 && openNow < Math.round(want(t))) {
      g.next = (finale ? 0.35 : 1.1 - 0.35 * (t / ROUND)) / hard + g.assist * 0.5;
      const made = open(t, shared && !finale && t > 14 && Math.random() < 0.22 && !spots.some((s) => s.on && s.seam));
      if (made && !made.seam && g.twist && t < 44 && Math.random() < 0.6) open(t, false, made); // the surge: its mirror image opens too
    }

    let held = 0, leaking = 0;
    for (const s of spots) {
      if (s.sealed > 0) { // the patch: pops on, sits a moment, fades
        s.sealed -= dt;
        if (show(s.patch, s.sealed > 0)) { const k = SPOT_R * (1 + 0.25 * Math.max(0, s.sealed - 0.85) * 6); s.patch.setLocalScale(k, k, 1); fade(s.patch, Math.min(1, s.sealed * 2.5)); }
      }
      if (!show(s.crack, s.on)) { show(s.ring, false); continue; }
      s.age += dt;
      const reach = SPOT_R * (1.15 + 0.5 * g.assist), on = pads.filter((pad) => pad.seen && Math.hypot(pad.x - s.x, pad.y - s.y) < reach);
      // A seam crack sits between the two of you and only holds with one of each on it.
      const covered = s.seam ? on.some((pad) => pad.p === 0) && on.some((pad) => pad.p === 1) : on.length > 0;
      if (covered) { s.hold += dt; held++; } else { s.hold = Math.max(0, s.hold - dt * 1.5); leaking++; }
      const need = SEAL * (s.seam ? 1.2 : 1) * (1 - 0.3 * g.assist), done = s.hold / need, size = SPOT_R * (s.seam ? 1.25 : 1);
      s.crack.setLocalPosition(s.x, s.y, 0.2); s.crack.setLocalScale(size * (1 + 0.06 * Math.sin(s.age * 17)), size, 1); s.crack.setLocalEulerAngles(0, 0, s.age * 25);
      show(s.ring, true);
      s.ring.setLocalPosition(s.x, s.y, 0.3); s.ring.setLocalScale(size * (1.9 - 0.9 * done), size * (1.9 - 0.9 * done), 1); // closes onto the crack as the patch sets
      tint(s.ring, covered ? '#7dff7a' : s.gold ? '#fde047' : s.seam ? '#f472b6' : '#ffffff'); fade(s.ring, 0.55 + 0.45 * done);
      if (!covered && (s.spray -= dt) <= 0) { s.spray = 0.07; bursts.burst(s.x, s.y, 0.5, s.gold ? '#fde047' : '#7dd3fc', 2, 5); } // water comes in for as long as it is open
      if (done < 1) continue;
      // Sealed.
      const quick = s.age < 1.6, points = (s.gold ? 3 : 1) * (finale ? 2 : 1) + (s.seam ? 2 : 0) + (quick ? 1 : 0);
      s.on = false; s.sealed = 1.1; s.patch.setLocalPosition(s.x, s.y, 0.25); tint(s.patch, s.gold ? '#fde047' : '#94a3b8');
      g.score += points; g.sealed++; g.fastest = Math.min(g.fastest, s.age); g.assist = Math.max(0, g.assist - 0.06);
      g.streak = t - g.lastSeal < 0.6 ? g.streak + 1 : 1; g.lastSeal = t;
      hitSound('impactMetal_heavy', Math.min(12, g.sealed / 3), 0.55); bursts.burst(s.x, s.y, 0.6, '#e2e8f0', s.gold ? 26 : 12, 6);
      hud.pop(s.x, s.y + 0.7, s.seam ? `Teamwork! +${points}` : quick ? `Quick! +${points}` : `+${points}`, s.gold ? '#fde047' : '#7dff7a');
      if (g.streak >= 2) { g.score += g.streak; hud.pop(s.x, s.y + 1.5, `${g.streak} at once! +${g.streak}`, '#a3e635'); hitStop(70); sfx('confirmation', { vol: 0.6 }); }
      if (s.age > 5) g.assist = Math.min(1, g.assist + 0.2); // that one took for ever: be kinder, quietly
    }
    g.most = Math.max(g.most, held);

    // Water: every open crack lets it in; with everything covered it drains. Flooding costs points and half the tank.
    if (t >= 0) g.water = Math.max(0, Math.min(1, g.water + (leaking * (shared ? 0.026 : 0.034) * hard * (1 - 0.4 * g.assist) - (leaking ? 0 : 0.07)) * dt)); // a struggling crew's tank fills more slowly
    if (g.water >= 1) { g.water = 0.35; g.floods++; g.score = Math.max(0, g.score - 5); g.assist = Math.min(1, g.assist + 0.3); hud.banner('Flooded! −5', 1300); hud.flash('#0ea5e9'); hud.shake(1.5); sfx('lowDown', { vol: 0.8 }); hitStop(160); }
    const level = -H / 2 + g.water * H * 0.92 + Math.sin(t * 2.2) * 0.05;
    water.setLocalPosition(0, level - H / 2, 0.8); surface.setLocalPosition(0, level, 0.85);

    bursts.update(dt);
    passed(g.score);
    music.intensity(finale ? 1 : 0.3 + g.water * 0.6);
    hud.p('s', 0, String(Math.round(g.score)));
    const hint = t < 0 ? 'Cover every crack and hold it' : g.water > 0.75 ? 'The water! Cover them all!' : leaking === 0 && openNow ? 'Hold it…' : '';
    for (let p = 0; p < n; p++) hud.p('h', p, hint);
  };
}
