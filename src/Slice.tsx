// Slice — fruit-slicer with real fruit. A cut is a real cut: the model is split along the line of your swipe
// (two clipped copies of the same mesh), the halves tumble apart and the flesh-coloured cut faces turn to the camera.
// Stars are worth 5, bombs cost 5, the last 10 seconds are a frenzy. Solo owns the stage; together, a half each.
import { useLayoutEffect, useMemo, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { hardness } from './meta.ts';
import { H, Stage, comboText, hitSound, music, scoreHud, segDist, sfx, useBursts, useFitted, useHands, useRound, zoneHalf, zoneX, type GameProps, type Hud } from './stage.tsx';

const R = 0.75, GRAVITY = -9, ROUND = 60, POOL = 18, FRENZY = 10;
const SLICE_SPEED = 5; // stage units/s a hand must move to cut — tune on device
const FRUIT = [
  { url: 'apple', flesh: '#fef9c3', cap: 0.62 }, { url: 'orange', flesh: '#fdba74', cap: 0.66 }, { url: 'watermelon', flesh: '#fb7185', cap: 0.5 },
  { url: 'pear', flesh: '#fef08a', cap: 0.5 }, { url: 'lemon', flesh: '#fef9c3', cap: 0.52 }, { url: 'coconut', flesh: '#fafafa', cap: 0.62 },
  { url: 'pineapple', flesh: '#fde047', cap: 0.4 }, { url: 'strawberry', flesh: '#fda4af', cap: 0.45 }, { url: 'banana', flesh: '#fef9c3', cap: 0.2 },
];
const capGeo = new THREE.CircleGeometry(1, 24), Z = new THREE.Vector3(0, 0, 1), v = new THREE.Vector3(), q = new THREE.Quaternion();

type Kind = 'fruit' | 'star' | 'bomb';
type Half = { obj: THREE.Object3D; cap: THREE.Mesh; plane: THREE.Plane; normal: THREE.Vector3; x: number; y: number; vx: number; vy: number };
type Piece = {
  state: 'off' | 'whole' | 'cut'; kind: Kind; zone: number; x: number; y: number; vx: number; vy: number; spin: number; age: number;
  whole: THREE.Object3D; halves: Half[]; along: THREE.Vector3; base: THREE.Quaternion;
};

function Scene({ n, stage, onEnd, hud }: GameProps & { hud: Hud }) {
  const gl = useThree((s) => s.gl);
  useLayoutEffect(() => { gl.localClippingEnabled = true; return () => void (gl.localClippingEnabled = false); }, [gl]);
  const hard = hardness(stage);
  const f0 = useFitted(`/assets/food/${FRUIT[0].url}.glb`, R * 2), f1 = useFitted(`/assets/food/${FRUIT[1].url}.glb`, R * 2), f2 = useFitted(`/assets/food/${FRUIT[2].url}.glb`, R * 2.6);
  const f3 = useFitted(`/assets/food/${FRUIT[3].url}.glb`, R * 2.2), f4 = useFitted(`/assets/food/${FRUIT[4].url}.glb`, R * 1.8), f5 = useFitted(`/assets/food/${FRUIT[5].url}.glb`, R * 2);
  const f6 = useFitted(`/assets/food/${FRUIT[6].url}.glb`, R * 2.8), f7 = useFitted(`/assets/food/${FRUIT[7].url}.glb`, R * 1.7), f8 = useFitted(`/assets/food/${FRUIT[8].url}.glb`, R * 2.6);
  const bomb = useFitted('/assets/kit/bomb.glb', R * 2.1), star = useFitted('/assets/kit/star.glb', R * 1.8);

  const pieces = useMemo<Piece[]>(() => {
    const fruit = [f0, f1, f2, f3, f4, f5, f6, f7, f8];
    return Array.from({ length: POOL }, (_, i) => {
      const kind: Kind = i % 6 === 4 ? 'bomb' : i % 6 === 5 ? 'star' : 'fruit', type = i % FRUIT.length;
      const whole = (kind === 'bomb' ? bomb : kind === 'star' ? star : fruit[type]).clone();
      // Each half is the whole model again, with its own material clipped by its own plane.
      const halves = kind !== 'fruit' ? [] : [0, 1].map(() => {
        const obj = fruit[type].clone(), plane = new THREE.Plane();
        obj.traverse((o) => {
          const mesh = o as THREE.Mesh;
          if (!mesh.isMesh) return;
          const mat = (mesh.material as THREE.Material).clone();
          Object.assign(mat, { clippingPlanes: [plane], side: THREE.DoubleSide });
          mesh.material = mat;
        });
        const cap = new THREE.Mesh(capGeo, new THREE.MeshBasicMaterial({ color: FRUIT[type].flesh, side: THREE.DoubleSide }));
        cap.scale.setScalar(R * 2 * FRUIT[type].cap);
        return { obj, cap, plane, normal: new THREE.Vector3(), x: 0, y: 0, vx: 0, vy: 0 };
      });
      return { state: 'off', kind, zone: 0, x: 0, y: 0, vx: 0, vy: 0, spin: 0, age: 0, whole, halves, along: new THREE.Vector3(), base: new THREE.Quaternion() };
    });
  }, [f0, f1, f2, f3, f4, f5, f6, f7, f8, bomb, star]);

  const g = useRef({ spawnIn: [0, 0], scores: [0, 0], combo: [0, 0] }).current;
  const hands = useHands(n), bursts = useBursts();
  const tick = useRound(hud, ROUND, () => { music.stop(); onEnd(g.scores.slice(0, n)); });
  useLayoutEffect(() => { music.start('arcade'); return () => music.stop(); }, []);

  useFrame((_, rawDt) => {
    const dt = Math.min(rawDt, 0.05), t = tick(rawDt);
    if (t === null) return;
    const frenzy = t > ROUND - FRENZY;

    if (t >= 0)
      for (let z = 0; z < n; z++) {
        if ((g.spawnIn[z] -= dt) > 0) continue;
        g.spawnIn[z] = (frenzy ? 0.32 : 1 - 0.5 * (t / ROUND) + Math.random() * 0.3) / hard;
        const free = pieces.filter((p) => p.state === 'off' && !(frenzy && p.kind === 'bomb') && !(p.kind === 'bomb' && t < 6));
        const piece = free[Math.floor(Math.random() * free.length)];
        if (!piece) continue;
        const side = Math.random() * 2 - 1;
        Object.assign(piece, {
          state: 'whole', zone: z, spin: Math.random() * 4 - 2, x: zoneX(n, z) + side * zoneHalf(n) * 0.7, y: -H / 2 - R,
          vx: -side * (0.5 + Math.random()), vy: (piece.kind === 'star' ? 11.5 : 10) + Math.random() * 2,
        });
        piece.whole.rotation.set(Math.random() * 6, Math.random() * 6, 0);
      }

    for (const h of hands.update(dt)) {
      if (t < 0 || !h.on || h.speed < SLICE_SPEED) continue;
      for (const pc of pieces) {
        if (pc.state !== 'whole' || pc.zone !== h.p || segDist(pc.x, pc.y, h.px, h.py, h.x, h.y) > R * 1.2) continue;
        if (pc.kind === 'bomb') {
          pc.state = 'off';
          g.scores[h.p] = Math.max(0, g.scores[h.p] - 5); g.combo[h.p] = 0;
          sfx('impactPlate_heavy'); sfx('lowDown', { vol: 0.6 }); hud.flash('#ef4444'); hud.shake(1.5); bursts.burst(pc.x, pc.y, 0.5, '#ef4444', 50, 12);
          continue;
        }
        g.scores[h.p] += (pc.kind === 'star' ? 5 : 1) + Math.floor(++g.combo[h.p] / 5);
        hitSound(pc.kind === 'star' ? 'powerUp' : 'impactSoft_heavy', g.combo[h.p], 0.7);
        if (pc.kind === 'star') { pc.state = 'off'; bursts.burst(pc.x, pc.y, 0.5, '#fde047', 36, 9); continue; }
        // The cut: `along` is the swipe direction; each half keeps one side of the plane through the fruit's centre.
        const len = Math.hypot(h.x - h.px, h.y - h.py) || 1;
        pc.along.set((h.x - h.px) / len, (h.y - h.py) / len, 0);
        pc.base.copy(pc.whole.quaternion);
        pc.state = 'cut'; pc.age = 0;
        pc.halves.forEach((half, k) => {
          const s = k ? -1 : 1;
          half.normal.set(-pc.along.y * s, pc.along.x * s, 0);
          Object.assign(half, { x: pc.x, y: pc.y, vx: pc.vx + half.normal.x * 2.6, vy: pc.vy * 0.4 + half.normal.y * 2.6 + 2 });
        });
        bursts.burst(pc.x, pc.y, 0.5, (pc.halves[0].cap.material as THREE.MeshBasicMaterial).color.getStyle(), 14, 6);
      }
    }

    for (const pc of pieces) {
      pc.whole.visible = pc.state === 'whole';
      if (pc.state === 'whole') {
        pc.vy += GRAVITY * dt; pc.x += pc.vx * dt; pc.y += pc.vy * dt;
        pc.whole.position.set(pc.x, pc.y, 0);
        pc.whole.rotation.x += pc.spin * dt; pc.whole.rotation.y += pc.spin * dt * 0.7;
        if (pc.y < -H / 2 - 2 * R) { pc.state = 'off'; if (pc.kind !== 'bomb') g.combo[pc.zone] = 0; }
      }
      if (pc.state === 'cut' && (pc.age += dt) > 1.2) pc.state = 'off';
      // Each half swings open about the line of the cut, so its cut face rolls round to face the camera.
      const open = Math.min(1.25, pc.age * 3.2);
      pc.halves.forEach((half, k) => {
        half.obj.visible = half.cap.visible = pc.state === 'cut';
        if (pc.state !== 'cut') return;
        half.vy += GRAVITY * dt; half.x += half.vx * dt; half.y += half.vy * dt;
        half.obj.position.set(half.x, half.y, 0);
        half.obj.quaternion.copy(q.setFromAxisAngle(pc.along, k ? open : -open)).multiply(pc.base);
        v.copy(half.normal).multiplyScalar(Math.cos(open)).addScaledVector(Z, -Math.sin(open)); // the plane's normal, swung with the half
        half.plane.setFromNormalAndCoplanarPoint(v, half.obj.position);
        half.cap.position.copy(half.obj.position).addScaledVector(v, 0.01);
        half.cap.quaternion.setFromUnitVectors(Z, v.negate());
      });
    }
    bursts.update(dt);
    music.intensity(frenzy ? 1 : 0.3 + Math.max(g.combo[0], g.combo[1]) / 16);
    scoreHud(hud, n, g.scores);
    for (let p = 0; p < n; p++) hud.p('h', p, frenzy && g.combo[p] < 5 ? 'Frenzy!' : comboText(g.combo[p]));
  });

  return (
    <>
      {pieces.map((pc, i) => (
        <group key={i}>
          <primitive object={pc.whole} visible={false} />
          {pc.halves.map((half, k) => <group key={k}><primitive object={half.obj} visible={false} /><primitive object={half.cap} visible={false} /></group>)}
        </group>
      ))}
      {hands.nodes}
      {bursts.node}
      {n === 2 && <mesh><planeGeometry args={[0.04, H]} /><meshBasicMaterial color="#3f3f46" /></mesh>}
    </>
  );
}

export default (props: GameProps) => <Stage n={props.n}>{(hud) => <Scene {...props} hud={hud} />}</Stage>;
