// Rocket — every squat is a burn. Go deeper for a bigger kick; stop squatting and gravity wins.
// Score is the highest altitude you reach. One body-width of floor each, so it is compact.
import { players, tuning } from '../pose.ts';
import { hardness } from '../meta.ts';
import { backdrop, flat, instanced, lit, node, shapes, show } from '../engine.ts';
import { H, PLAYER_COLORS, W, bursts as makeBursts, divider, music, round, sfx, zoneX, type Game } from '../kit.ts';

const ROUND = 45, STARS = 90, GRAVITY = 5, DRAG = 0.35;

export default function rocket({ n, stage, onEnd, hud, scene }: Game) {
  const hard = hardness(stage); // heavier gravity on higher stages
  music.start('calm', undefined, 0.5);
  backdrop(scene, 'space');
  const stars = instanced(scene.root, shapes.circle(0.05, 6), STARS);
  const sky = Array.from({ length: STARS }, (_, i) => { stars.paint(i, '#e4e4e7'); return { x: (Math.random() - 0.5) * W, y: (Math.random() - 0.5) * H, depth: 0.3 + Math.random() * 0.7 }; });
  const groundLook = flat('#3f3f46'), hull = lit('#e4e4e7'), body = shapes.cylinder(0.38, 1.5), nose = shapes.cone(0.38, 0.8), fin = shapes.box(0.18, 0.7, 0.05);
  const ships = Array.from({ length: n }, (_, p) => {
    const ground = node(scene.root, shapes.quad(W / n - 0.4, 1.6), groundLook), ship = node(scene.root), paint = lit(PLAYER_COLORS[p]);
    node(ship, body, hull, [0, 0.2, 0]);
    node(ship, nose, paint, [0, 1.35, 0]);
    for (const side of [-1, 1]) node(ship, fin, paint, [side * 0.5, -0.35, 0]).setLocalEulerAngles(0, 0, side * 28.6);
    return { ground, ship };
  });
  divider(scene, n, '#3f3f46', -0.4);
  const g = { alt: [0, 0], vel: [0, 0], best: [0, 0], reps: [0, 0], down: [0, 0], deepest: [0, 0] }; // down: 0 standing, 1 in the squat, 2 fired — waiting to stand up
  const bursts = makeBursts(scene.root);
  const tick = round(hud, ROUND, () => onEnd(g.best.slice(0, n).map(Math.round)));

  return (rawDt: number) => {
    const dt = Math.min(rawDt, 0.05), t = tick(rawDt);
    if (t === null) return;

    for (let p = 0; p < n; p++) {
      const pl = players[p], x = zoneX(n, p);
      // One rep = down past the crouch line, then back up to standing. Depth of the squat sets the size of the burn.
      // The engine fires the moment your legs start to drive — not when you arrive back at standing, half a second later.
      if (g.down[p] === 0 && pl.lift < tuning.crouch) g.down[p] = 1;
      if (g.down[p] === 1) g.deepest[p] = Math.min(g.deepest[p], pl.lift);
      if (g.down[p] === 2 && pl.lift > -tuning.standBand) g.down[p] = 0;
      const charge = g.down[p] === 1 ? Math.min(1, (tuning.crouch - g.deepest[p]) / 0.6) : 0;
      if (g.down[p] === 1 && ((pl.liftV > tuning.riseFast * 0.8 && pl.lift > g.deepest[p] + 0.12) || pl.lift > -tuning.standBand)) {
        const depth = charge;
        g.down[p] = 2; g.deepest[p] = 0;
        if (t >= 0) { g.vel[p] += 8 + 7 * depth; g.reps[p]++; sfx('laser', { vol: 0.5, rate: 0.5 + depth * 0.4 }); sfx('impactSoft_heavy', { vol: 0.6 }); bursts.burst(x, -2.6, 0.5, '#fb923c', 16 + 16 * depth, 6); }
      }
      g.vel[p] -= (GRAVITY * hard + DRAG * g.vel[p]) * dt;
      g.alt[p] = Math.max(0, g.alt[p] + g.vel[p] * dt);
      if (g.alt[p] === 0) g.vel[p] = Math.max(0, g.vel[p]);
      g.best[p] = Math.max(g.best[p], g.alt[p]);

      const { ship, ground } = ships[p];
      if (show(ship, pl.present)) {
        ship.setLocalScale(1 + charge * 0.18, 1 - charge * 0.22, 1); // the rocket coils as you sink: the squat is visibly loading the burn
        ship.setLocalPosition(x, -1.6 + Math.max(-0.6, Math.min(1.2, g.vel[p] * 0.08)), 0);
        ship.setLocalEulerAngles(0, 0, Math.sin(t * 9) * 1.15 * Math.min(10, g.vel[p]));
      }
      ground.setLocalPosition(x, -3.2 - g.alt[p] * 0.6, -0.5);
      if (g.vel[p] > 1 && Math.random() < 0.5) bursts.burst(x, -2.5, 0.2, '#fbbf24', 1, 2);
      if (charge > 0.1 && t >= 0 && Math.random() < charge) bursts.burst(x + (Math.random() - 0.5) * 1.6, -2.9, 0.2, '#fb923c', 1, 1.5);
      hud.p('s', p, pl.present ? `${Math.round(g.alt[p])} m` : 'Step into view');
      hud.p('h', p, t < 0 ? 'Squat to launch' : g.down[p] === 1 ? 'Drive up!' : `${g.reps[p]} squats · best ${Math.round(g.best[p])} m`);
    }

    // Stars stream past at the speed of the faster rocket; nearer ones move more.
    const flow = Math.max(g.vel[0], n === 2 ? g.vel[1] : 0, 0.3);
    sky.forEach((s, i) => {
      s.y -= flow * s.depth * 0.25 * dt;
      if (s.y < -H / 2) { s.y += H; s.x = (Math.random() - 0.5) * W; }
      stars.place(i, s.x, s.y, -1, s.depth * 1.6);
    });
    stars.commit();
    bursts.update(dt);
    music.intensity(0.3 + Math.max(g.vel[0], g.vel[1]) / 20);
  };
}
