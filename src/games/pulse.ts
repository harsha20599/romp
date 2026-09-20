// Pulse — a rhythm game played with your whole body down a neon tunnel. Notes fly out of the far end in time with
// the song and land on rings within your reach: cyan for the left hand, magenta for the right.
//   · an orb is struck — move your hand through it as it lands;
//   · a comet is slashed — through it, the way its chevron points;
//   · a rail is ridden — keep your hand on the ribbon for as long as it lasts;
//   · in the song's break the walls close in — duck under the bar, lean away from the wall.
// Every note is a note of the song (chart.ts builds the chart from the music itself), so what you hear is what you hit.
// Hits build a combo, the combo builds the multiplier, Perfects fill the fever meter — and in fever the tunnel turns
// gold and everything pays double. The game judges what you did `lag` ago: the measured tracking delay plus how late
// the speakers are, so "on the beat" means on the beat you heard. Three songs (the modes), five stages of density.
import type { Entity } from 'playcanvas';
import { isLow, players, sim } from '../pose.ts';
import { chart, type Note } from '../chart.ts';
import { SONGS, play } from '../song.ts';
import { backdrop, fade, flat, glowAs, glowLook, node, ribbon, shapes, show, tint, trailLook } from '../engine.ts';
import { COUNTDOWN, H, audio, bestLine, bursts as makeBursts, countdown, hands as makeHands, hitStop, inputLag, say, sfx, zoneHalf, zoneX, type Game, type StageHand } from '../kit.ts';

const APPROACH = 1.7, WINDOW = 0.2, PERFECT = 0.075, GREAT = 0.13, R = 0.85, VANISH_Y = 0.6, POOL = 22, RAIL_PTS = 10;
const TONES = ['#22d3ee', '#f472b6'], GOLD = '#fde047';
// Where a note is on its way in: s = 0 at the far end of the tunnel, 1 on its ring. It grows as it comes.
const fly = (s: number, vx: number, tx: number, ty: number) => { const k = Math.max(0, s) ** 2.6; return { x: vx + (tx - vx) * k, y: VANISH_Y + (ty - VANISH_Y) * k, size: 0.12 + 0.88 * k }; };

type Live = { note: Note; state: 'in' | 'hit' | 'miss'; held: number; ticks: number; grade: number };
type Sprite = { e: Entity; halo: Entity; core: Entity; chevron: Entity; landing: Entity; rail: ReturnType<typeof ribbon> | null };

export default function pulse({ n, stage, mode, team, best, onEnd, hud, scene }: Game) {
  const song = SONGS.find((s) => s.id === mode) ?? SONGS[0], { notes, seconds, spb } = chart(song, stage), world = backdrop(scene, 'tunnel');
  const start = audio().currentTime + COUNTDOWN, band = play(song, start);
  scene.cleanup(() => band.stop());
  const glow = glowLook('#ffffff', 1), white = flat('#ffffff', { opacity: 1 }), ringMesh = shapes.ring(0.92, 1, 48), coreMesh = shapes.ring(0.42, 0.62, 28), orbMesh = shapes.circle(0.34, 24), bead = shapes.quad(2, 2);
  const chevronMesh = shapes.ring(0.0, 0.5, 3); // a triangle: which way to cut
  const lanes = Array.from({ length: n }, (_, p) => {
    const cx = zoneX(n, p), hw = zoneHalf(n) * 0.92, vx = cx * 0.45;
    const sprites: Sprite[] = Array.from({ length: POOL }, (_, i) => {
      const e = node(scene.root), halo = node(e, bead, glow, [0, 0, -0.02]), core = node(e, coreMesh, white, [0, 0, 0.02]); node(e, orbMesh, white, [0, 0, 0.01]);
      const chevron = node(e, chevronMesh, white, [0, 0, 0.03]), landing = node(scene.root, ringMesh, white);
      e.enabled = landing.enabled = false;
      return { e, halo, core, chevron, landing, rail: i < 4 ? ribbon(scene.root, RAIL_PTS, trailLook(TONES[i % 2])) : null };
    });
    const bar = node(scene.root, shapes.quad(hw * 2, 2.6), flat(GOLD, { opacity: 0.5 })), wall = node(scene.root, shapes.quad(hw, H), flat(GOLD, { opacity: 0.4 }));
    bar.enabled = wall.enabled = false;
    return { p, cx, hw, vx, sprites, bar, wall, live: notes.map((note): Live => ({ note, state: 'in', held: 0, ticks: 0, grade: 0 })), head: 0, score: 0, combo: 0, maxCombo: 0, perfect: 0, hit: 0, judged: 0, fever: 0, meter: 0, mult: 1, inside: [false, false] };
  });
  // A ring of light that runs outward from every hit.
  const shocks = Array.from({ length: 8 }, () => { const e = node(scene.root, ringMesh, white); e.enabled = false; return { e, life: 0, x: 0, y: 0, big: 1 }; });
  let nextShock = 0;
  const hands = makeHands(scene, n, undefined, 0, TONES), bursts = makeBursts(scene.root), passed = bestLine(hud, best);
  const total = () => (team ? lanes.reduce((a, l) => a + l.score, 0) : Math.max(...lanes.map((l) => l.score)));
  const g = { done: false, last: 0 };
  if (sim) Object.assign(window, { __pulse: { lanes, start } }); // test hook: lets a headless run play the chart

  const land = (lane: (typeof lanes)[number], live: Live, off: number, x: number, y: number) => { // a note was struck `off` seconds from its beat
    const grade = off < PERFECT ? 2 : off < GREAT ? 1 : 0, hex = TONES[live.note.hand], fever = lane.fever > 0;
    live.state = 'hit'; live.grade = grade; lane.hit++; lane.judged++;
    lane.combo++; lane.maxCombo = Math.max(lane.maxCombo, lane.combo); if (grade === 2) lane.perfect++;
    const mult = Math.min(8, 1 + Math.floor(lane.combo / 10));
    if (mult > lane.mult) { hud.pop(lane.cx, 3.2, `×${mult}`, GOLD); sfx('select', { vol: 0.5, rate: 1 + mult * 0.06, jitter: 0 }); }
    lane.mult = mult;
    lane.score += [40, 70, 100][grade] * mult * (fever ? 2 : 1);
    if (!fever && (lane.meter += [0.01, 0.025, 0.05][grade]) >= 1) { lane.meter = 0; lane.fever = 9; hud.banner('Fever · double points!', 1500); hud.flash(GOLD); sfx('powerUp', { vol: 0.8 }); say('power_up'); }
    bursts.burst(x, y, 1, fever ? GOLD : hex, grade === 2 ? 26 : 12, grade === 2 ? 10 : 6); if (grade === 2) bursts.burst(x, y, 1, '#ffffff', 8, 4);
    const shock = shocks[(nextShock = (nextShock + 1) % shocks.length)]; Object.assign(shock, { life: 1, x, y, big: grade === 2 ? 1.5 : 1 }); tint(shock.e, fever ? GOLD : hex);
    hud.pop(x, y + 0.7, ['OK', 'Great', 'Perfect'][grade], grade === 2 ? GOLD : grade ? '#ffffff' : '#a5b4fc');
    sfx(grade === 2 ? 'select' : 'click', { vol: 0.35, rate: 1 + Math.min(12, lane.combo) * 0.02 });
    if (lane.combo % 50 === 0) { hud.banner(`${lane.combo} combo!`, 1200); hitStop(60); }
  };
  const drop = (lane: (typeof lanes)[number], live: Live, why = 'Miss') => { live.state = 'miss'; lane.judged++; if (lane.combo >= 10) sfx('lowDown', { vol: 0.35 }); lane.combo = 0; lane.mult = 1; lane.meter = Math.max(0, lane.meter - 0.08); hud.pop(lane.cx + live.note.x * lane.hw, 0.4 + live.note.y * 2, why, '#f87171'); };

  return () => {
    if (g.done) return;
    const t = audio().currentTime - start, dt = Math.max(1e-3, Math.min(0.05, t - g.last));
    g.last = t;
    countdown(hud, Math.min(t, seconds), seconds);
    if (t >= seconds + 0.6) {
      g.done = true; band.stop(); say('time_over');
      const rank = (l: (typeof lanes)[number]) => { const acc = l.judged ? l.hit / l.judged : 0; return acc > 0.95 && l.perfect > l.hit * 0.6 ? 'S' : acc > 0.9 ? 'A' : acc > 0.75 ? 'B' : acc > 0.5 ? 'C' : 'D'; };
      return onEnd(team ? lanes.map(() => total()) : lanes.map((l) => l.score), lanes.map((l) => [`Rank ${rank(l)}`, `${Math.round((100 * l.hit) / Math.max(1, l.judged))}% hit`, `${l.perfect} perfect`, `Best combo ${l.maxCombo}`]));
    }
    const lag = inputLag() + (audio().outputLatency || 0), then = t - lag, at = hands.update(dt), beats = Math.max(0, t) / spb;
    world.drive(beats); world.mood(Math.max(...lanes.map((l) => Math.min(1, l.fever / 1.5))));

    for (const lane of lanes) {
      const pl = players[lane.p], mine = at.filter((h) => h.p === lane.p), used = new Set<number>();
      lane.fever = Math.max(0, lane.fever - dt);
      while (lane.head < lane.live.length && lane.live[lane.head].state !== 'in') lane.head++;
      show(lane.bar, false); show(lane.wall, false);
      for (let i = lane.head, slot = 0, rails = 0; i < lane.live.length; i++) {
        const live = lane.live[i], nt = live.note, until = nt.t - t;
        if (until > APPROACH) break;
        if (live.state !== 'in') continue;
        const tx = lane.cx + nt.x * lane.hw, ty = nt.y * (H / 2), due = nt.t - then; // due: seconds until it lands, as the player experiences it

        // ---- gates: the legs' turn ----
        if (nt.kind === 'duck' || nt.kind === 'lean') {
          const s = 1 - until / APPROACH, k = Math.max(0, s) ** 2.6, side = nt.hand ? 1 : -1, e = nt.kind === 'duck' ? lane.bar : lane.wall;
          show(e, true); fade(e, 0.15 + 0.5 * k);
          if (nt.kind === 'duck') { e.setLocalPosition(lane.vx + (lane.cx - lane.vx) * k, VANISH_Y + (2.4 - VANISH_Y) * k, 0.4); e.setLocalScale(0.1 + 0.9 * k, 0.1 + 0.9 * k, 1); }
          else { e.setLocalPosition(lane.vx + (lane.cx + side * lane.hw * 0.5 - lane.vx) * k, VANISH_Y * (1 - k), 0.4); e.setLocalScale(0.1 + 0.9 * k, 0.1 + 0.9 * k, 1); }
          hud.p('h', lane.p, nt.kind === 'duck' ? 'Duck!' : side > 0 ? '← Lean left' : 'Lean right →');
          if (Math.abs(due) < WINDOW * 1.5 && (nt.kind === 'duck' ? isLow(pl) : pl.lean * side < -0.12 || pl.steer * side < -0.35)) { live.state = 'hit'; lane.hit++; lane.judged++; lane.combo++; lane.score += 150 * lane.mult; hud.pop(lane.cx, 1.2, 'Clean!', GOLD); sfx('phaseJump', { vol: 0.5 }); bursts.burst(lane.cx, 2, 1, GOLD, 24, 9); }
          else if (due < -WINDOW * 1.5) { drop(lane, live, nt.kind === 'duck' ? 'Duck!' : 'Lean!'); hud.flash('#ef4444'); hud.shake(0.6); }
          continue;
        }
        const sp = lane.sprites[slot++];
        if (!sp) continue;
        used.add(slot - 1);
        const hex = lane.fever > 0 ? GOLD : TONES[nt.hand], hand: StageHand | undefined = mine[nt.hand], s = 1 - until / APPROACH, pos = fly(Math.min(s, 1.08), lane.vx, tx, ty);
        show(sp.e, true); sp.e.setLocalPosition(pos.x, pos.y, 0.5 + s * 0.3); sp.e.setLocalScale(pos.size * R, pos.size * R, 1);
        glowAs(sp.halo, hex, 0.55 + 0.45 * Math.min(1, s)); sp.halo.setLocalScale(1.9, 1.9, 1); tint(sp.core, hex);
        if (show(sp.chevron, nt.kind === 'slash')) { sp.chevron.setLocalEulerAngles(0, 0, Math.atan2(nt.dy, nt.dx) * 57.3); sp.chevron.setLocalPosition(nt.dx * 0.15, nt.dy * 0.15, 0.03); tint(sp.chevron, '#0f0a2a'); }
        // The landing ring: where, and — as it closes onto the note's size — when.
        if (show(sp.landing, s > 0.35)) { const close = R * (1 + 1.6 * Math.max(0, 1 - s)); sp.landing.setLocalPosition(tx, ty, 0.45); sp.landing.setLocalScale(close, close, 1); tint(sp.landing, hex); fade(sp.landing, Math.min(0.95, (s - 0.35) ** 2 * 3)); }

        const near = hand?.on ? Math.hypot(hand.x - tx, hand.y - ty) : 99;
        if (nt.kind === 'rail') {
          // A rail is ridden: its head sits on the ring from its beat until it runs out, sliding to where it ends.
          const into = Math.max(0, Math.min(1, -due / nt.len)), hx = tx + (lane.cx + nt.x2 * lane.hw - tx) * into, hy = ty + (nt.y2 * (H / 2) - ty) * into;
          if (due <= 0) { sp.e.setLocalPosition(hx, hy, 0.8); sp.landing.setLocalPosition(hx, hy, 0.45); sp.landing.setLocalScale(R, R, 1); }
          const rail = lane.sprites[rails++ % 4].rail;
          if (rail) { // the ribbon: each point of it at its own depth, so it hangs down the tunnel toward you
            show(rail.entity, true);
            for (let k = 0; k < RAIL_PTS; k++) { const f = into + (1 - into) * (k / (RAIL_PTS - 1)), ahead = nt.t + nt.len * f - t, q = fly(Math.min(1, 1 - ahead / APPROACH), lane.vx, tx + (lane.cx + nt.x2 * lane.hw - tx) * f, ty + (nt.y2 * (H / 2) - ty) * f), w = 0.22 * q.size; rail.positions.set([q.x - w, q.y, 0.4, q.x + w, q.y, 0.4], k * 6); }
            rail.commit();
          }
          if (due <= 0 && hand?.on && Math.hypot(hand.x - hx, hand.y - hy) < R * 1.35) { live.held += dt; if (live.held > (live.ticks + 1) * 0.1) { live.ticks++; lane.score += 12 * lane.mult * (lane.fever > 0 ? 2 : 1); if (live.ticks % 2) bursts.burst(hx, hy, 1, hex, 2, 3); } }
          if (due < -nt.len) { if (live.held > nt.len * 0.45) land(lane, live, live.held > nt.len * 0.8 ? 0 : 0.1, hx, hy); else drop(lane, live, 'Lost it'); }
          continue;
        }
        // Struck, not camped on: the hand has to arrive moving (or, for a comet, moving the right way).
        const moving = hand ? hand.speed : 0, along = hand && moving > 0.1 ? ((hand.x - hand.px) * nt.dx + (hand.y - hand.py) * nt.dy) / (Math.hypot(hand.x - hand.px, hand.y - hand.py) || 1) : 0;
        if (Math.abs(due) <= WINDOW && near < R * 1.25 && (nt.kind === 'orb' ? moving > 1.2 : moving > 3.5 && along > 0.35)) land(lane, live, Math.abs(due), tx, ty);
        else if (due < -WINDOW) drop(lane, live);
      }
      lane.sprites.forEach((sp, k) => { if (!used.has(k)) { show(sp.e, false); show(sp.landing, false); } });
      if (!lane.live.slice(lane.head, lane.head + 12).some((l) => l.state === 'in' && l.note.kind === 'rail' && l.note.t - t < APPROACH)) for (const sp of lane.sprites) if (sp.rail) show(sp.rail.entity, false);
      hud.p('s', team ? 0 : lane.p, !pl.present ? 'Step into view' : String(team ? total() : lane.score));
      if (!lane.live.slice(lane.head, lane.head + 3).some((l) => l.state === 'in' && (l.note.kind === 'duck' || l.note.kind === 'lean') && l.note.t - t < APPROACH))
        hud.p('h', lane.p, t < 0 ? `${song.name} · hit the notes on the beat` : lane.fever > 0 ? `Fever ${Math.ceil(lane.fever)}s · ×${lane.mult * 2}` : lane.combo >= 5 ? `${lane.combo} combo · ×${lane.mult}` : `Fever ${Math.round(lane.meter * 100)}%`);
    }
    for (const sh of shocks) { if (!show(sh.e, sh.life > 0)) continue; sh.life -= dt * 3.2; const k = R * (1 + (1 - sh.life) * 2.2 * sh.big); sh.e.setLocalPosition(sh.x, sh.y, 0.7); sh.e.setLocalScale(k, k, 1); fade(sh.e, Math.max(0, sh.life) ** 1.5); }
    bursts.update(dt);
    passed(total());
  };
}
