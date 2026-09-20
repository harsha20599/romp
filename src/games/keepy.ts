// Keepy-Uppy — keep the balloon off the floor with anything you have. A balloon is slow and floaty, so there is
// always time to get under it — the game is in what you hit it WITH: a header, a knee or a kick pays more than a hand,
// and never using the same part twice running builds a variety streak. More balloons join, the wind gets up, a heavy
// water balloon drops in, and the last seconds are a balloon storm to pop with hard hits.
// Two players rally one balloon across the line between them: every crossing pays, and the rally count is the score
// you will be talking about afterwards.
import type { Entity } from 'playcanvas';
import { hardness } from '../meta.ts';
import { backdrop, flat, lit, node, shapes, show, tint } from '../engine.ts';
import { H, W, bestLine, bursts as makeBursts, divider, figure, hitSound, hitStop, music, round, say, sfx, zoneHalf, zoneX, type Game, type Pad } from '../kit.ts';

const FINALE = 8, SCALE = 1.2, SHOULDER_Y = 0.55, FLOOR = -H / 2 + 0.35, CEILING = H / 2 - 0.4, POOL = 14;
const COLORS = ['#f43f5e', '#fbbf24', '#34d399', '#38bdf8', '#a78bfa', '#fb923c'];
const PART = { hand: { points: 1, word: '' }, elbow: { points: 2, word: 'Elbow!' }, head: { points: 2, word: 'Header!' }, knee: { points: 2, word: 'Knee!' }, foot: { points: 3, word: 'Kick!' } } as const;
const PAD_R: Record<Pad['part'], number> = { hand: 0.42, elbow: 0.36, head: 0.55, knee: 0.42, foot: 0.45 };
type Balloon = { on: boolean; kind: 'air' | 'water' | 'storm'; x: number; y: number; vx: number; vy: number; r: number; hex: string; squash: number; side: number; cool: number[]; e: Entity; shine: Entity };

export default function keepy({ n, stage, mode, best, onEnd, hud, scene }: Game) {
  const hard = hardness(stage), rally = n === 2, classic = mode === 'classic', ROUND = classic ? Infinity : 60; // two players always rally: one balloon game, one score
  backdrop(scene, 'sky', true);
  const bodies = Array.from({ length: n }, (_, p) => figure(scene, p, { x: zoneX(n, p), y: SHOULDER_Y, scale: SCALE }));
  if (rally) divider(scene, n, '#52525b', -0.5, 0.05);
  node(scene.root, shapes.quad(W, 0.12), flat('#f43f5e', { opacity: 0.55 }), [0, FLOOR - 0.3, 0.2]); // the floor line: what the balloons must not reach
  const ball = shapes.sphere(1, 18), dot = shapes.circle(1, 12), skin = lit('#ffffff', { emissive: '#ffffff', glow: 0.35 }), gloss = flat('#ffffff', { opacity: 0.55 });
  const balloons: Balloon[] = Array.from({ length: POOL }, () => {
    const e = node(scene.root, ball, skin), shine = node(e, dot, gloss, [-0.35, 0.4, 0.95]);
    shine.setLocalScale(0.22, 0.3, 1); e.enabled = false;
    return { on: false, kind: 'air', x: 0, y: 0, vx: 0, vy: 0, r: 0.8, hex: COLORS[0], squash: 0, side: 0, cool: [], e, shine };
  });
  const bursts = makeBursts(scene.root), passed = bestLine(hud, best);
  const g = { score: 0, streak: 0, bestStreak: 0, rally: 0, bestRally: 0, variety: 0, lastPart: '', lastBy: -1, kicks: 0, headers: 0, lives: classic ? 3 : 0, wind: 0, twist: false, finale: false, stormIn: 0, popped: 0, nextJoin: 14, over: false, assist: 0 };
  const finish = () => { g.over = true; music.stop(); const s = Math.round(g.score); onEnd(rally ? [s, s] : [s], Array.from({ length: n }, () => [rally && g.bestRally >= 3 ? `Longest rally ${g.bestRally}` : '', g.bestStreak >= 5 ? `${g.bestStreak} touches without a drop` : '', g.headers ? `${g.headers} header${g.headers > 1 ? 's' : ''}` : '', g.kicks ? `${g.kicks} kick${g.kicks > 1 ? 's' : ''}` : '', g.popped ? `${g.popped} popped in the storm` : ''].filter(Boolean))); };
  const tick = round(hud, ROUND, finish);
  music.start(classic ? 'calm' : 'arcade', undefined, 0.4);

  const spawn = (kind: Balloon['kind'], x: number, y = CEILING + 1) => {
    const b = balloons.find((q) => !q.on);
    if (!b) return;
    Object.assign(b, { on: true, kind, x, y, vx: (Math.random() - 0.5) * 1.5, vy: 0, r: kind === 'water' ? 0.55 : kind === 'storm' ? 0.5 : 0.85, hex: kind === 'water' ? '#38bdf8' : COLORS[Math.floor(Math.random() * COLORS.length)], squash: 0, side: x < 0 ? 0 : 1, cool: [] });
    tint(b.e, b.hex, 'diffuse'); tint(b.e, b.hex, 'emissive');
  };
  const reachX = rally ? W / 2 - 1 : Math.min(zoneHalf(n), 3.4); // keep play over the body: nobody should have to step sideways
  const over = () => (rally ? 0 : bodies[0].at.x); // solo, balloons come down over wherever the player is standing
  spawn('air', 0, 2.5);

  return (rawDt: number) => {
    const dt = Math.min(rawDt, 0.05), t = tick(rawDt);
    if (t === null || g.over) return;
    const pads: (Pad & { p: number })[] = bodies.flatMap((b, p) => b.update().map((pad) => ({ ...pad, p })));
    const progress = isFinite(ROUND) ? Math.max(0, t) / ROUND : Math.min(0.8, t / 120), finale = isFinite(ROUND) && t > ROUND - FINALE;

    if (t >= 0 && !finale) {
      // A second and third balloon join as the round goes on; a heavy water balloon drops in now and then.
      const air = balloons.filter((b) => b.on && b.kind === 'air').length;
      if (t > g.nextJoin && air < (rally ? 2 : 3)) { g.nextJoin = t + 16 / hard; spawn('air', over() + (Math.random() - 0.5) * reachX); hud.banner(air === 1 ? 'Two balloons!' : 'Three balloons!', 1300); sfx('maximize', { vol: 0.5 }); }
      if (air === 0) spawn('air', over() + (Math.random() - 0.5) * reachX);
      if (t > 20 && Math.random() < dt / 9 && !balloons.some((b) => b.on && b.kind === 'water')) { spawn('water', over() + (Math.random() - 0.5) * reachX * 1.4); hud.banner('Water balloon · worth 3', 1200); }
      if (!g.twist && progress > 0.5) { g.twist = true; hud.banner('The wind is getting up!', 1700); sfx('zapThreeToneUp', { vol: 0.6 }); }
    }
    if (finale && !g.finale) { g.finale = true; hud.banner('Balloon storm · pop them!', 1700); say('hurry_up'); for (const b of balloons) if (b.on && b.kind !== 'storm') b.kind = 'storm'; }
    if (finale && (g.stormIn -= dt) <= 0) { g.stormIn = 0.28 / hard; spawn('storm', (Math.random() - 0.5) * (rally ? W - 3 : reachX * 2)); }
    g.wind = g.twist && !finale ? Math.sin(t * 0.7) * 1.6 * hard : 0;

    for (const b of balloons) {
      if (!show(b.e, b.on)) continue;
      // A balloon: hardly any gravity, a lot of drag. It is never where a fast hand left it for long.
      const heavy = b.kind === 'water', fall = (heavy ? -5.5 : b.kind === 'storm' ? -2.2 : -1.5) * (1 - 0.25 * g.assist) * Math.sqrt(hard), drag = heavy ? 0.5 : 1.7;
      b.vy += fall * dt; b.vx += g.wind * dt * (heavy ? 0.3 : 1);
      b.vx -= b.vx * drag * dt; b.vy -= b.vy * drag * dt;
      b.x += b.vx * dt; b.y += b.vy * dt;
      const mid = over(), wall = rally ? W / 2 - b.r : reachX + 1.2;
      if (Math.abs(b.x - mid) > wall) { b.x = mid + Math.sign(b.x - mid) * wall; b.vx *= -0.7; }
      if (b.y > CEILING - b.r) { b.y = CEILING - b.r; b.vy = -Math.abs(b.vy) * 0.5; }
      b.cool = b.cool.map((c) => Math.max(0, c - dt));

      for (const [i, pad] of pads.entries()) {
        if (!pad.seen || b.cool[i] > 0) continue;
        const dx = b.x - pad.x, dy = b.y - pad.y, d = Math.hypot(dx, dy), reach = b.r + PAD_R[pad.part] * (1 + 0.5 * g.assist);
        if (d > reach) continue;
        const speed = Math.hypot(pad.vx, pad.vy), nx = dx / (d || 1), ny = dy / (d || 1), part = PART[pad.part];
        b.cool[i] = 0.3; // one touch per pass: a hand resting against the balloon is not a rally of its own
        if (b.kind === 'storm') { // the storm: a hit with some intent pops it
          if (speed < 2.2) continue;
          b.on = false; g.popped++; g.score += 1; hitSound('pepSound', Math.min(24, g.popped), 0.55); bursts.burst(b.x, b.y, 0.6, b.hex, 12, 7); hud.pop(b.x, b.y, '+1', b.hex);
          continue;
        }
        // A balloon that merely lands on you rolls off: it takes a deliberate move to send it up, and only that scores.
        // (Otherwise standing still under it is a header every second, for ever.)
        if (speed < 1.1) { b.vx += nx * 1.2 + (Math.random() - 0.5); b.vy = Math.max(b.vy, 0.6); b.x = pad.x + nx * reach; b.y = pad.y + ny * reach; continue; }
        // The bump: away from whatever touched it, carrying some of that part's own speed, and always a little up.
        const push = 3.2 + Math.min(7, speed) * 0.75;
        b.vx = nx * push * 0.8 + pad.vx * 0.35; b.vy = Math.max(2.4, ny * push + pad.vy * 0.35 + 2.2); b.squash = 1;
        b.x = pad.x + nx * reach; b.y = pad.y + ny * reach;
        const fresh = pad.part !== g.lastPart;
        g.variety = fresh ? g.variety + 1 : 0; g.lastPart = pad.part;
        g.streak++; g.bestStreak = Math.max(g.bestStreak, g.streak);
        if (pad.part === 'foot') g.kicks++; if (pad.part === 'head') g.headers++;
        let points = part.points * (heavy ? 3 : 1) + Math.floor(g.streak / 10) + (g.variety >= 3 ? 1 : 0);
        // Rally: the balloon changing hands across the line is the whole point of playing together.
        if (rally && g.lastBy >= 0 && g.lastBy !== pad.p) { g.rally++; g.bestRally = Math.max(g.bestRally, g.rally); points += 2 + Math.floor(g.rally / 5); hud.pop(0, b.y + 0.4, `Rally ${g.rally}`, '#fde047'); }
        g.lastBy = pad.p;
        g.score += points; g.assist = Math.max(0, g.assist - 0.03);
        hitSound(heavy ? 'impactSoft_heavy' : 'pepSound', Math.min(24, g.streak), 0.5); bursts.burst(b.x - nx * b.r, b.y - ny * b.r, 0.6, '#ffffff', 5, 3);
        hud.pop(b.x, b.y + b.r + 0.3, [part.word, g.variety >= 3 && fresh ? 'Variety!' : '', `+${points}`].filter(Boolean).join(' '), part.points > 1 ? '#fb923c' : '#ffffff');
        if (part.points >= 3) hitStop(45);
      }

      if (b.y < FLOOR + b.r * 0.6 && b.on) { // on the floor
        b.on = false; bursts.burst(b.x, FLOOR, 0.6, b.hex, 22, 8); sfx('impactGlass_heavy', { vol: 0.5, rate: 1.4 });
        if (b.kind !== 'storm') {
          g.streak = 0; g.rally = 0; g.variety = 0; g.lastBy = -1; g.assist = Math.min(1, g.assist + 0.25);
          hud.pop(b.x, FLOOR + 0.8, classic ? '−♥' : 'Dropped!', '#ef4444'); hud.shake(0.6);
          if (classic && --g.lives <= 0) { say('game_over'); return finish(); }
        }
      }
      b.squash = Math.max(0, b.squash - dt * 5);
      const wob = Math.sin(b.squash * Math.PI) * 0.22;
      b.e.setLocalPosition(b.x, b.y, 0.3); b.e.setLocalScale(b.r * (1 + wob), b.r * 1.12 * (1 - wob), b.r);
    }

    bursts.update(dt);
    passed(g.score);
    music.intensity(finale ? 1 : 0.3 + Math.min(0.6, g.streak / 30));
    if (classic) hud('clock', '♥'.repeat(Math.max(0, g.lives)) || '0');
    hud.p('s', 0, String(Math.round(g.score)));
    const hint = t < 0 ? (rally ? 'Keep it up · pass it across' : 'Keep it off the floor') : finale ? 'Pop them!' : rally && g.rally >= 2 ? `Rally ${g.rally}` : g.streak >= 5 ? `${g.streak} touches` : t < 12 ? 'Heads, knees and feet pay more' : '';
    for (let p = 0; p < n; p++) hud.p('h', p, hint);
  };
}
