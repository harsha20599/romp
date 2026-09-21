// Forge — slow strength. Sink into a squat and hold it: the blade on the anvil heats while you are down, faster the
// deeper you sit, and cools if you come up early. When it glows white the call is "Strike!" — drive up hard and the
// hammer falls; the harder you rise, the better the blade. Then the blade is quenched and you MUST rest a few seconds
// (shake your legs out) before the next one, which wants a longer hold. Rocket is the explosive squat; this is the slow one.
// Two players: a team shares one anvil and it only heats while BOTH are down — you are as strong as your partner —
// with a bonus for driving up together. Rivals get an anvil each.
import type { Entity } from 'playcanvas';
import { players, tuning } from '../pose.ts';
import { hardness } from '../meta.ts';
import { squatDepth } from '../reps.ts';
import { FLOOR, ROOM, clearing, fade, fitted, flat, glowAs, glowLook, lit, node, shade, shapes, show, tint, type View } from '../engine.ts';
import { bestLine, bursts as makeBursts, figure, hitSound, hitStop, music, round, say, sfx, zoneX, type Game } from '../kit.ts';

const ROUND = 75, WINDOW = 2.6, QUENCH = 3.5;
const HEAT_HEX = ['#3f3f46', '#7f1d1d', '#dc2626', '#fb923c', '#fde047', '#fffbeb']; // cold steel → white hot
type Smithy = { x: number; who: number[]; phase: 'heat' | 'strike' | 'quench'; heat: number; timer: number; blade: number; hold: number; swing: number; blades: number; perfect: number; longest: number; nag: number; bladeE: Entity; glowE: Entity; hammer: Entity; meter: Entity; fireGlow: Entity; risen: number[] };

export const view: View = ROOM;

export default async function forge({ n, stage, team, best, onEnd, hud, scene }: Game) {
  const hard = hardness(stage), C = '/assets/camp/';
  // A smithy at the edge of the woods at dusk: a hut behind, the forge fire, the anvil, a quench barrel, tools about.
  await clearing(scene, true);
  const [anvil, hammerModel, fire, hut, barrel, grind, chest, bench] = await Promise.all([fitted(C + 'workbench-anvil.glb', 2.7, true), fitted(C + 'tool-hammer-upgraded.glb', 2.4), fitted(C + 'campfire-pit.glb', 2.6, true), fitted(C + 'structure.glb', 10, true), fitted(C + 'barrel-open.glb', 1.9, true), fitted(C + 'workbench-grind.glb', 2.6, true), fitted(C + 'chest.glb', 1.8, true), fitted(C + 'workbench.glb', 2.8, true)]);
  const put = (template: Entity, x: number, z: number, ry = 0) => { const e = template.clone() as Entity; e.setLocalPosition(x, FLOOR, z); e.setLocalEulerAngles(0, ry, 0); scene.root.addChild(e); return e; };
  const shared = n === 2 && team, spots = shared ? [-5.4, 5.4] : n === 2 ? [-6.2, 1.8] : [-3.6];
  const bodies = Array.from({ length: n }, (_, p) => figure(scene, p, { x: spots[p], y: 0.05, scale: 1.1 }));
  const dark = shade(), steel = lit('#d4d4d8', { emissive: '#ffffff', glow: 1 }), rail = flat('#18181b', { opacity: 0.8 }), fill = flat('#fb923c'), ember = glowLook('#fb923c', 1);
  put(hut, shared || n === 1 ? 0.5 : 0, -7.5, 0); put(bench, n === 1 ? 7 : 0, -4.5, -20); put(chest, n === 1 ? -7.5 : 0, -3.5, 30);
  const smithies: Smithy[] = (shared ? [{ x: 0, who: [0, 1] }] : Array.from({ length: n }, (_, p) => ({ x: n === 2 ? zoneX(n, p) + 2.2 : 2.6, who: [p] }))).map(({ x, who }) => {
    put(anvil, x, 0, 0); put(fire, x - 2.6, -2.6); put(barrel, x + 2.7, -1.4); put(grind, x + 0.4, -4.2, 15);
    node(scene.root, dark.mesh, dark.look, [x, FLOOR + 0.03, 0]).setLocalScale(4.2, 1, 3);
    const root = node(scene.root, undefined, undefined, [x, FLOOR, 0]);
    const glowE = node(root, shapes.quad(2, 2), ember, [0, 2.05, 0.6]), bladeE = node(root, shapes.box(2.1, 0.12, 0.34), steel, [0.05, 1.98, 0.35]), fireGlow = node(root, shapes.quad(2, 2), ember, [-2.6, 1.0, -2.4]);
    const hammer = node(root, undefined, undefined, [-1.5, 2.0, 0.5]), head = hammerModel.clone() as Entity; head.setLocalPosition(0, 1.1, 0); hammer.addChild(head);
    node(root, shapes.quad(0.34, 3.3), rail, [2.1, 3.3, 0.3]); const meter = node(root, shapes.quad(0.22, 3.2), fill, [2.1, 3.3, 0.31]);
    return { x, who, phase: 'heat', heat: 0, timer: 0, blade: 0, hold: 0, swing: 0, blades: 0, perfect: 0, longest: 0, nag: 0, bladeE, glowE, hammer, meter, fireGlow, risen: [] };
  });
  const bursts = makeBursts(scene.root), passed = bestLine(hud, best), scores = [0, 0];
  const tick = round(hud, ROUND, () => {
    music.stop();
    onEnd(shared ? [scores[0], scores[0]] : scores.slice(0, n), Array.from({ length: n }, (_, p) => { const s = smithies[shared ? 0 : p]; return [`${s.blades} blade${s.blades === 1 ? '' : 's'} forged`, s.perfect ? `${s.perfect} perfect strike${s.perfect > 1 ? 's' : ''}` : '', `Longest hold ${s.longest.toFixed(1)}s`].filter(Boolean); }));
  });
  music.start('calm', undefined, 0.5);

  return (rawDt: number) => {
    const dt = Math.min(rawDt, 0.05), t = tick(rawDt);
    if (t === null) return;
    for (const b of bodies) b.update();
    let hottest = 0;
    for (const s of smithies) {
      const crew = s.who.map((p) => players[p]), depths = crew.map((pl) => (pl.present ? squatDepth(pl.lift) : 0)), down = Math.min(...depths), need = (2.4 + s.blade * 0.55) * Math.sqrt(hard), own = shared ? 0 : s.who[0];
      if (s.phase === 'heat' && t >= 0) {
        // Heat comes from depth, held: the weakest squat in the crew sets the pace, and coming up lets it cool.
        if (down > 0.35) { s.heat = Math.min(1, s.heat + (dt * (0.45 + 0.75 * down)) / need); s.hold += dt; s.longest = Math.max(s.longest, s.hold); scores[own] += dt * (1 + down); }
        else { s.heat = Math.max(0, s.heat - dt * 0.12); s.hold = 0; if (depths.some((d) => d > 0.15) && t - s.nag > 2.5) { s.nag = t; hud.pop(s.x, 0.4, shared && Math.max(...depths) > 0.35 ? 'Both of you — down!' : 'Deeper!', '#fb923c'); } }
        if (s.heat >= 1) { s.phase = 'strike'; s.timer = WINDOW; s.risen = []; hud.banner('Strike!', 1000); sfx('zapThreeToneUp', { vol: 0.7 }); }
      } else if (s.phase === 'strike') {
        s.timer -= dt;
        crew.forEach((pl, k) => { if (s.risen[k] === undefined && (pl.liftV > tuning.riseFast * 0.7 || pl.lift > -0.2)) s.risen[k] = Math.max(pl.liftV, 0.5); });
        const allUp = crew.every((_, k) => s.risen[k] !== undefined);
        if (allUp || s.timer <= 0) {
          const drive = allUp ? Math.min(...s.risen) : 0, grade = drive > tuning.riseFast * 1.5 ? 2 : drive > tuning.riseFast * 0.7 ? 1 : 0, together = shared && allUp && s.timer > WINDOW - 1.2;
          const points = [4, 7, 10][grade] + s.blade + (together ? 4 : 0);
          scores[own] += points; s.blades++; if (grade === 2) s.perfect++;
          s.swing = 1; s.phase = 'quench'; s.timer = QUENCH; s.hold = 0;
          hitStop(grade === 2 ? 140 : 90); hud.shake(0.6 + grade * 0.5); hud.flash('#fb923c'); hitSound('impactMetal_heavy', s.blades * 2, 0.9); sfx('impactBell_heavy', { vol: 0.5 + grade * 0.2 });
          bursts.burst(s.x, FLOOR + 2.1, 0.6, '#fde047', 30 + grade * 25, 9 + grade * 3); bursts.burst(s.x, FLOOR + 2.1, 0.6, '#fb923c', 20, 6);
          hud.pop(s.x, 0.2, `${['Forged', 'Good steel!', 'Perfect strike!'][grade]}${together ? ' · together!' : ''} +${points}`, grade === 2 ? '#fde047' : '#ffffff');
          if (grade === 2) say('congratulations');
        }
      } else if (s.phase === 'quench') {
        s.timer -= dt; s.heat = Math.max(0, s.heat - dt / 1.2);
        if (s.timer < QUENCH - 0.5 && s.timer > QUENCH - 0.6) { sfx('lowDown', { vol: 0.4, rate: 1.6 }); bursts.burst(s.x + 2.7, FLOOR + 1.9, -1.2, '#e2e8f0', 30, 4); } // into the water: steam
        if (s.timer <= 0) { s.phase = 'heat'; s.blade++; s.heat = 0; }
      }
      hottest = Math.max(hottest, s.heat);
      // What you see: the blade's colour is its heat, the hammer hangs ready and falls on the strike, the meter fills.
      const band = s.heat * (HEAT_HEX.length - 1), hex = HEAT_HEX[Math.round(band)];
      tint(s.bladeE, s.phase === 'quench' && s.timer < QUENCH - 0.6 ? '#000000' : hex, 'emissive'); // the steel glows with its heat
      s.bladeE.setLocalScale(1 + s.blade * 0.04, 1, 1 + s.blade * 0.1);
      { const f = 1.5 + s.heat * 1.6 + Math.sin(t * 13) * 0.12; s.fireGlow.setLocalScale(f, f * 1.25, 1); glowAs(s.fireGlow, '#fb923c', 0.55 + 0.45 * s.heat); if (Math.random() < dt * (3 + s.heat * 14)) bursts.burst(s.x - 2.6, FLOOR + 0.9, -2.2, Math.random() < 0.5 ? '#fb923c' : '#fde047', 1, 2.5); } // the fire breathes with the heat; embers rise
      if (show(s.glowE, s.heat > 0.08)) { const k = 1.2 + s.heat * 2.6 + Math.sin(t * 11) * 0.08 * s.heat; s.glowE.setLocalScale(k * 1.4, k * 0.7, 1); }
      s.swing = Math.max(0, s.swing - dt * 5);
      s.hammer.setLocalEulerAngles(0, 0, s.phase === 'strike' ? 38 + Math.sin(t * 20) * 3 : s.swing > 0 ? -62 * Math.sin(Math.min(1, (1 - s.swing) * 2.2) * Math.PI * 0.5) + 30 * (1 - s.swing) : 30);
      s.meter.setLocalScale(1, Math.max(0.01, s.heat), 1); s.meter.setLocalPosition(2.1, 3.3 - 1.6 * (1 - s.heat), 0.31); tint(s.meter, s.phase === 'strike' ? '#fffbeb' : '#fb923c'); fade(s.meter, 1);
      for (const p of s.who) hud.p('h', p, t < 0 ? 'Squat and hold to heat the blade' : s.phase === 'strike' ? 'Drive up!' : s.phase === 'quench' ? `Rest · shake your legs out · ${Math.ceil(s.timer)}` : down > 0.35 ? `Hold it… ${Math.round(s.heat * 100)}%` : 'Sink into a squat');
    }
    for (let p = 0; p < (shared ? 1 : n); p++) hud.p('s', p, players[p].present ? String(Math.round(scores[p])) : 'Step into view');
    bursts.update(dt);
    passed(Math.max(scores[0], scores[1]));
    music.intensity(0.25 + hottest * 0.6);
  };
}
