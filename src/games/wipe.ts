// Wipe — the screen is filthy; scrub it clean with both hands. Grime creeps back, faster every layer.
// Clear your whole side for a bonus and a fresh, tougher layer. Reach is body-relative, so it is compact.
import { hardness } from '../meta.ts';
import { backdrop, instanced, shapes } from '../engine.ts';
import { bursts as makeBursts, divider, hands as makeHands, music, round, scoreHud, sfx, type Game } from '../kit.ts';

const ROUND = 60, COLS = 16, ROWS = 8, SCRUB = 1.15; // SCRUB = radius a hand cleans, in tiles
const LAYERS = ['#78716c', '#57534e', '#7c2d12', '#365314', '#1e3a8a'];

export default function wipe({ n, stage, onEnd, hud, scene }: Game) {
  const hard = hardness(stage); // grime comes back sooner on higher stages
  music.start('calm', undefined, 0.6);
  backdrop(scene, 'tiles');
  const tiles = Array.from({ length: COLS * ROWS }, (_, i) => {
    const x = (i % COLS) - COLS / 2 + 0.5, y = Math.floor(i / COLS) - ROWS / 2 + 0.5 - 0.4;
    return { x, y, zone: n === 2 && x > 0 ? 1 : 0, dirt: 1, cleanFor: 0 };
  });
  const grime = instanced(scene.root, shapes.quad(0.96, 0.96), COLS * ROWS, 0.92);
  const g = { scores: [0, 0], layer: [0, 0], said: [0, 0], painted: [-1, -1] };
  const hands = makeHands(scene, n, undefined, 0), bursts = makeBursts(scene.root);
  divider(scene, n, '#fafafa', 0.5, 0.06);
  const tick = round(hud, ROUND, () => onEnd(g.scores.slice(0, n)));

  return (rawDt: number) => {
    const dt = Math.min(rawDt, 0.05), t = tick(rawDt);
    if (t === null) return;
    const at = hands.update(dt), left = [0, 0], total = [0, 0];

    tiles.forEach((tile, i) => {
      const z = tile.zone;
      if (t >= 0 && tile.dirt > 0.5 && at.some((h) => h.on && h.p === z && Math.hypot(h.x - tile.x, h.y - tile.y) < SCRUB)) {
        tile.dirt = 0; tile.cleanFor = 0; g.scores[z]++;
        if (Math.random() < 0.3) bursts.burst(tile.x, tile.y, 0.5, '#e0f2fe', 4, 3);
        if (Math.random() < 0.25) sfx('glass', { vol: 0.25 }) || sfx('tick', { vol: 0.3 });
      } else if (tile.dirt < 1 && (tile.cleanFor += dt) > (4 - Math.min(3, g.layer[z] * 0.6)) / hard) tile.dirt = Math.min(1, tile.dirt + dt * 0.8); // grime creeps back
      total[z]++;
      if (tile.dirt > 0.5) left[z]++;
      grime.place(i, tile.x, tile.y, 0, tile.dirt);
      if (g.painted[z] !== g.layer[z]) grime.paint(i, LAYERS[g.layer[z] % LAYERS.length]);
    });
    grime.commit();
    g.painted = [...g.layer];

    for (let p = 0; p < n; p++) {
      if (t >= 0 && left[p] <= total[p] * 0.04) { // spotless: bonus, and a tougher layer drops in
        g.scores[p] += 20; g.layer[p]++; g.said[p] = t + 1.2;
        tiles.forEach((tile) => tile.zone === p && ((tile.dirt = 1), (tile.cleanFor = 0)));
        sfx('confirmation'); hud.flash('#e0f2fe');
      }
      hud.p('h', p, t < 0 ? 'Scrub it clean' : g.said[p] > t ? 'Sparkling! +20' : `${Math.round(100 - (100 * left[p]) / total[p])}% clean`);
    }
    bursts.update(dt);
    scoreHud(hud, n, g.scores);
  };
}
