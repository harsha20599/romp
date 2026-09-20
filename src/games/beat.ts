// Beat — moves fall to the line in time with the music: left up, right up, both up, squat, jump.
// Each move has its own lane and shape; landing it close to the beat is "Perfect" and scores double.
// All vertical, so it is compact. The clock is the AudioContext's, so notes and sound cannot drift apart.
import { isAir, isLow, players, tuning, type Player } from '../pose.ts';
import { hardness } from '../meta.ts';
import { backdrop, fade, flat, node, shapes, show } from '../engine.ts';
import { COUNTDOWN, H, audio, bursts as makeBursts, comboText, countdown, divider, hitSound, inputLag, music, say, scoreHud, zoneHalf, zoneX, type Game } from '../kit.ts';

const BPM = 104, BEAT = 60 / BPM, ROUND = 60, FALL = 2.4; // FALL = seconds a note is on screen before its beat
const HIT_Y = -2.8, WINDOW = 0.26, PERFECT = 0.11; // seconds either side of the beat
const HOLD = 1.5; // a move must have been started this recently to count: getting into it early is fine, standing there with a hand up all round is not
const up = (pl: Player, h: number) => pl.hands[h].seen && pl.hands[h].y > tuning.handUp;
const MOVES = [
  { hint: 'Left up', color: '#818cf8', lane: -0.7, shape: 'disc', ok: (pl: Player) => up(pl, 0) && !up(pl, 1) },
  { hint: 'Right up', color: '#34d399', lane: 0.7, shape: 'disc', ok: (pl: Player) => up(pl, 1) && !up(pl, 0) },
  { hint: 'Both up', color: '#fbbf24', lane: 0, shape: 'wide', ok: (pl: Player) => up(pl, 0) && up(pl, 1) },
  { hint: 'Squat', color: '#f43f5e', lane: 0, shape: 'tri', ok: isLow },
  { hint: 'Jump', color: '#22d3ee', lane: 0, shape: 'tri', ok: isAir },
] as const;

// One move every two beats, then every beat for the second half; never the same move twice running.
const chart = (hard: number) => {
  const notes: { at: number; move: number; best: number[]; state: number[]; judged: boolean }[] = []; // state per player: 0 waiting, 1 in the move early, 2 scored
  for (let b = 4, last = -1; b * BEAT < ROUND - 1; b += b * BEAT < ROUND / 2 / hard ? 2 : 1) {
    let move = Math.floor(Math.random() * MOVES.length);
    if (move === last) move = (move + 1) % MOVES.length;
    notes.push({ at: b * BEAT, move: (last = move), best: [Infinity, Infinity], state: [0, 0], judged: false });
  }
  return notes;
};

export default function beat({ n, stage, onEnd, hud, scene }: Game) {
  const notes = chart(hardness(stage));
  backdrop(scene, 'synth');
  const mesh = { disc: shapes.circle(0.55, 24), wide: shapes.quad(3.4, 0.55), tri: shapes.circle(0.7, 3) }, looks = MOVES.map((m) => flat(m.color, { opacity: 1 }));
  // One marker per note per player, made up front and hidden until its note is on screen.
  const marks = notes.map((note) => Array.from({ length: n }, () => {
    const e = node(scene.root, mesh[MOVES[note.move].shape], looks[note.move]);
    e.setLocalEulerAngles(0, 0, note.move === 3 ? -90 : 90); // squat points down, jump points up
    e.enabled = false;
    return e;
  }));
  const lineLook = flat('#fafafa'), lines = Array.from({ length: n }, (_, p) => node(scene.root, shapes.quad(zoneHalf(n) * 1.6, 0.1), lineLook, [zoneX(n, p), HIT_Y, -0.1]));
  divider(scene, n);
  const bursts = makeBursts(scene.root);
  const g = { start: audio().currentTime + COUNTDOWN, scores: [0, 0], combo: [0, 0], said: ['', ''], saidUntil: [0, 0], done: false, last: 0, since: [MOVES.map(() => -9), MOVES.map(() => -9)] };
  music.start('beat', g.start, 0.6); // the band starts on the game's beat zero
  const laneX = (p: number, lane: number) => zoneX(n, p) + lane * zoneHalf(n) * 0.55;

  return () => {
    if (g.done) return;
    const t = audio().currentTime - g.start, dt = Math.min(0.05, t - g.last);
    g.last = t;
    countdown(hud, t, ROUND);
    if (t >= ROUND) { g.done = true; music.stop(); say('time_over'); return onEnd(g.scores.slice(0, n)); }
    music.intensity(0.5 + Math.max(g.combo[0], g.combo[1]) / 20);

    const pulse = 1 + 0.6 * Math.max(0, 1 - ((((t % BEAT) + BEAT) % BEAT) / BEAT) * 3); // the line kicks on every beat
    for (const l of lines) l.setLocalScale(1, pulse, 1);

    // What the game sees now, the player did `lag` ago: the measured tracking delay, plus how late they hear the band.
    const lag = inputLag() + (audio().outputLatency || 0);
    const doing = [0, 1].map((p) => MOVES.map((move, k) => { const ok = move.ok(players[p]); if (!ok) g.since[p][k] = t; return ok && t - g.since[p][k] < HOLD; }));
    // Scored the instant it is earned — the sound and the burst land on the beat, not a quarter-second after it.
    const score = (note: (typeof notes)[number], p: number, off: number) => {
      const perfect = off < PERFECT, move = MOVES[note.move];
      note.state[p] = 2; note.best[p] = off;
      g.scores[p] += (perfect ? 2 : 1) + Math.floor(++g.combo[p] / 5);
      hitSound(perfect ? 'select' : 'click', g.combo[p], 0.6);
      bursts.burst(laneX(p, move.lane), HIT_Y, 0.5, move.color, perfect ? 24 : 10);
      g.said[p] = perfect ? 'Perfect!' : 'Good'; g.saidUntil[p] = t + 0.45;
    };

    const next = notes.find((note) => !note.judged);
    notes.forEach((note, i) => {
      const due = note.at - (t - lag), move = MOVES[note.move];
      for (let p = 0; p < n; p++) {
        if (note.state[p] < 2 && Math.abs(due) < WINDOW && players[p].present) {
          const ok = doing[p][note.move];
          // In the move early? Hold it and it turns Perfect as the note arrives; let go first and it was only Good.
          if (ok && due <= PERFECT) score(note, p, note.state[p] === 1 ? 0 : Math.abs(due));
          else if (ok) note.state[p] = 1;
          else if (note.state[p] === 1) score(note, p, due);
        }
        const m = marks[i][p], hit = note.state[p] === 2;
        if (!show(m, note.at - t < FALL && due > -WINDOW - 0.15)) continue;
        m.setLocalPosition(laneX(p, move.lane), HIT_Y + ((note.at - t) / FALL) * (H / 2 - HIT_Y), 0);
        m.setLocalScale(hit ? 1.4 : 1, hit ? 1.4 : 1, 1);
        fade(m, hit ? 0.3 : 1);
      }
      if (note.judged || due > -WINDOW) return;
      note.judged = true;
      for (let p = 0; p < n; p++) {
        if (!players[p].present) continue;
        if (note.state[p] === 2) continue;
        if (note.state[p] === 1) { score(note, p, WINDOW); continue; } // held it right through: late, but it counts
        g.combo[p] = 0; g.said[p] = 'Miss'; g.saidUntil[p] = t + 0.45;
      }
    });
    for (let p = 0; p < n; p++)
      hud.p('h', p, t < 0 ? 'Move on the beat' : g.saidUntil[p] > t ? g.said[p] : next ? MOVES[next.move].hint : comboText(g.combo[p]));
    bursts.update(dt);
    scoreHud(hud, n, g.scores);
  };
}
