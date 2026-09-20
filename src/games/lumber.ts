// Lumberjack — the woodchop. A log stands on the block with a stripe painted across it: that is the cut it wants.
// Wind up high on one side and chop down across your body to the other, along the stripe, and it splits — a hard,
// fast chop splits it clean; a soft one only cracks it and it needs another. The stripe changes sides, so your trunk
// turns both ways. Thick logs take two, golden logs pay five, and the last ten seconds are kindling: anything goes.
// Two players chop a block each; a team shares the woodpile (one score), rivals race.
import { Quat, Vec3, type Entity } from 'playcanvas';
import { players } from '../pose.ts';
import { hardness } from '../meta.ts';
import { chopper } from '../reps.ts';
import { backdrop, clippable, flat, lit, node, setClip, shapes, show, tint } from '../engine.ts';
import { bestLine, bursts as makeBursts, comboText, divider, hands as makeHands, hitSound, hitStop, music, round, say, sfx, zoneX, type Game } from '../kit.ts';

const ROUND = 60, KINDLING = 10, BLOCK_Y = -2.6, LOG_H = 2.4, GRAVITY = -14;
const q = new Quat(), AXIS = new Vec3(0, 0, 1);
type Log = { state: 'idle' | 'in' | 'ready' | 'split'; dir: number; need: number; gold: boolean; slide: number; age: number; whole: Entity; stripe: Entity; halves: { e: Entity; x: number; y: number; vx: number; vy: number; spin: number; a: number }[] };

export default function lumber({ n, stage, team, best, onEnd, hud, scene }: Game) {
  const hard = hardness(stage);
  backdrop(scene, 'forest');
  scene.ambient('#ffffff', 0.75);
  if (!team) divider(scene, n, '#1c1917', -0.5, 0.05);
  const bark = lit('#8a3b12'), rings = flat('#fcd9a0'), heart = flat('#d9a066'), disc = shapes.circle(1, 28), trunk = shapes.cylinder(0.75, LOG_H, 14), stripeLook = flat('#fef3c7', { opacity: 0.95 }), blockLook = lit('#57534e');
  const yards = Array.from({ length: n }, (_, p) => {
    const x = zoneX(n, p);
    node(scene.root, shapes.cylinder(1.5, 1.1, 18), blockLook, [x, BLOCK_Y - 0.55, -1]);
    node(scene.root, disc, flat('#78716c'), [x, BLOCK_Y, -0.9]).setLocalScale(1.5, 0.36, 1); // the top of the block, as if seen from a little above
    const make = (): Log => {
      const whole = node(scene.root, trunk, bark, [x, BLOCK_Y + LOG_H / 2, 0]), stripe = node(whole, shapes.quad(2.3, 0.2), stripeLook, [0, 0, 0.8]);
      node(whole, disc, rings, [0, LOG_H / 2, 0.78]).setLocalScale(0.75, 0.2, 1); node(whole, disc, heart, [0, LOG_H / 2, 0.79]).setLocalScale(0.4, 0.1, 1); // the sawn end, with its rings
      const halves = [0, 1].map(() => { const e = node(scene.root, trunk, bark); clippable(e, '#fde68a'); e.enabled = false; return { e, x: 0, y: 0, vx: 0, vy: 0, spin: 0, a: 0 }; });
      whole.enabled = false;
      return { state: 'idle', dir: 1, need: 1, gold: false, slide: 0, age: 0, whole, stripe, halves };
    };
    return { x, logs: [make(), make()], now: 0, chop: chopper(), combo: 0, best: 0, split: 0, clean: 0, last: 1, score: 0 };
  });
  const hands = makeHands(scene, n, undefined, 7), bursts = makeBursts(scene.root), passed = bestLine(hud, best);
  const total = () => (team ? yards.reduce((a, y) => a + y.score, 0) : Math.max(...yards.map((y) => y.score)));
  const tick = round(hud, ROUND, () => {
    music.stop();
    onEnd(team ? yards.map(() => total()) : yards.map((y) => y.score), yards.map((y) => [`${y.split} logs split`, y.split ? `${Math.round((100 * y.clean) / y.split)}% clean cuts` : '', y.best >= 4 ? `Best run ${y.best}` : ''].filter(Boolean)));
  });
  music.start('arcade', undefined, 0.35);
  let kindling = false;

  const serve = (y: (typeof yards)[number], t: number) => {
    const log = y.logs[y.now], thick = !kindling && t > 18 && Math.random() < 0.25, gold = !kindling && t > 10 && Math.random() < 0.1;
    // Teach by alternating; later the side is a surprise, but never the same way four times running.
    y.last = t < 12 ? -y.last : Math.random() < 0.5 ? 1 : -1;
    Object.assign(log, { state: 'in', dir: y.last, need: thick ? 2 : 1, gold, slide: 1, age: 0 });
    log.whole.setLocalScale(thick ? 1.35 : kindling ? 0.7 : 1, 1, thick ? 1.35 : kindling ? 0.7 : 1);
    log.stripe.setLocalEulerAngles(0, 0, -log.dir * 38); show(log.stripe, !kindling);
    tint(log.whole, gold ? '#f59e0b' : '#7c2d12', 'diffuse'); tint(log.stripe, '#fef3c7');
  };

  return (rawDt: number) => {
    const dt = Math.min(rawDt, 0.05), t = tick(rawDt);
    if (t === null) return;
    hands.update(dt);
    if (!kindling && t > ROUND - KINDLING) { kindling = true; hud.banner('Kindling · chop any way you like!', 1800); say('hurry_up'); }
    yards.forEach((y, p) => {
      const log = y.logs[y.now], pl = players[p];
      if (t >= 0 && log.state === 'idle') serve(y, t);
      if (log.state === 'in') { log.slide = Math.max(0, log.slide - dt * (kindling ? 7 : 3.5) * hard); show(log.whole, true); log.whole.setLocalPosition(y.x + log.slide * 7 * (p ? 1 : -1), BLOCK_Y + LOG_H / 2, 0); if (log.slide === 0) { log.state = 'ready'; sfx('impactWood_medium', { vol: 0.35 }); } }
      const hit = t >= 0 && pl.present ? y.chop(pl.hands, t) : null;
      if (hit && log.state === 'ready') {
        if (!kindling && hit.dir !== log.dir) { y.combo = 0; hud.pop(y.x, 0.6, 'Other way!', '#fb923c'); sfx('impactWood_heavy', { vol: 0.4, rate: 1.5 }); hud.shake(0.3); }
        else if (hit.power < 0.32 && !kindling || --log.need > 0) { // cracked, not split
          log.need = Math.max(1, log.need); tint(log.stripe, '#1c1917'); sfx('impactWood_heavy', { vol: 0.6 }); bursts.burst(y.x, BLOCK_Y + LOG_H * 0.7, 1, '#fde68a', 8, 4); hud.pop(y.x, 0.6, hit.power < 0.32 ? 'Harder!' : 'Again!', '#fde68a'); hud.shake(0.3);
        } else {
          const clean = hit.power > 0.6, points = (log.gold ? 5 : 1) + (clean ? 1 : 0) + Math.floor(++y.combo / 5);
          y.score += points; y.split++; if (clean) y.clean++; y.best = Math.max(y.best, y.combo);
          hitSound('impactWood_heavy', y.combo, 0.9); if (clean || log.gold) { hitStop(log.gold ? 90 : 45); hud.shake(0.5); }
          bursts.burst(y.x, BLOCK_Y + LOG_H / 2, 1, log.gold ? '#fde047' : '#fde68a', clean ? 30 : 16, clean ? 10 : 7);
          hud.pop(y.x, 1, `${clean ? 'Clean! ' : ''}+${points}`, log.gold ? '#fde047' : clean ? '#a3e635' : '#ffffff');
          // The two halves: the same log twice, each keeping its own side of the cut, thrown apart and tumbling.
          log.state = 'split'; log.age = 0; show(log.whole, false);
          const scale = log.whole.getLocalScale().x;
          log.halves.forEach((h, k) => { const s = k ? -1 : 1; Object.assign(h, { x: y.x, y: BLOCK_Y + LOG_H / 2, vx: s * hit.dir * (3 + hit.power * 4), vy: 4 + hit.power * 3 + k, spin: s * hit.dir * (90 + hit.power * 160), a: 0 }); h.e.setLocalScale(scale, 1, scale); tint(h.e, log.gold ? '#f59e0b' : '#7c2d12', 'diffuse'); });
          y.now = 1 - y.now; // the other log is already on its way in
        }
      }
      for (const lg of y.logs) {
        if (lg.state !== 'split') { for (const h of lg.halves) show(h.e, false); continue; }
        lg.age += dt;
        lg.halves.forEach((h, k) => {
          if (!show(h.e, lg.age < 1.1)) return;
          h.vy += GRAVITY * dt; h.x += h.vx * dt; h.y += h.vy * dt; h.a += h.spin * dt;
          h.e.setLocalPosition(h.x, h.y, 0); h.e.setLocalRotation(q.setFromAxisAngle(AXIS, h.a));
          // The cut runs along the stripe; its plane turns with the half so each keeps exactly the piece it started with.
          const tilt = (-lg.dir * 38 + 90 + h.a) / 57.3, s = k ? -1 : 1, nx = Math.cos(tilt) * s, ny = Math.sin(tilt) * s;
          setClip(h.e, nx, ny, 0, -(nx * h.x + ny * h.y));
        });
        if (lg.age >= 1.1) lg.state = 'idle';
      }
      hud.p('s', team ? 0 : p, pl.present ? String(team ? total() : y.score) : 'Step into view');
      hud.p('h', p, t < 0 ? 'Chop down along the stripe' : kindling ? 'Kindling!' : comboText(y.combo) || (log.state === 'ready' ? (log.dir > 0 ? 'High left → low right' : 'High right → low left') : ''));
    });
    bursts.update(dt);
    passed(total());
    music.intensity(kindling ? 1 : 0.3 + Math.min(0.6, Math.max(...yards.map((y) => y.combo)) / 15));
  };
}
