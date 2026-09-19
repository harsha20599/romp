// Slice — fruit-slicer. Solo owns the whole stage; together, a half each (compact: hands are body-relative).
// Fruit splits along the cut, golden fruit is worth 5, bombs cost 5, and the last 10 seconds are a frenzy.
import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { H, Stage, blip, comboText, scoreHud, segDist, useBursts, useHands, useRound, zoneHalf, zoneX, type GameProps, type Hud } from './stage.tsx';

const R = 0.7, GRAVITY = -9, ROUND = 60, POOL = 24, HALVES = 24, FRENZY = 10;
const SLICE_SPEED = 5; // stage units/s a hand must move to cut — tune on device
const COLORS = ['#f43f5e', '#f59e0b', '#84cc16', '#22d3ee', '#a78bfa', '#fb923c'];
const fruitGeo = new THREE.IcosahedronGeometry(R, 1), halfGeo = new THREE.SphereGeometry(R, 10, 8, 0, Math.PI);

type Kind = 'fruit' | 'gold' | 'bomb';
type Fruit = { live: boolean; kind: Kind; color: string; zone: number; x: number; y: number; vx: number; vy: number; spin: number };
type Half = { life: number; x: number; y: number; vx: number; vy: number; rot: number; spin: number };
type FruitMesh = THREE.Mesh<THREE.BufferGeometry, THREE.MeshLambertMaterial>;

function Scene({ n, onEnd, hud }: GameProps & { hud: Hud }) {
  const fruits = useMemo<Fruit[]>(() => Array.from({ length: POOL }, () => ({ live: false, kind: 'fruit', color: '', zone: 0, x: 0, y: 0, vx: 0, vy: 0, spin: 0 })), []);
  const halves = useMemo<Half[]>(() => Array.from({ length: HALVES }, () => ({ life: 0, x: 0, y: 0, vx: 0, vy: 0, rot: 0, spin: 0 })), []);
  const meshes = useRef<(FruitMesh | null)[]>([]), halfMeshes = useRef<(FruitMesh | null)[]>([]);
  const g = useRef({ spawnIn: [0, 0], scores: [0, 0], combo: [0, 0], half: 0 }).current;
  const hands = useHands(n), bursts = useBursts();
  const tick = useRound(hud, ROUND, () => onEnd(g.scores.slice(0, n)));

  useFrame((_, rawDt) => {
    const dt = Math.min(rawDt, 0.05), t = tick(rawDt);
    if (t === null) return;
    const frenzy = t > ROUND - FRENZY;

    if (t >= 0)
      for (let z = 0; z < n; z++) {
        if ((g.spawnIn[z] -= dt) > 0) continue;
        g.spawnIn[z] = frenzy ? 0.3 : 1 - 0.5 * (t / ROUND) + Math.random() * 0.3;
        const f = fruits.find((f) => !f.live);
        if (!f) continue;
        const side = Math.random() * 2 - 1, roll = Math.random();
        const kind: Kind = roll < (frenzy ? 0 : 0.12) ? 'bomb' : roll < 0.2 ? 'gold' : 'fruit';
        Object.assign(f, {
          live: true, zone: z, kind, spin: Math.random() * 4 - 2,
          color: kind === 'bomb' ? '#18181b' : kind === 'gold' ? '#fde047' : COLORS[Math.floor(Math.random() * COLORS.length)],
          x: zoneX(n, z) + side * zoneHalf(n) * 0.7, y: -H / 2 - R,
          vx: -side * (0.5 + Math.random()), vy: (kind === 'gold' ? 11.5 : 10) + Math.random() * 2,
        });
      }

    for (const h of hands.update(dt)) {
      if (t < 0 || !h.on || h.speed < SLICE_SPEED) continue;
      for (const f of fruits) {
        if (!f.live || f.zone !== h.p || segDist(f.x, f.y, h.px, h.py, h.x, h.y) > R * 1.2) continue;
        f.live = false;
        if (f.kind === 'bomb') {
          g.scores[h.p] = Math.max(0, g.scores[h.p] - 5); g.combo[h.p] = 0;
          blip(90, 0.3); hud.flash('#ef4444'); bursts.burst(f.x, f.y, 0.5, '#ef4444', 30, 9);
          continue;
        }
        g.scores[h.p] += (f.kind === 'gold' ? 5 : 1) + Math.floor(++g.combo[h.p] / 5);
        blip((f.kind === 'gold' ? 900 : 500) + 40 * Math.min(g.combo[h.p], 12));
        bursts.burst(f.x, f.y, 0.5, f.color, f.kind === 'gold' ? 26 : 12);
        // Two halves fly apart across the line of the cut.
        const len = Math.hypot(h.x - h.px, h.y - h.py) || 1, nx = -(h.y - h.py) / len, ny = (h.x - h.px) / len;
        for (const dir of [1, -1]) {
          const i = (g.half = (g.half + 1) % HALVES);
          Object.assign(halves[i], { life: 0.7, x: f.x, y: f.y, vx: f.vx + nx * dir * 3, vy: f.vy * 0.4 + ny * dir * 3 + 2, rot: Math.atan2(ny * dir, nx * dir), spin: dir * 5 });
          halfMeshes.current[i]?.material.color.set(f.color);
        }
      }
    }

    fruits.forEach((f, i) => {
      const m = meshes.current[i];
      if (!m) return;
      if (f.live) {
        f.vy += GRAVITY * dt; f.x += f.vx * dt; f.y += f.vy * dt;
        if (f.y < -H / 2 - 2 * R) { f.live = false; if (f.kind !== 'bomb') g.combo[f.zone] = 0; }
        m.rotation.x += f.spin * dt; m.rotation.z += f.spin * dt * 0.7;
        m.scale.setScalar(f.kind === 'gold' ? 0.75 : 1);
        m.material.color.set(f.color);
        m.material.emissive.set(f.kind === 'bomb' ? '#7f1d1d' : f.kind === 'gold' ? '#a16207' : '#000000');
        m.position.set(f.x, f.y, 0);
      }
      m.visible = f.live;
    });
    halves.forEach((hf, i) => {
      const m = halfMeshes.current[i];
      if (!m) return;
      if ((m.visible = hf.life > 0)) {
        hf.life -= dt; hf.vy += GRAVITY * dt; hf.x += hf.vx * dt; hf.y += hf.vy * dt; hf.rot += hf.spin * dt;
        m.position.set(hf.x, hf.y, 0);
        m.rotation.set(0, Math.PI / 2, hf.rot, 'ZYX');
        m.material.opacity = Math.min(1, hf.life * 3);
      }
    });
    bursts.update(dt);
    scoreHud(hud, n, g.scores);
    for (let p = 0; p < n; p++) hud.p('h', p, frenzy && g.combo[p] < 5 ? 'Frenzy!' : comboText(g.combo[p]));
  });

  return (
    <>
      {fruits.map((_, i) => (
        <mesh key={i} ref={(m) => void (meshes.current[i] = m as never)} geometry={fruitGeo} visible={false}><meshLambertMaterial flatShading /></mesh>
      ))}
      {halves.map((_, i) => (
        <mesh key={i} ref={(m) => void (halfMeshes.current[i] = m as never)} geometry={halfGeo} visible={false}>
          <meshLambertMaterial flatShading transparent side={THREE.DoubleSide} />
        </mesh>
      ))}
      {hands.nodes}
      {bursts.node}
      {n === 2 && <mesh><planeGeometry args={[0.04, H]} /><meshBasicMaterial color="#3f3f46" /></mesh>}
    </>
  );
}

export default (props: GameProps) => <Stage n={props.n}>{(hud) => <Scene {...props} hud={hud} />}</Stage>;
