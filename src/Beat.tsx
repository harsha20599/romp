// Beat — moves fall to the line in time with the music: left up, right up, both up, squat, jump.
// Each move has its own lane and shape; landing it close to the beat is "Perfect" and scores double.
// All vertical, so it is compact. The clock is the AudioContext's, so notes and sound cannot drift apart.
import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { players, tuning, type Player } from './pose.ts';
import { COUNTDOWN, H, Stage, audio, blip, comboText, countdown, drumLoop, scoreHud, useBursts, zoneHalf, zoneX, type GameProps, type Hud } from './stage.tsx';

const BPM = 104, BEAT = 60 / BPM, ROUND = 60, FALL = 2.4; // FALL = seconds a note is on screen before its beat
const HIT_Y = -2.8, WINDOW = 0.26, PERFECT = 0.11; // seconds either side of the beat
const LATENCY = 0.12; // ponytail: one guess for camera + TV lag, shifts the judged window later. Make it a calibration screen if it feels off.
const up = (pl: Player, h: number) => pl.hands[h].seen && pl.hands[h].y > tuning.handUp;
const disc = new THREE.CircleGeometry(0.55, 24), wide = new THREE.PlaneGeometry(3.4, 0.55), tri = new THREE.CircleGeometry(0.7, 3);
const MOVES = [
  { hint: 'Left up', color: '#818cf8', lane: -0.7, geo: disc, ok: (pl: Player) => up(pl, 0) && !up(pl, 1) },
  { hint: 'Right up', color: '#34d399', lane: 0.7, geo: disc, ok: (pl: Player) => up(pl, 1) && !up(pl, 0) },
  { hint: 'Both up', color: '#fbbf24', lane: 0, geo: wide, ok: (pl: Player) => up(pl, 0) && up(pl, 1) },
  { hint: 'Squat', color: '#f43f5e', lane: 0, geo: tri, ok: (pl: Player) => pl.lift < tuning.crouch },
  { hint: 'Jump', color: '#22d3ee', lane: 0, geo: tri, ok: (pl: Player) => pl.lift > tuning.jump },
];

// One move every two beats, then every beat for the second half; never the same move twice running.
const chart = () => {
  const notes: { at: number; move: number; best: number[]; judged: boolean }[] = [];
  for (let b = 4, last = -1; b * BEAT < ROUND - 1; b += b * BEAT < ROUND / 2 ? 2 : 1) {
    let move = Math.floor(Math.random() * MOVES.length);
    if (move === last) move = (move + 1) % MOVES.length;
    notes.push({ at: b * BEAT, move: (last = move), best: [Infinity, Infinity], judged: false });
  }
  return notes;
};

function Scene({ n, onEnd, hud }: GameProps & { hud: Hud }) {
  const notes = useMemo(chart, []);
  const meshes = useRef<(THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial> | null)[]>([]);
  const lines = useRef<(THREE.Mesh | null)[]>([]);
  const bursts = useBursts();
  const g = useRef({ start: audio().currentTime + COUNTDOWN, scores: [0, 0], combo: [0, 0], said: ['', ''], saidUntil: [0, 0], done: false, last: 0 }).current;
  const drums = useMemo(() => drumLoop(BPM, g.start), [g]);
  const laneX = (p: number, lane: number) => zoneX(n, p) + lane * zoneHalf(n) * 0.55;

  useFrame(() => {
    if (g.done) return;
    const t = audio().currentTime - g.start, dt = Math.min(0.05, t - g.last);
    g.last = t;
    countdown(hud, t, ROUND);
    if (t >= ROUND) { g.done = true; blip(880, 0.4); return onEnd(g.scores.slice(0, n)); }
    drums.tick(t);

    const pulse = 1 + 0.6 * Math.max(0, 1 - ((((t % BEAT) + BEAT) % BEAT) / BEAT) * 3); // the line kicks on every beat
    lines.current.forEach((l) => l?.scale.set(1, pulse, 1));

    const next = notes.find((note) => !note.judged);
    notes.forEach((note, i) => {
      const due = note.at - (t - LATENCY), move = MOVES[note.move];
      for (let p = 0; p < n; p++) {
        if (Math.abs(due) < WINDOW && move.ok(players[p])) note.best[p] = Math.min(note.best[p], Math.abs(due));
        const m = meshes.current[i * n + p], hit = note.best[p] < Infinity;
        if (!m) continue;
        m.visible = note.at - t < FALL && due > -WINDOW - 0.15;
        m.position.set(laneX(p, move.lane), HIT_Y + ((note.at - t) / FALL) * (H / 2 - HIT_Y), 0);
        m.rotation.z = note.move === 3 ? -Math.PI / 2 : Math.PI / 2; // squat points down, jump points up
        m.scale.setScalar(hit ? 1.4 : 1);
        m.material.opacity = hit ? 0.3 : 1;
      }
      if (note.judged || due > -WINDOW) return;
      note.judged = true;
      for (let p = 0; p < n; p++) {
        if (!players[p].present) continue;
        const perfect = note.best[p] < PERFECT;
        if (note.best[p] < Infinity) {
          g.scores[p] += (perfect ? 2 : 1) + Math.floor(++g.combo[p] / 5);
          blip(perfect ? 1320 : 880, 0.05, 'triangle');
          bursts.burst(laneX(p, move.lane), HIT_Y, 0.5, move.color, perfect ? 24 : 10);
        } else g.combo[p] = 0;
        g.said[p] = note.best[p] < Infinity ? (perfect ? 'Perfect!' : 'Good') : 'Miss';
        g.saidUntil[p] = t + 0.45;
      }
    });
    for (let p = 0; p < n; p++)
      hud.p('h', p, t < 0 ? 'Move on the beat' : g.saidUntil[p] > t ? g.said[p] : next ? MOVES[next.move].hint : comboText(g.combo[p]));
    bursts.update(dt);
    scoreHud(hud, n, g.scores);
  });

  return (
    <>
      {notes.flatMap((note, i) =>
        Array.from({ length: n }, (_, p) => (
          <mesh key={`${i}.${p}`} ref={(m) => void (meshes.current[i * n + p] = m as never)} geometry={MOVES[note.move].geo} visible={false}>
            <meshBasicMaterial color={MOVES[note.move].color} transparent />
          </mesh>
        )),
      )}
      {Array.from({ length: n }, (_, p) => (
        <mesh key={p} ref={(m) => void (lines.current[p] = m)} position={[zoneX(n, p), HIT_Y, -0.1]}>
          <planeGeometry args={[zoneHalf(n) * 1.6, 0.1]} /><meshBasicMaterial color="#fafafa" />
        </mesh>
      ))}
      {bursts.node}
      {n === 2 && <mesh><planeGeometry args={[0.04, H]} /><meshBasicMaterial color="#3f3f46" /></mesh>}
    </>
  );
}

export default (props: GameProps) => <Stage n={props.n}>{(hud) => <Scene {...props} hud={hud} />}</Stage>;
