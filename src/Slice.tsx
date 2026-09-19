// Slice — fruit-slicer. Solo owns the whole stage; together, a half each (compact: hands are body-relative).
import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { H, Stage, blip, scoreHud, segDist, useHands, useRound, zoneHalf, zoneX, type GameProps, type Hud } from './stage.tsx';

const R = 0.7, GRAVITY = -9, ROUND = 60, POOL = 24;
const SLICE_SPEED = 6; // stage units/s a hand must move to cut — tune on device
const COLORS = ['#f43f5e', '#f59e0b', '#84cc16', '#22d3ee', '#a78bfa', '#fb923c'];
const fruitGeo = new THREE.IcosahedronGeometry(R, 1);

type Fruit = { live: boolean; pop: number; bomb: boolean; zone: number; x: number; y: number; vx: number; vy: number; spin: number };

function Scene({ n, onEnd, hud }: GameProps & { hud: Hud }) {
  const fruits = useMemo<Fruit[]>(
    () => Array.from({ length: POOL }, () => ({ live: false, pop: 0, bomb: false, zone: 0, x: 0, y: 0, vx: 0, vy: 0, spin: 0 })),
    [],
  );
  const meshes = useRef<(THREE.Mesh<THREE.BufferGeometry, THREE.MeshLambertMaterial> | null)[]>([]);
  const g = useRef({ spawnIn: [0, 0], scores: [0, 0], combo: [0, 0] }).current;
  const hands = useHands(n);
  const tick = useRound(hud, ROUND, () => onEnd(g.scores.slice(0, n)));

  useFrame((_, rawDt) => {
    const dt = Math.min(rawDt, 0.05), t = tick(rawDt);
    if (t === null) return;

    if (t >= 0)
      for (let z = 0; z < n; z++) {
        if ((g.spawnIn[z] -= dt) > 0) continue;
        g.spawnIn[z] = 1 - 0.55 * (t / ROUND) + Math.random() * 0.3; // ramps from ~1.1s to ~0.6s
        const f = fruits.find((f) => !f.live && f.pop <= 0);
        if (!f) continue;
        const side = Math.random() * 2 - 1;
        Object.assign(f, {
          live: true, zone: z, bomb: Math.random() < 0.12, spin: Math.random() * 4 - 2,
          x: zoneX(n, z) + side * zoneHalf(n) * 0.7, y: -H / 2 - R,
          vx: -side * (0.5 + Math.random()), vy: 10 + Math.random() * 2,
        });
      }

    for (const h of hands.update(dt)) {
      if (t < 0 || !h.on || h.speed < SLICE_SPEED) continue;
      for (const f of fruits) {
        if (!f.live || f.zone !== h.p || segDist(f.x, f.y, h.px, h.py, h.x, h.y) > R * 1.15) continue;
        f.live = false;
        f.pop = 0.25;
        if (f.bomb) { g.scores[h.p] = Math.max(0, g.scores[h.p] - 5); g.combo[h.p] = 0; blip(90, 0.3); }
        else { g.scores[h.p] += 1 + Math.floor(++g.combo[h.p] / 5); blip(500 + 40 * Math.min(g.combo[h.p], 12)); }
      }
    }

    fruits.forEach((f, i) => {
      const m = meshes.current[i];
      if (!m) return;
      if (f.live) {
        f.vy += GRAVITY * dt; f.x += f.vx * dt; f.y += f.vy * dt;
        if (f.y < -H / 2 - 2 * R) { f.live = false; if (!f.bomb) g.combo[f.zone] = 0; }
        m.rotation.x += f.spin * dt; m.rotation.z += f.spin * dt * 0.7;
        m.scale.setScalar(1); m.material.opacity = 1;
        m.material.color.set(f.bomb ? '#18181b' : COLORS[i % COLORS.length]);
        m.material.emissive.set(f.bomb ? '#7f1d1d' : '#000000');
      } else if (f.pop > 0) {
        f.pop -= dt;
        m.scale.setScalar(1 + (0.25 - f.pop) * 5); m.material.opacity = Math.max(0, f.pop * 4);
      }
      m.visible = f.live || f.pop > 0;
      m.position.set(f.x, f.y, 0);
    });
    scoreHud(hud, n, g.scores);
  });

  return (
    <>
      {fruits.map((_, i) => (
        <mesh key={i} ref={(m) => void (meshes.current[i] = m as never)} geometry={fruitGeo} visible={false}>
          <meshLambertMaterial flatShading transparent />
        </mesh>
      ))}
      {hands.nodes}
      {n === 2 && <mesh><planeGeometry args={[0.04, H]} /><meshBasicMaterial color="#3f3f46" /></mesh>}
    </>
  );
}

export default (props: GameProps) => <Stage n={props.n}>{(hud) => <Scene {...props} hud={hud} />}</Stage>;
