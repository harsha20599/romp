// Lumberjack — the woodchop, in a clearing in the woods. A log stands on the stump with a stripe painted across it:
// that is the cut it wants. Wind up high on one side and chop down across your body to the other, along the stripe,
// and it splits — a hard, fast chop splits it clean; a soft one only cracks it and it needs another. The stripe
// changes sides, so your trunk turns both ways. Thick logs take two, golden logs pay five, and the last ten seconds
// are kindling: anything goes. Everything you split lands on the woodpile.
// You hold an AXE, not two dots: clasp your hands and it sits between them; one hand, and it goes to that hand. It is
// steadied hard — two hands held together hide each other from the camera, and the raw points jump about.
import { Quat, Vec3, type Entity } from 'playcanvas';
import { players } from '../pose.ts';
import { hardness } from '../meta.ts';
import { chopper } from '../reps.ts';
import { FLOOR, ROOM, clearing, clippable, fitted, flat, glowLook, lit, node, setClip, shade, shapes, show, tint, type View } from '../engine.ts';
import { bestLine, bursts as makeBursts, comboText, hitSound, hitStop, music, round, say, sfx, zoneHalf, zoneX, type Game } from '../kit.ts';

const ROUND = 60, KINDLING = 10, BLOCK_Y = -2.5, LOG_H = 2.3, GRAVITY = -15;
const q = new Quat(), turn = new Quat(), AXIS = new Vec3(0, 0, 1), TIP = new Vec3(1, 0, 0);
type Log = { state: 'idle' | 'in' | 'ready' | 'split'; dir: number; need: number; gold: boolean; slide: number; age: number; whole: Entity; stripe: Entity; halves: { e: Entity; x: number; y: number; z: number; vx: number; vy: number; spin: number; a: number; b: number }[] };

export const view: View = ROOM;

export default async function lumber({ n, stage, team, best, onEnd, hud, scene }: Game) {
  const hard = hardness(stage), C = '/assets/camp/';
  await clearing(scene, false);
  const [stump, axeModel, plank, tent, fire, pileLogs] = await Promise.all([fitted(C + 'tree-trunk.glb', BLOCK_Y - FLOOR, true), fitted(C + 'tool-axe-upgraded.glb', 2.6), fitted(C + 'resource-planks.glb', 1.5, true), fitted(C + 'tent.glb', 5.5, true), fitted(C + 'campfire-pit.glb', 2.2, true), fitted('/assets/nature/log_stack.glb', 3, true)]);
  const put = (template: Entity, x: number, y: number, z: number, ry = 0) => { const e = template.clone() as Entity; e.setLocalPosition(x, y, z); e.setLocalEulerAngles(0, ry, 0); scene.root.addChild(e); return e; };
  put(tent, n === 1 ? -9 : 0, FLOOR, -9, 25); put(fire, n === 1 ? 7.5 : 0, FLOOR, -5); put(pileLogs, n === 1 ? -6.5 : -0.5, FLOOR, -3.5, 70);
  node(scene.root, shapes.quad(2, 2), glowLook('#fb923c', 0.8), [n === 1 ? 7.5 : 0, FLOOR + 0.9, -4.9]).setLocalScale(1.6, 2.0, 1); // the campfire's light
  const dark = shade(), bark = lit('#8a3b12'), rings = lit('#fcd9a0'), trunk = shapes.cylinder(0.72, LOG_H, 16), cap = shapes.cylinder(0.66, 0.04, 16), stripeLook = flat('#fef3c7', { opacity: 0.95 });
  const yards = Array.from({ length: n }, (_, p) => {
    const x = zoneX(n, p);
    put(stump, x, FLOOR, 0).setLocalScale(1.7, 1, 1.7); // a broad stump, exactly as tall as the chopping height
    node(scene.root, dark.mesh, dark.look, [x, FLOOR + 0.03, 0]).setLocalScale(4.4, 1, 3.2);
    const make = (): Log => {
      const whole = node(scene.root, trunk, bark, [x, BLOCK_Y + LOG_H / 2, 0]), stripe = node(whole, shapes.quad(2.2, 0.2), stripeLook, [0, 0, 0.74]);
      node(whole, cap, rings, [0, LOG_H / 2 + 0.02, 0]);
      const halves = [0, 1].map(() => { const e = node(scene.root, trunk, bark); clippable(e, '#fde68a'); e.enabled = false; return { e, x: 0, y: 0, z: 0, vx: 0, vy: 0, spin: 0, a: 0, b: 0 }; });
      whole.enabled = false;
      return { state: 'idle', dir: 1, need: 1, gold: false, slide: 0, age: 0, whole, stripe, halves };
    };
    // The woodpile: a plank lands on it for every log you split. Twelve deep, then it starts again a row higher.
    const pile = Array.from({ length: 12 }, (_, k) => { const e = put(plank, x + (p || n === 1 ? 4.6 : -4.6) + ((k % 3) - 1) * 0.55, FLOOR + Math.floor(k / 3) * 0.32, -1.2 - (k % 2) * 0.3, 90 + ((k * 37) % 20) - 10); e.enabled = false; return e; });
    const axe = axeModel.clone() as Entity; scene.root.addChild(axe);
    return { x, logs: [make(), make()], now: 0, chop: chopper(), combo: 0, best: 0, split: 0, clean: 0, last: 1, score: 0, pile, axe, grip: { x: 0, y: 0.2, seen: false, vy: 0 }, swing: 0, swingDir: 1 };
  });
  const bursts = makeBursts(scene.root), passed = bestLine(hud, best);
  const total = () => (team ? yards.reduce((a, y) => a + y.score, 0) : Math.max(...yards.map((y) => y.score)));
  const tick = round(hud, ROUND, () => {
    music.stop();
    onEnd(team ? yards.map(() => total()) : yards.map((y) => y.score), yards.map((y) => [`${y.split} logs split`, y.split ? `${Math.round((100 * y.clean) / y.split)}% clean cuts` : '', y.best >= 4 ? `Best run ${y.best}` : ''].filter(Boolean)));
  });
  music.start('arcade', undefined, 0.35);
  let kindling = false;

  const serve = (y: (typeof yards)[number], t: number) => {
    const log = y.logs[y.now], thick = !kindling && t > 18 && Math.random() < 0.25, gold = !kindling && t > 10 && Math.random() < 0.1;
    y.last = t < 12 ? -y.last : Math.random() < 0.5 ? 1 : -1; // teach by alternating; later the side is a surprise
    Object.assign(log, { state: 'in', dir: y.last, need: thick ? 2 : 1, gold, slide: 1, age: 0 });
    log.whole.setLocalScale(thick ? 1.35 : kindling ? 0.7 : 1, 1, thick ? 1.35 : kindling ? 0.7 : 1);
    log.stripe.setLocalEulerAngles(0, 0, -log.dir * 38); show(log.stripe, !kindling);
    tint(log.whole, gold ? '#f59e0b' : '#8a3b12', 'diffuse'); tint(log.stripe, '#fef3c7');
  };

  return (rawDt: number) => {
    const dt = Math.min(rawDt, 0.05), t = tick(rawDt);
    if (t === null) return;
    if (!kindling && t > ROUND - KINDLING) { kindling = true; hud.banner('Kindling · chop any way you like!', 1800); say('hurry_up'); }
    yards.forEach((y, p) => {
      const log = y.logs[y.now], pl = players[p], [a, b] = pl.hands, g = y.grip;
      // One grip point: between the hands when they are together, else the hand that is up and moving.
      const together = a.seen && b.seen && Math.hypot(a.x - b.x + 0.7, a.y - b.y) < 0.75, lead = !b.seen || (a.seen && Math.hypot(a.vx, a.vy) + a.y > Math.hypot(b.vx, b.vy) + b.y) ? a : b;
      const gx = together ? (a.x + b.x) / 2 : lead.x, gy = together ? (a.y + b.y) / 2 : lead.y, k = 1 - Math.exp(-dt * 24);
      g.seen = pl.present && (a.seen || b.seen);
      if (g.seen) { g.x += (gx - g.x) * k; g.y += (gy - g.y) * k; }
      // The axe: head up when the grip is high, swung through on a chop.
      y.swing = Math.max(0, y.swing - dt * 4);
      if (show(y.axe, g.seen)) {
        const ax = y.x + g.x * zoneHalf(n) * 0.8, ay = g.y * 3.6, lean = -g.x * 25 + (y.swing > 0 ? y.swingDir * -110 * Math.sin((1 - y.swing) * Math.PI) : 0);
        y.axe.setLocalPosition(ax, ay, 1.4); y.axe.setLocalEulerAngles(0, 0, lean);
      }
      if (t >= 0 && log.state === 'idle') serve(y, t);
      if (log.state === 'in') { log.slide = Math.max(0, log.slide - dt * (kindling ? 7 : 3.5) * hard); show(log.whole, true); log.whole.setLocalPosition(y.x, BLOCK_Y + LOG_H / 2 + log.slide * 7, 0); if (log.slide === 0) { log.state = 'ready'; sfx('impactWood_medium', { vol: 0.4 }); bursts.burst(y.x, BLOCK_Y, 0.8, '#d6c4a1', 6, 3); } } // it drops onto the stump
      const hit = t >= 0 && g.seen ? y.chop([{ x: g.x, y: g.y, vy: 0, seen: true }], t) : null;
      if (hit) { y.swing = 1; y.swingDir = hit.dir; }
      if (hit && log.state === 'ready') {
        if (!kindling && hit.dir !== log.dir) { y.combo = 0; hud.pop(y.x, 0.6, 'Other way!', '#fb923c'); sfx('impactWood_heavy', { vol: 0.4, rate: 1.5 }); hud.shake(0.3); }
        else if ((hit.power < 0.32 && !kindling) || --log.need > 0) { log.need = Math.max(1, log.need); tint(log.stripe, '#1c1917'); sfx('impactWood_heavy', { vol: 0.6 }); bursts.burst(y.x, BLOCK_Y + LOG_H * 0.7, 1, '#fde68a', 8, 4); hud.pop(y.x, 0.6, hit.power < 0.32 ? 'Harder!' : 'Again!', '#fde68a'); hud.shake(0.3); }
        else {
          const clean = hit.power > 0.6, points = (log.gold ? 5 : 1) + (clean ? 1 : 0) + Math.floor(++y.combo / 5);
          y.score += points; y.split++; if (clean) y.clean++; y.best = Math.max(y.best, y.combo);
          hitSound('impactWood_heavy', y.combo, 0.9); if (log.gold) hitStop(90); if (clean) hud.shake(0.5);
          bursts.burst(y.x, BLOCK_Y + LOG_H / 2, 1, log.gold ? '#fde047' : '#fde68a', clean ? 30 : 16, clean ? 10 : 7);
          hud.pop(y.x, 1, `${clean ? 'Clean! ' : ''}+${points}`, log.gold ? '#fde047' : clean ? '#a3e635' : '#ffffff');
          const stacked = y.pile[(y.split - 1) % y.pile.length]; show(stacked, true);
          log.state = 'split'; log.age = 0; show(log.whole, false);
          const scale = log.whole.getLocalScale().x;
          log.halves.forEach((h, i) => { const s = i ? -1 : 1; Object.assign(h, { x: y.x, y: BLOCK_Y + LOG_H / 2, z: 0, vx: s * hit.dir * (2.6 + hit.power * 3.5), vy: 4.5 + hit.power * 3 + i, spin: s * hit.dir * (80 + hit.power * 150), a: 0, b: 0 }); h.e.setLocalScale(scale, 1, scale); tint(h.e, log.gold ? '#f59e0b' : '#8a3b12', 'diffuse'); });
          y.now = 1 - y.now;
        }
      }
      for (const lg of y.logs) {
        if (lg.state !== 'split') { for (const h of lg.halves) show(h.e, false); continue; }
        lg.age += dt;
        lg.halves.forEach((h, i) => {
          if (!show(h.e, h.y > FLOOR - 3)) return;
          h.vy += GRAVITY * dt; h.x += h.vx * dt; h.y += h.vy * dt; h.z += (i ? 1.5 : -1.5) * dt; h.a += h.spin * dt; h.b += h.spin * 0.6 * dt;
          h.e.setLocalPosition(h.x, h.y, h.z); h.e.setLocalRotation(q.setFromAxisAngle(AXIS, h.a).mul(turn.setFromAxisAngle(TIP, h.b)));
          // The cut runs along the stripe; its plane turns with the half so each keeps exactly the piece it started with.
          const tilt = (-lg.dir * 38 + 90 + h.a) / 57.3, s = i ? -1 : 1, nx = Math.cos(tilt) * s, ny = Math.sin(tilt) * s;
          setClip(h.e, nx, ny, 0, -(nx * h.x + ny * h.y));
        });
        if (lg.age > 0.5 && lg.halves.every((h) => h.y <= FLOOR - 3)) lg.state = 'idle';
      }
      hud.p('s', team ? 0 : p, pl.present ? String(team ? total() : y.score) : 'Step into view');
      hud.p('h', p, t < 0 ? 'Chop down along the stripe' : kindling ? 'Kindling!' : comboText(y.combo) || (log.state === 'ready' ? (log.dir > 0 ? 'High left → low right' : 'High right → low left') : ''));
    });
    bursts.update(dt);
    passed(total());
    music.intensity(kindling ? 1 : 0.3 + Math.min(0.6, Math.max(...yards.map((y) => y.combo)) / 15));
  };
}
