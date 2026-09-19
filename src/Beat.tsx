// Beat — moves fall to the line in time with a drum loop: left up, right up, both up, squat.
// All vertical, so it is compact. The clock is the AudioContext's, so notes and sound cannot drift apart.
import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { players, tuning, type Player } from './pose.ts';
import { COUNTDOWN, H, Stage, audio, blip, scoreHud, zoneHalf, zoneX, type GameProps, type Hud } from './stage.tsx';

const BPM = 104, BEAT = 60 / BPM, ROUND = 60, FALL = 2.4; // FALL = seconds a note is on screen before its beat
const HIT_Y = -2.8, WINDOW = 0.24; // seconds either side of the beat that still count
const LATENCY = 0.12; // ponytail: one guess for camera + TV lag, shifts the judged window later. Make it a calibration screen if it feels off.
const up = (pl: Player, h: number) => pl.hands[h].seen && pl.hands[h].y > tuning.handUp;
const MOVES = [
  { hint: 'Left up', color: '#818cf8', lane: -1.5, ok: (pl: Player) => up(pl, 0) && !up(pl, 1) },
  { hint: 'Right up', color: '#34d399', lane: 1.5, ok: (pl: Player) => up(pl, 1) && !up(pl, 0) },
  { hint: 'Both up', color: '#fbbf24', lane: 0, ok: (pl: Player) => up(pl, 0) && up(pl, 1) },
  { hint: 'Squat', color: '#f43f5e', lane: 0, ok: (pl: Player) => pl.lift < tuning.crouch },
];
const BASS = [55, 55, 65.4, 73.4];
const noteGeo = new THREE.CircleGeometry(0.55, 6);

// One move every two beats, then every beat for the second half. Same chart for both players.
const chart = () => {
  const notes: { at: number; move: number; hit: boolean[]; judged: boolean }[] = [];
  for (let b = 4; b * BEAT < ROUND - 1; b += b * BEAT < ROUND / 2 ? 2 : 1)
    notes.push({ at: b * BEAT, move: Math.floor(Math.random() * MOVES.length), hit: [false, false], judged: false });
  return notes;
};

function Scene({ n, onEnd, hud }: GameProps & { hud: Hud }) {
  const notes = useMemo(chart, []);
  const meshes = useRef<(THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial> | null)[]>([]);
  const g = useRef({ start: audio().currentTime + COUNTDOWN, beat: 0, scores: [0, 0], combo: [0, 0], done: false }).current;

  useFrame(() => {
    if (g.done) return;
    const t = audio().currentTime - g.start;
    hud('clock', String(Math.ceil(t < 0 ? -t : ROUND - t)));
    if (t >= ROUND) { g.done = true; blip(880, 0.4); return onEnd(g.scores.slice(0, n)); }

    // Drums, scheduled a little ahead on the audio clock: kick on the beat, hat between, a bass note per bar.
    for (; g.beat * BEAT < t + 0.2; g.beat++) {
      const at = g.start + g.beat * BEAT;
      if (at < audio().currentTime) continue;
      blip(55, 0.18, 'sine', at, 0.5);
      blip(7000, 0.03, 'square', at + BEAT / 2, 0.03);
      if (g.beat % 4 === 0) blip(BASS[(g.beat / 4) % 4], BEAT * 2, 'sawtooth', at, 0.06);
    }

    const next = notes.find((note) => !note.judged);
    notes.forEach((note, i) => {
      const due = note.at - (t - LATENCY);
      for (let p = 0; p < n; p++) {
        if (Math.abs(due) < WINDOW && MOVES[note.move].ok(players[p])) note.hit[p] = true;
        const m = meshes.current[i * n + p];
        if (!m) continue;
        m.visible = note.at - t < FALL && due > -WINDOW - 0.15;
        m.position.set(zoneX(n, p) + MOVES[note.move].lane * Math.min(1, zoneHalf(n) / 4), HIT_Y + ((note.at - t) / FALL) * (H / 2 - HIT_Y), 0);
        m.scale.setScalar(note.hit[p] ? 1.5 : 1);
        m.material.opacity = note.hit[p] ? 0.35 : 1;
      }
      if (note.judged || due > -WINDOW) return;
      note.judged = true;
      for (let p = 0; p < n; p++) {
        if (!players[p].present) continue;
        if (note.hit[p]) { g.scores[p] += 1 + Math.floor(++g.combo[p] / 5); blip(880, 0.05, 'triangle'); } else g.combo[p] = 0;
      }
    });
    for (let p = 0; p < n; p++) hud(`h${p}` as 'h0', t < 0 ? 'Move on the beat' : next ? MOVES[next.move].hint : '');
    scoreHud(hud, n, g.scores);
  });

  return (
    <>
      {notes.flatMap((note, i) =>
        Array.from({ length: n }, (_, p) => (
          <mesh key={`${i}.${p}`} ref={(m) => void (meshes.current[i * n + p] = m as never)} geometry={noteGeo} visible={false}>
            <meshBasicMaterial color={MOVES[note.move].color} transparent />
          </mesh>
        )),
      )}
      {Array.from({ length: n }, (_, p) => (
        <mesh key={p} position={[zoneX(n, p), HIT_Y, -0.1]}><planeGeometry args={[zoneHalf(n) * 1.6, 0.08]} /><meshBasicMaterial color="#fafafa" /></mesh>
      ))}
      {n === 2 && <mesh><planeGeometry args={[0.04, H]} /><meshBasicMaterial color="#3f3f46" /></mesh>}
    </>
  );
}

export default (props: GameProps) => <Stage n={props.n}>{(hud) => <Scene {...props} hud={hud} />}</Stage>;
