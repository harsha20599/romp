// Pulse — a rhythm game played with GESTURES down a neon tunnel. You never aim at anything: each hand has one
// receptor (cyan on the left, pink on the right) and notes fly out of the far end of the tunnel onto it, in time with
// the song. What a note asks for is a move, made wherever your hands happen to be:
//   · an arrow — swing that hand that way as it lands; an orb — swing it any way you like;
//   · a gold diamond — clap; a note with a tail — throw that arm up and hold it there until the tail runs out;
//   · in the song's break the walls close in — duck under the bar, lean away from the wall.
// The game reads the speed and direction of your hand from the tracker, so a swipe is a swipe anywhere in the room.
// Every swing you make is echoed at its receptor — note or no note — so you can see the game seeing you.
// Every note is a note of the song (chart.ts builds the chart from the music itself). Hits build a combo, the combo
// builds the multiplier, Perfects fill the fever meter — in fever the tunnel turns gold and everything pays double.
// Judged against what you did `lag` ago: the measured tracking delay plus how late the speakers are.
import { isLow, players, sim, tuning } from '../pose.ts';
import { chart, type Note } from '../chart.ts';
import { SONGS, play } from '../song.ts';
import { backdrop, fade, flat, glowAs, glowLook, instanced, node, ribbon, shapes, show, tint, trailLook } from '../engine.ts';
import { COUNTDOWN, H, audio, bestLine, bursts as makeBursts, countdown, hands as makeHands, hitStop, inputLag, say, sfx, zoneX, type Game } from '../kit.ts';

const APPROACH = 1.7, WINDOW = 0.22, PERFECT = 0.08, GREAT = 0.14, R = 1.05, VANISH_Y = 0.6, REC_Y = -0.2, POOL = 18, TAIL = 10, SWING = 2.2;
const TONES = ['#22d3ee', '#f472b6'], GOLD = '#fde047', DARK = '#0f0a2a';
const fly = (s: number, vx: number, tx: number, ty: number) => { const k = Math.max(0, s) ** 2.6; return { x: vx + (tx - vx) * k, y: VANISH_Y + (ty - VANISH_Y) * k, size: 0.1 + 0.9 * k }; };

type Live = { note: Note; state: 'in' | 'hit' | 'miss'; held: number; ticks: number };

export default function pulse({ n, stage, mode, team, best, onEnd, hud, scene }: Game) {
  const song = SONGS.find((s) => s.id === mode) ?? SONGS[0], { notes, seconds, spb } = chart(song, stage), world = backdrop(scene, 'tunnel');
  const start = audio().currentTime + COUNTDOWN, band = play(song, start);
  scene.cleanup(() => band.stop());
  const glow = glowLook('#ffffff', 1), white = flat('#ffffff', { opacity: 1 }), ringMesh = shapes.ring(0.9, 1, 48), thick = shapes.ring(0.62, 0.84, 40), disc = shapes.circle(0.5, 28), bead = shapes.quad(2, 2), arrow = shapes.ring(0, 0.62, 3), diamond = shapes.ring(0, 0.8, 4), streakMesh = shapes.quad(1, 1);
  // The tunnel's air: specks of light that stream outward past you, faster with the music's energy.
  const SPECKS = 70, specks = instanced(scene.root, shapes.circle(1, 8), SPECKS, 0.85), dust = Array.from({ length: SPECKS }, (_, i) => { specks.paint(i, ['#ffffff', TONES[0], TONES[1]][i % 3]); return { a: Math.random() * 6.283, r: Math.random() * 9 }; });
  const lanes = Array.from({ length: n }, (_, p) => {
    const cx = zoneX(n, p), vx = cx * 0.45, spread = n === 1 ? 3.1 : 1.85, recs = [cx - spread, cx + spread, cx].map((x, h) => {
      const hex = h === 2 ? GOLD : TONES[h], e = node(scene.root, undefined, undefined, [x, h === 2 ? REC_Y + 0.2 : REC_Y, 0.4]), halo = node(e, bead, glow, [0, 0, -0.05]), ring = node(e, ringMesh, white), rail = node(scene.root, streakMesh, flat(hex, { opacity: 0.16 }));
      // A faint rail of light from the far end of the tunnel to this receptor: the road its notes come down.
      const dx = x - vx, dy = REC_Y - VANISH_Y; rail.setLocalPosition(vx + dx / 2, VANISH_Y + dy / 2, 0.1); rail.setLocalEulerAngles(0, 0, Math.atan2(dy, dx) * 57.3); rail.setLocalScale(Math.hypot(dx, dy), 0.05, 1);
      const echo = node(scene.root, streakMesh, glow, [x, REC_Y, 0.7]); echo.enabled = false;
      e.setLocalScale(R, R, 1); tint(ring, hex); glowAs(halo, hex, 0.35); show(e, h < 2);
      return { x, y: h === 2 ? REC_Y + 0.2 : REC_Y, e, halo, ring, echo, flash: 0, swing: 0, sdx: 0, sdy: 0, hex };
    });
    const sprites = Array.from({ length: POOL }, (_, i) => {
      const e = node(scene.root), halo = node(e, bead, glow, [0, 0, -0.02]), body = node(e, thick, white, [0, 0, 0.01]), orb = node(e, disc, white, [0, 0, 0.02]), tip = node(e, arrow, white, [0, 0, 0.03]), gem = node(e, diamond, white, [0, 0, 0.02]);
      e.enabled = false;
      return { e, halo, body, orb, tip, gem, tail: i < 4 ? ribbon(scene.root, TAIL, trailLook(TONES[i % 2])) : null };
    });
    const bar = node(scene.root, shapes.quad(n === 1 ? 13 : 7, 2.6), flat(GOLD, { opacity: 0.5 })), wall = node(scene.root, shapes.quad(n === 1 ? 6.5 : 3.5, H), flat(GOLD, { opacity: 0.4 }));
    bar.enabled = wall.enabled = false;
    return { p, cx, vx, recs, sprites, bar, wall, live: notes.map((note): Live => ({ note, state: 'in', held: 0, ticks: 0 })), head: 0, score: 0, combo: 0, maxCombo: 0, perfect: 0, hit: 0, judged: 0, fever: 0, meter: 0, mult: 1, apart: 0, swung: [0, 0] };
  });
  const shocks = Array.from({ length: 8 }, () => { const e = node(scene.root, ringMesh, white); e.enabled = false; return { e, life: 0, x: 0, y: 0, big: 1 }; });
  let nextShock = 0;
  const hands = makeHands(scene, n, undefined, 0, TONES), bursts = makeBursts(scene.root), passed = bestLine(hud, best);
  const total = () => (team ? lanes.reduce((a, l) => a + l.score, 0) : Math.max(...lanes.map((l) => l.score)));
  const g = { done: false, last: 0 };
  if (sim) Object.assign(window, { __pulse: { lanes, start } }); // test hook: lets a headless run play the chart
  type Lane = (typeof lanes)[number];

  const land = (lane: Lane, live: Live, off: number, h: number) => { // a note was played `off` seconds from its beat
    const grade = off < PERFECT ? 2 : off < GREAT ? 1 : 0, rec = lane.recs[h], fever = lane.fever > 0, hex = fever ? GOLD : rec.hex;
    live.state = 'hit'; lane.hit++; lane.judged++;
    lane.combo++; lane.maxCombo = Math.max(lane.maxCombo, lane.combo); if (grade === 2) lane.perfect++;
    const mult = Math.min(8, 1 + Math.floor(lane.combo / 10));
    if (mult > lane.mult) { hud.pop(lane.cx, 3.2, `×${mult}`, GOLD); sfx('select', { vol: 0.5, rate: 1 + mult * 0.06, jitter: 0 }); }
    lane.mult = mult;
    lane.score += [40, 70, 100][grade] * mult * (fever ? 2 : 1);
    if (!fever && (lane.meter += [0.01, 0.025, 0.05][grade]) >= 1) { lane.meter = 0; lane.fever = 9; hud.banner('Fever · double points!', 1500); hud.flash(GOLD); sfx('powerUp', { vol: 0.8 }); say('power_up'); }
    rec.flash = 1;
    bursts.burst(rec.x, rec.y, 1, hex, grade === 2 ? 28 : 14, grade === 2 ? 11 : 7); if (grade === 2) bursts.burst(rec.x, rec.y, 1, '#ffffff', 10, 5);
    const shock = shocks[(nextShock = (nextShock + 1) % shocks.length)]; Object.assign(shock, { life: 1, x: rec.x, y: rec.y, big: grade === 2 ? 1.6 : 1.1 }); tint(shock.e, hex);
    hud.pop(rec.x, rec.y + 1.5, ['OK', 'Great', 'Perfect'][grade], grade === 2 ? GOLD : grade ? '#ffffff' : '#a5b4fc');
    sfx(grade === 2 ? 'select' : 'click', { vol: 0.35, rate: 1 + Math.min(12, lane.combo) * 0.02 });
    if (lane.combo % 50 === 0) { hud.banner(`${lane.combo} combo!`, 1200); hitStop(60); }
  };
  const drop = (lane: Lane, live: Live, h: number, why = 'Miss') => { live.state = 'miss'; lane.judged++; if (lane.combo >= 10) sfx('lowDown', { vol: 0.35 }); lane.combo = 0; lane.mult = 1; lane.meter = Math.max(0, lane.meter - 0.08); hud.pop(lane.recs[h].x, lane.recs[h].y + 1.5, why, '#f87171'); };

  return () => {
    if (g.done) return;
    const t = audio().currentTime - start, dt = Math.max(1e-3, Math.min(0.05, t - g.last));
    g.last = t;
    countdown(hud, Math.min(t, seconds), seconds);
    if (t >= seconds + 0.6) {
      g.done = true; band.stop(); say('time_over');
      const rank = (l: Lane) => { const acc = l.judged ? l.hit / l.judged : 0; return acc > 0.95 && l.perfect > l.hit * 0.6 ? 'S' : acc > 0.9 ? 'A' : acc > 0.75 ? 'B' : acc > 0.5 ? 'C' : 'D'; };
      return onEnd(team ? lanes.map(() => total()) : lanes.map((l) => l.score), lanes.map((l) => [`Rank ${rank(l)}`, `${Math.round((100 * l.hit) / Math.max(1, l.judged))}% hit`, `${l.perfect} perfect`, `Best combo ${l.maxCombo}`]));
    }
    const lag = inputLag() + (audio().outputLatency || 0), then = t - lag, beats = Math.max(0, t) / spb, kick = Math.exp(-(beats % 1) * 4.5), feverish = Math.max(...lanes.map((l) => Math.min(1, l.fever / 1.5)));
    hands.update(dt);
    world.drive(beats); world.mood(feverish);
    dust.forEach((d, i) => { d.r += (0.35 + d.r * (0.9 + kick * 1.2 + feverish)) * dt; if (d.r > 10.5) { d.r = 0.15 + Math.random() * 0.5; d.a = Math.random() * 6.283; } specks.place(i, Math.cos(d.a) * d.r * 1.3, VANISH_Y + Math.sin(d.a) * d.r * 0.8, 0.05, 0.012 + d.r * 0.006); specks.fade(i, Math.min(0.85, d.r * 0.25)); });
    specks.commit();

    for (const lane of lanes) {
      const pl = players[lane.p], hv = pl.hands, present = pl.present;
      lane.fever = Math.max(0, lane.fever - dt);
      // What the player's hands are doing right now: each hand's swing (speed and direction), and whether the hands just came together.
      const swing = [0, 1].map((h) => { const v = hv[h], speed = v.seen && present ? Math.hypot(v.vx, v.vy) : 0; return { speed, dx: speed ? v.vx / speed : 0, dy: speed ? v.vy / speed : 0 }; });
      const gap = hv[0].seen && hv[1].seen ? Math.hypot(hv[0].x * tuning.reachX[n - 1] - hv[1].x * tuning.reachX[n - 1] - 1, (hv[0].y - hv[1].y) * tuning.reachY) : 9; // shoulder-widths between the hands (their zones are a shoulder-width apart)
      if (gap > 0.9) lane.apart = t;
      const clapped = gap < 0.45 && t - lane.apart < 0.45;
      // The echo: every real swing shows at its receptor, note or no note.
      swing.forEach((s, h) => { const rec = lane.recs[h]; if (s.speed > SWING && t - lane.swung[h] > 0.18) { lane.swung[h] = t; rec.swing = 1; rec.sdx = s.dx; rec.sdy = s.dy; } });

      while (lane.head < lane.live.length && lane.live[lane.head].state !== 'in') lane.head++;
      show(lane.bar, false); show(lane.wall, false);
      let slot = 0, tails = 0, gate = '';
      for (let i = lane.head; i < lane.live.length; i++) {
        const live = lane.live[i], nt = live.note, until = nt.t - t;
        if (until > APPROACH) break;
        if (live.state !== 'in') continue;
        const due = nt.t - then, s = 1 - until / APPROACH; // due: seconds until it lands, as the player experiences it
        if (nt.kind === 'duck' || nt.kind === 'lean') {
          const k = Math.max(0, s) ** 2.6, side = nt.hand ? 1 : -1, e = nt.kind === 'duck' ? lane.bar : lane.wall;
          show(e, true); fade(e, 0.15 + 0.5 * k); e.setLocalScale(0.1 + 0.9 * k, 0.1 + 0.9 * k, 1);
          if (nt.kind === 'duck') e.setLocalPosition(lane.vx + (lane.cx - lane.vx) * k, VANISH_Y + (2.5 - VANISH_Y) * k, 0.4); else e.setLocalPosition(lane.vx + (lane.cx + side * (n === 1 ? 3.25 : 1.75) - lane.vx) * k, VANISH_Y * (1 - k), 0.4);
          gate = nt.kind === 'duck' ? 'Duck!' : side > 0 ? '← Lean left' : 'Lean right →';
          if (Math.abs(due) < WINDOW * 1.5 && (nt.kind === 'duck' ? isLow(pl) : pl.lean * side < -0.12 || pl.steer * side < -0.35)) { live.state = 'hit'; lane.hit++; lane.judged++; lane.combo++; lane.score += 150 * lane.mult; hud.pop(lane.cx, 1.2, 'Clean!', GOLD); sfx('phaseJump', { vol: 0.5 }); bursts.burst(lane.cx, 2, 1, GOLD, 24, 9); }
          else if (due < -WINDOW * 1.5) { drop(lane, live, 2, nt.kind === 'duck' ? 'Duck!' : 'Lean!'); hud.flash('#ef4444'); hud.shake(0.6); }
          continue;
        }
        const sp = lane.sprites[slot++], rec = lane.recs[nt.hand];
        if (!sp) continue;
        const hex = lane.fever > 0 ? GOLD : rec.hex, pos = fly(Math.min(s, 1.06), lane.vx, rec.x, rec.y), any = nt.dx === 0 && nt.dy === 0;
        sp.e.enabled = true; sp.e.setLocalPosition(pos.x, pos.y, 0.5 + s * 0.3); sp.e.setLocalScale(pos.size * R, pos.size * R, 1);
        glowAs(sp.halo, hex, 0.5 + 0.5 * Math.min(1, s)); sp.halo.setLocalScale(2, 2, 1); tint(sp.body, hex);
        show(sp.orb, nt.kind === 'swipe' && any); show(sp.gem, nt.kind === 'clap'); tint(sp.gem, GOLD); show(sp.body, nt.kind !== 'clap');
        if (show(sp.tip, !any || nt.kind === 'hold')) { sp.tip.setLocalEulerAngles(0, 0, Math.atan2(nt.dy, nt.dx) * 57.3); tint(sp.tip, nt.kind === 'hold' ? DARK : '#ffffff'); }
        if (nt.kind === 'clap') show(rec.e, true);

        if (nt.kind === 'hold') { // throw the arm up and keep it there while the tail runs through the receptor
          const tail = lane.sprites[tails++ % 4].tail, up = hv[nt.hand].seen && hv[nt.hand].y > 0.35;
          if (due <= 0) sp.e.setLocalPosition(rec.x, rec.y, 0.8);
          if (tail) { tail.entity.enabled = true; const into = Math.max(0, Math.min(1, -due / nt.len)); for (let k = 0; k < TAIL; k++) { const f = into + (1 - into) * (k / (TAIL - 1)), q = fly(Math.min(1, 1 - (nt.t + nt.len * f - t) / APPROACH), lane.vx, rec.x, rec.y), w = 0.3 * q.size; tail.positions.set([q.x - w, q.y, 0.4, q.x + w, q.y, 0.4], k * 6); } tail.commit(); }
          if (due <= 0 && up) { live.held += dt; rec.flash = Math.max(rec.flash, 0.6); if (live.held > (live.ticks + 1) * 0.1) { live.ticks++; lane.score += 12 * lane.mult * (lane.fever > 0 ? 2 : 1); if (live.ticks % 2) bursts.burst(rec.x, rec.y, 1, hex, 2, 3); } }
          if (due < -nt.len) { if (live.held > nt.len * 0.45) land(lane, live, live.held > nt.len * 0.8 ? 0 : 0.1, nt.hand); else drop(lane, live, nt.hand, 'Arm up!'); }
          continue;
        }
        if (Math.abs(due) <= WINDOW) {
          const sw = swing[Math.min(1, nt.hand)];
          if (nt.kind === 'clap' ? clapped : sw.speed > SWING && (any || sw.dx * nt.dx + sw.dy * nt.dy > 0.45)) { land(lane, live, Math.abs(due), nt.hand); if (nt.kind === 'clap') lane.apart = -9; }
        } else if (due < -WINDOW) drop(lane, live, nt.hand, nt.kind === 'clap' ? 'Clap!' : 'Miss');
      }
      for (let k = slot; k < POOL; k++) lane.sprites[k].e.enabled = false;
      for (let k = tails; k < 4; k++) { const tail = lane.sprites[k].tail; if (tail) tail.entity.enabled = false; }
      if (!lane.live.slice(lane.head, lane.head + 8).some((l) => l.state === 'in' && l.note.kind === 'clap' && l.note.t - t < APPROACH)) show(lane.recs[2].e, false);
      // Receptors breathe with the kick, flare on a hit, and show every swing as a streak of light the way it went.
      lane.recs.forEach((rec) => {
        rec.flash = Math.max(0, rec.flash - dt * 4); rec.swing = Math.max(0, rec.swing - dt * 5);
        const k = R * (1 + 0.06 * kick + 0.25 * rec.flash); rec.e.setLocalScale(k, k, 1); glowAs(rec.halo, lane.fever > 0 ? GOLD : rec.hex, 0.3 + 0.25 * kick + 0.6 * rec.flash); tint(rec.ring, lane.fever > 0 ? GOLD : rec.hex);
        if (show(rec.echo, rec.swing > 0)) { const reach = 1.2 + (1 - rec.swing) * 2.2; rec.echo.setLocalPosition(rec.x + rec.sdx * reach * 0.6, rec.y + rec.sdy * reach * 0.6, 0.7); rec.echo.setLocalEulerAngles(0, 0, Math.atan2(rec.sdy, rec.sdx) * 57.3); rec.echo.setLocalScale(reach * 1.4, 0.35, 1); glowAs(rec.echo, rec.hex, rec.swing * 0.9); }
      });
      hud.p('s', team ? 0 : lane.p, !present ? 'Step into view' : String(team ? total() : lane.score));
      hud.p('h', lane.p, gate || (t < 0 ? `${song.name} · swing the way the arrows point` : lane.fever > 0 ? `Fever ${Math.ceil(lane.fever)}s · ×${lane.mult * 2}` : lane.combo >= 5 ? `${lane.combo} combo · ×${lane.mult}` : `Fever ${Math.round(lane.meter * 100)}%`));
    }
    for (const sh of shocks) { if (!show(sh.e, sh.life > 0)) continue; sh.life -= dt * 3.2; const k = R * (1 + (1 - sh.life) * 2.4 * sh.big); sh.e.setLocalPosition(sh.x, sh.y, 0.7); sh.e.setLocalScale(k, k, 1); fade(sh.e, Math.max(0, sh.life) ** 1.5); }
    bursts.update(dt);
    passed(total());
  };
}
