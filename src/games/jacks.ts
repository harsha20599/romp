// Jack Attack — every jumping jack fires the cannon. Invaders come down in waves; a jack takes out the lowest one, a
// full jack (feet apart too) takes two, and in a team two jacks landed together clear a whole row. Arms alone count,
// so stepping jacks — no jumping — are a fair way to play. Let one reach you and a shield goes; lose all three and the
// wave resets. Between waves the game makes you breathe. Wave three is a boss.
import type { Entity } from 'playcanvas';
import { players } from '../pose.ts';
import { hardness } from '../meta.ts';
import { jacker } from '../reps.ts';
import { backdrop, flat, glowLook, node, shapes, show, tint } from '../engine.ts';
import { PLAYER_COLORS, bestLine, bursts as makeBursts, figure, hitSound, hitStop, music, round, say, sfx, zoneHalf, zoneX, type Game } from '../kit.ts';

const ROUND = 70, REST = 4, BREACH = 1.0, TOP = 4.0, POOL = 40;
const ROWS = ['#f472b6', '#fb923c', '#fde047', '#4ade80', '#38bdf8'];
type Invader = { on: boolean; zone: number; x: number; y: number; hp: number; row: number; boss: boolean; hurt: number; e: Entity; skin: Entity[] };

export default function jacks({ n, stage, team, best, onEnd, hud, scene }: Game) {
  const hard = hardness(stage);
  backdrop(scene, 'orbit', true);
  const bodies = Array.from({ length: n }, (_, p) => figure(scene, p, { x: zoneX(n, p), y: -0.35, scale: 0.95 }));
  const round_ = shapes.circle(0.42, 20), eye = shapes.circle(0.1, 10), leg = shapes.quad(0.12, 0.3), white = flat('#ffffff'), ink = flat('#0f0a2a'), skin = flat('#ffffff');
  const invaders: Invader[] = Array.from({ length: POOL }, () => {
    const e = node(scene.root, undefined, undefined, [0, 0, 0.9]), parts = [node(e, round_, skin)], pupil = shapes.circle(0.05, 8);
    for (const s of [-1, 1]) { node(e, eye, white, [s * 0.16, 0.06, 0.02]); node(e, pupil, ink, [s * 0.16, 0.04, 0.03]); parts.push(node(e, leg, skin, [s * 0.22, -0.46, -0.01])); }
    e.enabled = false;
    return { on: false, zone: 0, x: 0, y: 0, hp: 1, row: 0, boss: false, hurt: 0, e, skin: parts };
  });
  const beams = Array.from({ length: 6 }, () => { const e = node(scene.root, shapes.quad(2, 2), glowLook('#ffffff', 1), [0, 0, 1]); e.enabled = false; return { e, life: 0 }; });
  const bursts = makeBursts(scene.root), passed = bestLine(hud, best);
  const crews = (team ? [[0, 1].slice(0, n)] : Array.from({ length: n }, (_, p) => [p])).map((who, k) => ({ who, x: team ? 0 : zoneX(n, k), half: team ? 7 : zoneHalf(n) - 0.6, wave: 0, shields: 3, rest: 1.5, score: 0, cleared: 0 }));
  const me = Array.from({ length: n }, () => ({ jack: jacker(), reps: 0, wide: 0, last: -9 }));
  const tick = round(hud, ROUND, () => {
    music.stop();
    onEnd(team ? Array.from({ length: n }, () => crews[0].score) : crews.map((c) => c.score), me.map((m, p) => [`${m.reps} jacks`, m.reps ? `${Math.round((100 * m.wide) / m.reps)}% full jacks` : '', `${crews[team ? 0 : p].cleared} waves cleared`].filter(Boolean)));
  });
  music.start('arcade');

  const spawnWave = (c: (typeof crews)[number], k: number) => {
    const boss = c.wave % 3 === 2, cols = team ? 8 : n === 2 ? 4 : 6, rows = boss ? 2 : Math.min(4, 2 + Math.floor(c.wave / 2));
    const put = (x: number, y: number, row: number, isBoss = false) => { const v = invaders.find((q) => !q.on); if (v) { Object.assign(v, { on: true, zone: k, x, y, row, boss: isBoss, hp: isBoss ? 8 : 1, hurt: 0 }); for (const part of v.skin) tint(part, isBoss ? '#ef4444' : ROWS[row % ROWS.length]); } };
    for (let r = 0; r < rows; r++) for (let col = 0; col < cols; col++) put(c.x + ((col + 0.5) / cols - 0.5) * c.half * 1.7, TOP + 0.6 + r * 1.05, r);
    if (boss) { put(c.x, TOP + 3.4, 0, true); hud.banner('Boss wave!', 1500); say('final_round'); } else hud.banner(`Wave ${c.wave + 1}`, 1100);
  };
  const fire = (fromX: number, fromY: number, v: Invader, hex: string) => {
    const beam = beams.find((b) => b.life <= 0) ?? beams[0], dx = v.x - fromX, dy = v.y - fromY, len = Math.hypot(dx, dy);
    beam.life = 0.14; beam.e.enabled = true; void hex;
    beam.e.setLocalPosition(fromX + dx / 2, fromY + dy / 2, 1); beam.e.setLocalEulerAngles(0, 0, Math.atan2(dy, dx) * 57.3); beam.e.setLocalScale(len / 2 + 0.3, 0.32, 1);
    if (--v.hp <= 0) { v.on = false; bursts.burst(v.x, v.y, 1, v.boss ? '#ef4444' : ROWS[v.row % ROWS.length], v.boss ? 70 : 16, v.boss ? 13 : 7); if (v.boss) { hitStop(160); hud.shake(1.6); hud.flash('#ef4444'); sfx('impactPlate_heavy'); } return v.boss ? 10 : 1; }
    v.hurt = 0.15; bursts.burst(v.x, v.y, 1, '#ffffff', 8, 5);
    return 0;
  };

  return (rawDt: number) => {
    const dt = Math.min(rawDt, 0.05), t = tick(rawDt);
    if (t === null) return;
    const pads = bodies.map((b) => b.update());
    crews.forEach((c, k) => {
      const mine = invaders.filter((v) => v.on && v.zone === k);
      if (t >= 0 && !mine.length && (c.rest -= dt) <= 0) { spawnWave(c, k); c.rest = REST; }
      // They come down faster the longer the wave lasts, and faster on later waves.
      const fall = (0.22 + c.wave * 0.035) * hard;
      for (const v of mine) { v.y -= fall * dt * (v.boss ? 0.55 : 1); v.x += Math.sin(t * 1.3 + v.row) * 0.25 * dt; }
      const low = mine.sort((a, b) => a.y - b.y);
      if (low[0] && low[0].y < BREACH) { // one got through
        low[0].on = false; c.shields--; hud.flash('#ef4444'); hud.shake(1); sfx('error', { vol: 0.8 }); hud.pop(low[0].x, BREACH + 0.4, c.shields > 0 ? `Shield down · ${c.shields} left` : 'Overrun!', '#ef4444');
        if (c.shields <= 0) { for (const v of mine) v.on = false; c.shields = 3; c.score = Math.max(0, c.score - 5); c.rest = 2.5; }
      }
      c.who.forEach((p) => {
        const pl = players[p], m = me[p], r = m.jack(pl.rig);
        if (!r.rep || t < 0 || !pl.present) return;
        m.reps++; if (r.wide) m.wide++;
        const head = pads[p].find((pad) => pad.part === 'head'), targets = invaders.filter((v) => v.on && v.zone === k).sort((a, b) => a.y - b.y);
        // In a team, two jacks inside a third of a second are one big shot: the whole lowest row.
        const other = c.who.find((q) => q !== p), sync = team && other !== undefined && t - me[other].last < 0.33, shots = sync ? targets.filter((v) => Math.abs(v.y - (targets[0]?.y ?? 0)) < 0.5) : targets.slice(0, r.wide ? 2 : 1);
        m.last = t;
        let got = 0;
        for (const v of shots) got += fire(head?.x ?? bodies[p].at.x, (head?.y ?? 2) + 0.4, v, PLAYER_COLORS[p]);
        c.score += got + (sync && got ? 2 : 0);
        hitSound('laser', Math.min(12, m.reps % 12), 0.45);
        if (sync && got) { hud.pop(c.x, (targets[0]?.y ?? 2) + 0.6, `Together! +${got + 2}`, '#fde047'); hitStop(50); }
        else if (got) hud.pop(shots[0].x, shots[0].y + 0.5, r.wide ? `Full jack! +${got}` : `+${got}`, r.wide ? '#a3e635' : '#ffffff');
        if (targets.length && !invaders.some((v) => v.on && v.zone === k)) { c.score += 10; c.cleared++; c.wave++; c.rest = REST; hud.banner('Wave clear · +10 · breathe', 1800); sfx('confirmation'); say('objective_achieved'); }
      });
      c.who.forEach((p) => hud.p('h', p, t < 0 ? 'Jumping jacks fire the cannon' : !invaders.some((v) => v.on && v.zone === k) ? `Breathe · next wave in ${Math.max(1, Math.ceil(c.rest))}` : `${'◆'.repeat(c.shields)}${'◇'.repeat(3 - c.shields)} · ${me[p].reps} jacks`));
      hud.p('s', team ? 0 : k, players[c.who[0]].present ? String(c.score) : 'Step into view');
    });
    for (const v of invaders) { if (!show(v.e, v.on)) continue; v.hurt = Math.max(0, v.hurt - dt); const s = (v.boss ? 2.6 : 1) * (1 + v.hurt * 2) * (1 + 0.06 * Math.sin(t * 6 + v.x)); v.e.setLocalPosition(v.x, v.y, 0.9); v.e.setLocalScale(s, s, 1); }
    for (const b of beams) if (b.life > 0 && (b.life -= dt) <= 0) b.e.enabled = false;
    bursts.update(dt);
    passed(Math.max(...crews.map((c) => c.score)));
    music.intensity(0.35 + Math.min(0.6, invaders.filter((v) => v.on && v.y < 2.2).length / 6));
  };
}
