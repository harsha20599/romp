// Dodge — obstacles rush down a track: jump the low bar, duck the high bar, lean away from the half-walls.
// Everything is a vertical move or a lean, so two tracks side by side still fit a narrow room.
import { useLayoutEffect, useMemo, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { players, tuning } from './pose.ts';
import { PLAYER_COLORS, Stage, blip, scoreHud, useRound, type GameProps, type Hud } from './stage.tsx';

const ROUND = 75, FAR = -60, WINDOW = 1.6, TRACK_W = 5, PER_TRACK = 8, STRIPES = 10;
const KINDS = {
  jump: { hint: 'Jump', color: '#fbbf24', size: [4.6, 0.5, 0.5], at: [0, 0.25], ok: (lift: number, _lean: number) => lift > tuning.jump },
  duck: { hint: 'Duck', color: '#22d3ee', size: [4.6, 0.7, 0.5], at: [0, 2.05], ok: (lift: number, _lean: number) => lift < tuning.crouch },
  left: { hint: 'Lean right', color: '#f43f5e', size: [2.4, 2.6, 0.5], at: [-1.2, 1.3], ok: (_lift: number, lean: number) => lean > tuning.leanOver },
  right: { hint: 'Lean left', color: '#f43f5e', size: [2.4, 2.6, 0.5], at: [1.2, 1.3], ok: (_lift: number, lean: number) => lean < -tuning.leanOver },
} as const;
type Kind = keyof typeof KINDS;
const KIND_NAMES = Object.keys(KINDS) as Kind[];
const box = new THREE.BoxGeometry(1, 1, 1);

type Ob = { live: boolean; kind: Kind; z: number; cleared: boolean };

function Scene({ n, onEnd, hud }: GameProps & { hud: Hud }) {
  const camera = useThree((s) => s.camera);
  useLayoutEffect(() => camera.lookAt(0, 1.2, -12), [camera]);

  const trackX = (p: number) => (n === 1 ? 0 : (p - 0.5) * (TRACK_W + 1.5));
  const obs = useMemo<Ob[][]>(() => Array.from({ length: n }, () => Array.from({ length: PER_TRACK }, () => ({ live: false, kind: 'jump' as Kind, z: 0, cleared: false }))), [n]);
  const obMeshes = useRef<(THREE.Mesh<THREE.BufferGeometry, THREE.MeshLambertMaterial> | null)[]>([]);
  const stripes = useRef<(THREE.Mesh | null)[]>([]);
  const avatars = useRef<(THREE.Group | null)[]>([]);
  const bodies = useRef<(THREE.Mesh<THREE.BufferGeometry, THREE.MeshLambertMaterial> | null)[]>([]);
  const g = useRef({ spawnIn: 1, scores: [0, 0], combo: [0, 0], hurt: [0, 0] }).current;
  const tick = useRound(hud, ROUND, () => onEnd(g.scores.slice(0, n)));

  useFrame((_, rawDt) => {
    const dt = Math.min(rawDt, 0.05), t = tick(rawDt);
    if (t === null) return;
    const speed = 14 + 9 * Math.max(0, t / ROUND);

    // Same obstacle on every track at the same moment — a fair race.
    if (t >= 0 && (g.spawnIn -= dt) <= 0) {
      g.spawnIn = 1.9 - 0.8 * (t / ROUND);
      const kind = KIND_NAMES[Math.floor(Math.random() * KIND_NAMES.length)];
      for (const track of obs) Object.assign(track.find((o) => !o.live) ?? {}, { live: true, kind, z: FAR, cleared: false });
    }

    for (let p = 0; p < n; p++) {
      const pl = players[p];
      let next: Ob | undefined;
      for (const [i, o] of obs[p].entries()) {
        const m = obMeshes.current[p * PER_TRACK + i];
        if (!m) continue;
        if (o.live) {
          o.z += speed * dt;
          if (Math.abs(o.z) < WINDOW && KINDS[o.kind].ok(pl.lift, pl.lean)) o.cleared = true; // any moment inside the window counts
          if (o.z < -WINDOW && (!next || o.z > next.z)) next = o;
          if (o.z >= WINDOW) {
            o.live = false;
            if (!pl.present) { /* nobody on this track */ }
            else if (o.cleared) { g.scores[p] += 1 + Math.floor(++g.combo[p] / 5); blip(520 + 40 * Math.min(g.combo[p], 12)); }
            else { g.combo[p] = 0; g.hurt[p] = 0.4; blip(90, 0.3); }
          }
        }
        const k = KINDS[o.kind];
        m.visible = o.live;
        m.position.set(trackX(p) + k.at[0], k.at[1], o.z);
        m.scale.set(k.size[0], k.size[1], k.size[2]);
        m.material.color.set(k.color);
      }
      hud(`h${p}` as 'h0', next ? KINDS[next.kind].hint : '');

      // The avatar mirrors the body, so you can see what the game thinks you are doing.
      const a = avatars.current[p], body = bodies.current[p];
      if (!a || !body) continue;
      a.visible = pl.present;
      const lean = Math.max(-1, Math.min(1, pl.lean / tuning.leanOver));
      a.position.x += (trackX(p) + lean * 1.3 - a.position.x) * Math.min(1, dt * 14);
      a.position.y = Math.max(0, pl.lift) * 2.2;
      a.scale.y += ((pl.lift < tuning.crouch ? 0.5 : 1) - a.scale.y) * Math.min(1, dt * 18);
      a.rotation.z = -lean * 0.35;
      g.hurt[p] = Math.max(0, g.hurt[p] - dt);
      body.material.color.set(g.hurt[p] > 0 ? '#f87171' : PLAYER_COLORS[p]);
    }

    stripes.current.forEach((s) => s && (s.position.z = ((s.position.z - FAR + speed * dt) % -FAR) + FAR));
    scoreHud(hud, n, g.scores);
  });

  return (
    <>
      {Array.from({ length: n }, (_, p) => (
        <group key={p}>
          <mesh position={[trackX(p), -0.01, FAR / 2 + 3]} rotation-x={-Math.PI / 2}>
            <planeGeometry args={[TRACK_W, -FAR + 6]} />
            <meshBasicMaterial color="#131316" transparent opacity={0.85} />
          </mesh>
          {obs[p].map((_, i) => (
            <mesh key={i} ref={(m) => void (obMeshes.current[p * PER_TRACK + i] = m as never)} geometry={box} visible={false}>
              <meshLambertMaterial />
            </mesh>
          ))}
          <group ref={(a) => void (avatars.current[p] = a)}>
            <mesh ref={(m) => void (bodies.current[p] = m as never)} geometry={box} position-y={0.75} scale={[0.9, 1.5, 0.5]}>
              <meshLambertMaterial />
            </mesh>
            <mesh position-y={1.85}><sphereGeometry args={[0.32, 16, 12]} /><meshLambertMaterial color="#fafafa" /></mesh>
          </group>
        </group>
      ))}
      {Array.from({ length: STRIPES * n }, (_, i) => (
        <mesh key={i} ref={(m) => void (stripes.current[i] = m)} position={[trackX(i % n), 0, FAR + (Math.floor(i / n) * -FAR) / STRIPES]} rotation-x={-Math.PI / 2}>
          <planeGeometry args={[TRACK_W, 0.12]} />
          <meshBasicMaterial color="#3f3f46" />
        </mesh>
      ))}
    </>
  );
}

export default (props: GameProps) => (
  <Stage n={props.n} camera={{ position: [0, 3.6, 7.5], fov: 55, near: 0.1, far: 120 }}>{(hud) => <Scene {...props} hud={hud} />}</Stage>
);
