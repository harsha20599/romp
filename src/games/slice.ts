// Slice — fruit-slicer with real fruit. A cut is a real cut: the model is split along the line of your swipe
// (two clipped copies of the same mesh), the halves tumble apart and the flesh-coloured cut faces turn to the camera.
//
// Three modes. Arcade: 60 seconds that build — singles, then fans and stacks, then a twist, a frenzy, and a giant melon
// to hammer when the clock hits zero; glowing bananas are power-ups. Classic: three lives, a dropped fruit or a bomb
// costs one, and it only gets faster. Zen: 90 slow seconds with nothing to fear — a cool-down.
// Two players are a team by default (one score, a multiplier as strong as the weaker streak, a bonus for cutting in
// sync) or rivals. Either way each player is quietly helped when fruit keeps getting past them: never shown, never said.
import { Quat, Vec3, type Entity } from 'playcanvas';
import { hardness } from '../meta.ts';
import { sim } from '../pose.ts';
import { backdrop, clippable, fitted, flat, instanced, node, setClip, shapes, show, tint } from '../engine.ts';
import { H, PLAYER_COLORS, bestLine, bursts as makeBursts, comboText, divider, hands as makeHands, hitSound, hitStop, music, round, say, scoreHud, segDist, sfx, swept, zoneHalf, zoneX, type Game, type StageHand } from '../kit.ts';

const R = 0.75, GRAVITY = -9, FRENZY = 10, FINALE = 4.5, DEG = 180 / Math.PI;
const SLICE_SPEED = 5, CRIT_SPEED = 12.5; // stage units/s a hand must move to cut, and to cut hard — tune on device
const FRUIT = [
  { url: 'apple', flesh: '#fef9c3', size: 2 }, { url: 'orange', flesh: '#fdba74', size: 2 }, { url: 'watermelon', flesh: '#fb7185', size: 2.6 },
  { url: 'pear', flesh: '#fef08a', size: 2.2 }, { url: 'lemon', flesh: '#fef9c3', size: 1.8 }, { url: 'coconut', flesh: '#fafafa', size: 2 },
  { url: 'pineapple', flesh: '#fde047', size: 2.8 }, { url: 'strawberry', flesh: '#fda4af', size: 1.7 },
];
const RULES = {
  '': { length: 60, lives: 0, bombs: true, powers: true, finale: true, gravity: 1, music: 'arcade' },
  classic: { length: Infinity, lives: 3, bombs: true, powers: false, finale: false, gravity: 1, music: 'arcade' },
  zen: { length: 90, lives: 0, bombs: false, powers: false, finale: false, gravity: 0.55, music: 'calm' },
} as const;
// Power-ups are bananas with a coloured halo. Each changes what the next few seconds feel like.
const POWERS = { frenzy: { hex: '#f472b6', name: 'Frenzy!', time: 5 }, double: { hex: '#fde047', name: 'Double points!', time: 8 }, freeze: { hex: '#7dd3fc', name: 'Freeze!', time: 5 } } as const;
type Power = keyof typeof POWERS;
const v = new Vec3(), q = new Quat(), turn = new Quat();

type Kind = 'fruit' | 'star' | 'bomb' | 'power';
type Half = { obj: Entity; nx: number; ny: number; x: number; y: number; vx: number; vy: number };
type Piece = {
  state: 'off' | 'wait' | 'whole' | 'cut'; kind: Kind; flesh: string; power: Power; zone: number; wait: number; x: number; y: number; vx: number; vy: number; spin: number; age: number; rx: number; ry: number;
  whole: Entity; halo: Entity | null; halves: Half[]; along: Vec3; base: Quat;
};
// A launch: where across the zone (-1..1), how long after the phrase starts, how hard (1 = normal), and what.
type Shot = { at: number; delay: number; lift?: number; kind?: Kind };
// Phrases are the vocabulary of a round: written by hand so that each one invites a particular swing.
const PHRASES: Record<string, () => Shot[]> = {
  single: () => [{ at: Math.random() * 1.6 - 0.8, delay: 0 }],
  pair: () => { const x = 0.3 + Math.random() * 0.4; return [{ at: -x, delay: 0 }, { at: x, delay: 0.08 }]; }, // one for each hand
  fan: () => { const dir = Math.random() < 0.5 ? 1 : -1; return [-0.8, -0.4, 0, 0.4, 0.8].map((x, k) => ({ at: x * dir, delay: k * 0.13 })); }, // one long sweep across
  stack: () => { const x = Math.random() * 1.2 - 0.6; return [1.12, 1, 0.88].map((lift, k) => ({ at: x, delay: k * 0.1, lift })); }, // three in a column: one vertical slash
  fountain: () => [-0.5, -0.25, 0, 0.25, 0.5].map((x) => ({ at: x, delay: 0, lift: 0.9 + Math.random() * 0.25 })), // all at once: the multi-fruit slash
  dare: () => { const x = Math.random() * 0.8 - 0.4; return [{ at: x - 0.35, delay: 0 }, { at: x, delay: 0.05, kind: 'bomb' as Kind }, { at: x + 0.35, delay: 0.1 }]; }, // fruit either side of a bomb
  bomb: () => [{ at: Math.random() * 1.6 - 0.8, delay: 0, kind: 'bomb' as Kind }],
  star: () => [{ at: Math.random() * 1.2 - 0.6, delay: 0, kind: 'star' as Kind, lift: 1.15 }],
};
// What a round is made of, by act. Arcade: teach → develop → twist → frenzy. Weights, not a fixed script: no two rounds alike.
const ACTS: [until: number, gap: number, mix: [string, number][]][] = [
  [0.17, 1.15, [['single', 5], ['pair', 3]]],
  [0.55, 1.35, [['single', 2], ['pair', 3], ['fan', 3], ['stack', 3], ['bomb', 2], ['star', 1]]],
  [0.83, 1.5, [['pair', 2], ['fan', 3], ['stack', 3], ['fountain', 3], ['dare', 3], ['bomb', 1], ['star', 1]]],
  [1, 0.55, [['single', 3], ['pair', 3], ['fountain', 2], ['star', 1]]],
];
const pick = <T,>(mix: [T, number][]) => { let r = Math.random() * mix.reduce((a, [, w]) => a + w, 0); return mix.find(([, w]) => (r -= w) < 0)![0]; };

export default async function slice({ n, stage, mode, team, best, onEnd, hud, scene }: Game) {
  const hard = hardness(stage), rules = RULES[mode as keyof typeof RULES] ?? RULES[''], length = rules.length;
  const [fruit, bomb, star, banana] = await Promise.all([
    Promise.all(FRUIT.map((f) => fitted(`/assets/food/${f.url}.glb`, R * f.size))), fitted('/assets/kit/bomb.glb', R * 2.1), fitted('/assets/kit/star.glb', R * 1.8), fitted('/assets/food/banana.glb', R * 2.4),
  ]);
  backdrop(scene, 'dojo');
  // Juice stays on the wall: every cut leaves a stain and a few drops that soak away over some seconds.
  const SPLATS = 72, stains = instanced(scene.root, shapes.blob(1), SPLATS, 0.999), wet = Array.from({ length: SPLATS }, () => ({ life: 0, x: 0, y: 0, size: 0 }));
  let nextStain = 0;
  const splat = (x: number, y: number, hex: string, big: boolean) => {
    for (let k = 0; k < (big ? 5 : 3); k++) {
      const i = (nextStain = (nextStain + 1) % SPLATS), a = Math.random() * 6.28, far = k ? 0.5 + Math.random() * (big ? 1.5 : 1) : 0;
      Object.assign(wet[i], { life: 1, x: x + Math.cos(a) * far, y: y + Math.sin(a) * far - (k ? 0.15 : 0), size: k ? 0.12 + Math.random() * 0.2 : (big ? 0.95 : 0.7) + Math.random() * 0.25 });
      stains.paint(i, hex);
    }
  };
  const haloMesh = shapes.ring(1.05, 1.3, 40), haloLook = flat('#ffffff', { opacity: 0.85 });
  const add = (e: Entity) => { scene.root.addChild(e); e.enabled = false; return e; };

  const pieces: Piece[] = Array.from({ length: n === 2 ? 56 : 38 }, (_, i) => { // enough fruit for two fountains and a fan to be in the air at once
    const kind: Kind = i % 7 === 4 ? 'bomb' : i % 7 === 5 ? 'star' : i % 7 === 6 ? 'power' : 'fruit', type = i % FRUIT.length;
    const whole = add((kind === 'bomb' ? bomb : kind === 'star' ? star : kind === 'power' ? banana : fruit[type]).clone() as Entity);
    const halo = kind === 'power' ? node(scene.root, haloMesh, haloLook) : null;
    if (halo) halo.enabled = false;
    // Each half is the whole model again, with its own material clipped by its own plane.
    const halves = kind !== 'fruit' ? [] : [0, 1].map(() => {
      const obj = add(fruit[type].clone() as Entity);
      clippable(obj, FRUIT[type].flesh);
      return { obj, nx: 0, ny: 0, x: 0, y: 0, vx: 0, vy: 0 };
    });
    return { state: 'off', kind, flesh: FRUIT[type].flesh, power: 'frenzy', zone: 0, wait: 0, x: 0, y: 0, vx: 0, vy: 0, spin: 0, age: 0, rx: 0, ry: 0, whole, halo, halves, along: new Vec3(), base: new Quat() };
  });
  // The finale: one giant melon per zone (one between you, as a team) that takes every hit you can land before it bursts.
  const melons = (rules.finale ? (team ? [0] : Array.from({ length: n }, (_, p) => zoneX(n, p))) : []).map((x) => {
    const e = add(fruit[2].clone() as Entity);
    return { e, x, y: -H, hits: 0, wobble: 0 };
  });
  if (!team) divider(scene, n);

  const g = {
    spawnIn: [0.4, 0.7], scores: [0, 0], combo: [0, 0], bestCombo: [0, 0], crits: [0, 0], bestSlash: [0, 0], cut: [0, 0], lives: rules.lives * (team ? 2 : 1) - (team && rules.lives ? 1 : 0),
    assist: [0, 0], // 0..1, how much each player is quietly being helped
    power: { frenzy: [0, 0], double: [0, 0], freeze: [0, 0] } as Record<Power, number[]>, powersLeft: 3, twist: '', lastCut: [-9, -9], over: false, finale: false,
    chain: [0, 1, 2, 3].map(() => ({ n: 0, until: 0, x: 0, y: 0 })), // per hand: fruit cut in one continuous swing
    inside: [0, 1, 2, 3].map(() => false), burst: -1,
  };
  const hands = makeHands(scene, n), bursts = makeBursts(scene.root), passed = bestLine(hud, best);
  if (sim) Object.assign(window, { __slice: { pieces } }); // test hook: a headless probe watches every piece, every frame
  const total = () => (team ? g.scores[0] : Math.max(g.scores[0], g.scores[1]));
  const notes = () => Array.from({ length: n }, (_, p) => [g.bestSlash[p] >= 3 ? `Best slash: ${g.bestSlash[p]} fruit` : '', g.bestCombo[p] >= 5 ? `Longest combo ×${g.bestCombo[p]}` : '', g.crits[p] ? `${g.crits[p]} critical${g.crits[p] > 1 ? 's' : ''}` : ''].filter(Boolean));
  const finish = () => { g.over = true; music.stop(); onEnd(team ? [g.scores[0], g.scores[0]] : g.scores.slice(0, n), notes()); };
  const tick = round(hud, length, finish, rules.finale ? FINALE : 0);
  music.start(rules.music, undefined, mode === 'zen' ? 0.5 : 0.3);
  // In a team the score is shared and multiplied by the weaker of the two streaks: you are as strong as your partner.
  const teamBoost = () => 1 + Math.min(10, Math.min(g.combo[0], g.combo[1])) / 10;
  const award = (p: number, points: number) => { g.scores[team ? 0 : p] += points * (g.power.double[team ? 0 : p] > 0 ? 2 : 1) * (team ? teamBoost() : 1); };
  const lose = (x: number) => { // Classic: a life gone
    if (!rules.lives || g.over) return;
    g.lives--; hud.flash('#ef4444'); hud.shake(1); sfx('error', { vol: 0.8 }); hud.pop(x, -H / 2 + 0.8, '−♥', '#ef4444');
    if (g.lives <= 0) { say('game_over'); finish(); }
  };

  const launch = (piece: Piece, z: number, shot: Shot) => {
    const side = shot.at, floaty = rules.gravity, help = 1 - 0.18 * g.assist[z]; // helped players get slower, higher-hanging fruit
    Object.assign(piece, {
      state: 'wait', wait: shot.delay, zone: z, spin: Math.random() * 4 - 2, x: (team ? 0 : zoneX(n, z)) + side * (team ? H * 0.8 : zoneHalf(n)) * 0.78, y: -H / 2 - R,
      vx: -side * (0.4 + Math.random() * 0.8) * help, vy: ((piece.kind === 'star' ? 11.5 : 10) + Math.random() * 1.6) * (shot.lift ?? 1) * Math.sqrt(floaty) * (0.96 + 0.04 * help), rx: Math.random() * 360, ry: Math.random() * 360,
    });
    if (piece.kind === 'power') piece.power = (['frenzy', 'double', 'freeze'] as Power[])[Math.floor(Math.random() * 3)];
  };
  const take = (kind: Kind, bombsOk: boolean) => {
    const free = pieces.filter((p) => p.state === 'off' && p.kind === kind);
    return kind === 'bomb' && !bombsOk ? undefined : free[Math.floor(Math.random() * free.length)];
  };

  return (rawDt: number) => {
    const real = Math.min(rawDt, 0.05), t = tick(rawDt);
    if (t === null || g.over) return;
    const ending = t >= length, progress = isFinite(length) ? Math.min(1, Math.max(0, t) / length) : Math.min(0.82, 0.17 + t / 140);
    const act = ACTS.find(([until]) => progress <= until) ?? ACTS[3], frenzy = mode === '' && t > length - FRENZY && !ending;

    // The twist: two-thirds through an Arcade round the rules bend for a while, and the stage says how.
    if (mode === '' && !g.twist && progress > 0.58) {
      g.twist = Math.random() < 0.5 ? 'moon' : 'storm';
      hud.banner(g.twist === 'moon' ? 'Low gravity!' : 'Bomb storm · double points!', 1800); sfx('zapThreeToneUp', { vol: 0.7 });
    }
    const twisting = g.twist && progress > 0.58 && progress < 0.83, moon = twisting && g.twist === 'moon', storm = twisting && g.twist === 'storm';

    for (let z = 0; z < n; z++) {
      const own = team ? 0 : z;
      for (const k of Object.keys(g.power) as Power[]) g.power[k][own] = Math.max(0, g.power[k][own] - real / (team ? n : 1));
      const slowed = g.power.freeze[own] > 0 ? 0.4 : 1;
      if (t < 0 || ending || (g.spawnIn[z] -= real * slowed) > 0) continue;
      const rush = g.power.frenzy[own] > 0;
      g.spawnIn[z] = (rush ? 0.3 : frenzy ? 0.34 : act[1] * (1 - 0.25 * progress) * (mode === 'zen' ? 1.25 : 1) * (rules.lives ? Math.max(0.45, 1 - t / 200) : 1) + Math.random() * 0.3) / hard; // Classic only ever gets faster
      const name = rush ? (Math.random() < 0.5 ? 'fountain' : 'fan') : storm && Math.random() < 0.45 ? (Math.random() < 0.5 ? 'dare' : 'bomb') : pick(act[2]);
      // Now and then a power-up rides along instead (Arcade only, three a round, never in the last act).
      const power = rules.powers && g.powersLeft > 0 && progress > 0.2 && progress < 0.8 && Math.random() < 0.09 && !rush;
      for (const shot of power ? [{ at: Math.random() * 1.2 - 0.6, delay: 0, kind: 'power' as Kind, lift: 1.1 }] : PHRASES[name]()) {
        const piece = take(shot.kind ?? 'fruit', rules.bombs && !rush && !frenzy && t > 6);
        if (!piece) continue;
        if (piece.kind === 'power') g.powersLeft--;
        launch(piece, z, shot);
      }
    }

    const at = hands.update(real);
    // ---- the finale: hammer the melon ------------------------------------------------------------------------------
    if (ending && rules.finale) {
      const into = t - length;
      if (!g.finale) { g.finale = true; hud.banner('Smash the melon!', 1500); say('final_round'); for (const pc of pieces) if (pc.state !== 'cut') pc.state = 'off'; }
      melons.forEach((m, k) => {
        const rise = Math.min(1, into / 0.5), size = 2.6 + m.hits * 0.035;
        m.y = -H / 2 - 3 + rise * (H / 2 + 3 + 0.2);
        m.wobble = Math.max(0, m.wobble - real * 6);
        if (show(m.e, g.burst < 0)) { m.e.setLocalPosition(m.x, m.y, 0); m.e.setLocalScale(size * (1 + m.wobble * 0.12), size * (1 - m.wobble * 0.1), size); m.e.setLocalEulerAngles(20, into * 40, Math.sin(into * 9) * 4); }
        at.forEach((h, i) => {
          if (team ? false : h.p !== k) return;
          const near = h.on && Math.hypot(h.x - m.x, h.y - m.y) < R * 3.4;
          // One hit per pass: the hand has to leave the melon (or stop) before it can score again. Flailing in place earns nothing.
          if (near && !g.inside[i] && h.speed > SLICE_SPEED && g.burst < 0 && rise === 1) {
            m.hits++; m.wobble = 1; award(h.p, 1);
            hitSound('impactSoft_heavy', Math.min(24, m.hits), 0.8); bursts.burst(h.x, h.y, 1, '#fb7185', 10, 9); hud.pop(h.x, h.y + 0.6, `+${m.hits}`, PLAYER_COLORS[h.p]);
            if (m.hits % 5 === 0) hud.shake(0.5);
          }
          g.inside[i] = near && h.speed > SLICE_SPEED * 0.5;
        });
      });
      if (g.burst < 0 && into > FINALE - 0.9) { // it goes off: everything it soaked up, at once, in slow motion
        g.burst = t; hitStop(420, 0.12); hud.flash('#fb7185'); hud.shake(2); sfx('impactPlate_heavy'); sfx('powerUp', { vol: 0.9 });
        for (const m of melons) { bursts.burst(m.x, m.y, 1, '#fb7185', 70, 14); bursts.burst(m.x, m.y, 1, '#166534', 30, 11); hud.pop(m.x, m.y + 1.4, `${m.hits} hits!`, '#fde047'); }
      }
    }

    // ---- cutting ---------------------------------------------------------------------------------------------------
    const cutBy = (h: StageHand, i: number, pc: Piece, t: number) => {
      const p = h.p, own = team ? 0 : p, crit = h.speed > CRIT_SPEED && mode !== 'zen'; // Zen has no jolts: no criticals, no hit-stop
      if (pc.kind === 'bomb') {
        hitStop(130);
        pc.state = 'off'; g.combo[p] = 0; g.assist[p] = Math.min(1, g.assist[p] + 0.15);
        if (rules.lives) lose(pc.x); else g.scores[own] = Math.max(0, g.scores[own] - 5);
        sfx('impactPlate_heavy'); sfx('lowDown', { vol: 0.6 }); hud.flash('#ef4444'); hud.shake(1.5); bursts.burst(pc.x, pc.y, 0.5, '#ef4444', 50, 12);
        if (!rules.lives) hud.pop(pc.x, pc.y, '−5', '#ef4444');
        return;
      }
      if (pc.kind === 'power') {
        const power = POWERS[pc.power];
        pc.state = 'off'; g.power[pc.power][own] = power.time;
        hud.banner(power.name, 1300); hud.flash(power.hex); sfx('powerUp', { vol: 0.9 }); say('power_up'); hitStop(90);
        bursts.burst(pc.x, pc.y, 0.5, power.hex, 40, 10);
        return;
      }
      const points = (pc.kind === 'star' ? 5 : 1) * (storm ? 2 : 1) + (crit ? 1 : 0) + Math.floor(++g.combo[p] / 5);
      award(p, points);
      g.cut[p]++; g.bestCombo[p] = Math.max(g.bestCombo[p], g.combo[p]); g.assist[p] = Math.max(0, g.assist[p] - 0.04);
      hitSound(pc.kind === 'star' ? 'powerUp' : crit ? 'impactPunch_heavy' : 'impactSoft_heavy', g.combo[p], crit ? 0.9 : 0.7);
      // (No hit-stop on ordinary cuts or criticals: a fast player lands several a second, and the game stuttered.
      // The clock only catches its breath for the rare things — a star, a power-up, a bomb, the melon going off.)
      if (crit) { g.crits[p]++; hud.pop(pc.x, pc.y + 0.5, 'Critical!', '#fb923c'); }
      if (pc.kind === 'star') hitStop(70);
      // One swing, several fruit: the chain stays open for a moment after each cut and pays when it closes.
      const chain = g.chain[i];
      chain.n = t < chain.until ? chain.n + 1 : 1; chain.until = t + 0.28; chain.x = pc.x; chain.y = pc.y;
      // Cutting within a breath of your partner: a team thing.
      if (team && t - g.lastCut[1 - p] < 0.35 && t - g.lastCut[p] > 0.35) { award(p, 2); hud.pop(0, pc.y, 'Sync! +2', '#fde047'); sfx('select', { vol: 0.5 }); }
      g.lastCut[p] = t;
      if (pc.kind === 'star') { pc.state = 'off'; bursts.burst(pc.x, pc.y, 0.5, '#fde047', 36, 9); hud.pop(pc.x, pc.y, '+5', '#fde047'); return; }
      // The cut: `along` is the swipe direction; each half keeps one side of the plane through the fruit's centre.
      const len = Math.hypot(h.x - h.px, h.y - h.py) || 1;
      pc.along.set((h.x - h.px) / len, (h.y - h.py) / len, 0);
      pc.base.copy(pc.whole.getLocalRotation());
      pc.state = 'cut'; pc.age = 0;
      pc.halves.forEach((half, k) => {
        const s = k ? -1 : 1, fling = crit ? 5 : 3.6;
        half.nx = -pc.along.y * s; half.ny = pc.along.x * s;
        // Apart from the first frame (a gap you can see), thrown clear of each other, and gone only when they have fallen out of sight.
        Object.assign(half, { x: pc.x + half.nx * 0.16, y: pc.y + half.ny * 0.16, vx: pc.vx + half.nx * fling, vy: Math.max(pc.vy * 0.4, 0) + half.ny * fling + 2.5 });
      });
      bursts.burst(pc.x, pc.y, 0.5, pc.flesh, crit ? 26 : 14, crit ? 9 : 6);
      splat(pc.x, pc.y, pc.flesh, crit);
    };
    at.forEach((h, i) => {
      const chain = g.chain[i];
      if (chain.n && t >= chain.until) { // the swing is over: pay the chain
        if (chain.n >= 3) { award(h.p, chain.n); g.bestSlash[h.p] = Math.max(g.bestSlash[h.p], chain.n); hud.pop(chain.x, chain.y + 0.9, `${chain.n} fruit slash! +${chain.n}`, '#a3e635'); sfx('confirmation', { vol: 0.6 }); }
        chain.n = 0;
      }
      if (t < 0 || ending || !h.on || h.speed < SLICE_SPEED) return;
      const reach = R * (1.25 + 0.4 * g.assist[h.p]);
      for (const pc of pieces) {
        // Fruit is judged kindly (anywhere along the last ~100ms of the swing); a bomb only if this very step went through its core.
        if (pc.state !== 'whole' || (!team && pc.zone !== h.p) || !(pc.kind === 'bomb' ? segDist(pc.x, pc.y, h.px, h.py, h.x, h.y) < R * 0.9 : swept(h, pc.x, pc.y, reach))) continue;
        cutBy(h, i, pc, t);
        if (g.over) return;
      }
    });

    // ---- everything in the air ---------------------------------------------------------------------------------------
    for (const pc of pieces) {
      const own = team ? 0 : pc.zone, dt = real * (g.power.freeze[own] > 0 ? 0.4 : 1), grav = GRAVITY * rules.gravity * (moon ? 0.45 : 1);
      if (pc.state === 'wait' && (pc.wait -= dt) <= 0) pc.state = 'whole';
      if (show(pc.whole, pc.state === 'whole')) {
        pc.vy += grav * dt; pc.x += pc.vx * dt; pc.y += pc.vy * dt;
        pc.rx += pc.spin * dt * DEG; pc.ry += pc.spin * dt * 0.7 * DEG;
        pc.whole.setLocalPosition(pc.x, pc.y, 0);
        pc.whole.setLocalEulerAngles(pc.rx, pc.ry, 0);
        if (pc.y < -H / 2 - 2 * R && pc.vy < 0) { // dropped
          pc.state = 'off';
          if (pc.kind === 'fruit') { g.combo[pc.zone] = 0; g.assist[pc.zone] = Math.min(1, g.assist[pc.zone] + 0.12); lose(pc.x); }
        }
      }
      if (pc.halo && show(pc.halo, pc.state === 'whole')) {
        const k = R * (1.15 + 0.12 * Math.sin(t * 9));
        pc.halo.setLocalPosition(pc.x, pc.y, -0.2); pc.halo.setLocalScale(k, k, 1); tint(pc.halo, POWERS[pc.power].hex);
      }
      if (pc.state === 'cut' && (pc.age += dt) > 0.4 && pc.halves.every((h) => h.y < -H / 2 - 2 * R || Math.abs(h.x) > 10)) pc.state = 'off';
      // Each half swings open about the line of the cut, so its cut face rolls round to face the camera.
      const open = Math.min(1.25, pc.age * 3.2), cos = Math.cos(open), sin = Math.sin(open);
      pc.halves.forEach((half, k) => {
        const on = pc.state === 'cut';
        show(half.obj, on);
        if (!on) return;
        half.vy += grav * dt; half.x += half.vx * dt; half.y += half.vy * dt;
        half.obj.setLocalPosition(half.x, half.y, 0);
        half.obj.setLocalRotation(q.copy(turn.setFromAxisAngle(pc.along, (k ? open : -open) * DEG)).mul(pc.base));
        v.set(half.nx * cos, half.ny * cos, -sin); // the plane's normal, swung with the half
        setClip(half.obj, v.x, v.y, v.z, -(v.x * half.x + v.y * half.y));
      });
    }
    wet.forEach((w, i) => { if (w.life > 0) w.life -= real / 6; stains.place(i, w.x, w.y - (1 - w.life) * 0.25, -19, w.size); stains.fade(i, Math.max(0, Math.min(0.5, w.life * 0.9))); }); // they run a little as they dry
    stains.commit();
    bursts.update(real);
    passed(total());
    music.intensity(mode === 'zen' ? 0.35 : frenzy || ending ? 1 : 0.3 + Math.max(g.combo[0], g.combo[1]) / 16);
    if (rules.lives) hud('clock', '♥'.repeat(Math.max(0, g.lives)) || '0');
    scoreHud(hud, team ? 1 : n, g.scores);
    for (let p = 0; p < n; p++) {
      const own = team ? 0 : p, power = (Object.keys(POWERS) as Power[]).find((k) => g.power[k][own] > 0);
      hud.p('h', p, ending ? 'Hit it! Hit it!' : power ? `${POWERS[power].name.replace('!', '')} ${Math.ceil(g.power[power][own])}s` : frenzy && g.combo[p] < 5 ? 'Frenzy!' : team && teamBoost() > 1 ? `Team ×${teamBoost().toFixed(1)}` : comboText(g.combo[p]));
    }
  };
}
