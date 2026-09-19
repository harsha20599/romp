// Goalie — shots fly in from the far end; get a hand to the landing ring before the ball does.
// Hands are body-relative across your own goal, so together-play is two narrow goals side by side.
import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { PLAYER_COLORS, Stage, blip, comboText, scoreHud, useBursts, useHands, useRound, type GameProps, type Hud } from './stage.tsx';

const ROUND = 60, FAR = -45, REACH = 1.2, PER_ZONE = 6;
const ballGeo = new THREE.IcosahedronGeometry(0.55, 1), ringGeo = new THREE.RingGeometry(0.9, 1, 40), box = new THREE.BoxGeometry(1, 1, 1);

type Ball = { state: 'off' | 'in' | 'saved' | 'missed'; zone: number; u: number; dur: number; sx: number; tx: number; ty: number; gold: boolean; reached: boolean; x: number; y: number; z: number };

function Scene({ n, onEnd, hud }: GameProps & { hud: Hud }) {
  const goal = useMemo(() => ({ cx: (p: number) => (n === 1 ? 0 : (p - 0.5) * 6.8), hw: n === 1 ? 5.6 : 3, hh: 3.2, cy: 0.4 }), [n]);
  const balls = useMemo<Ball[]>(() => Array.from({ length: PER_ZONE * n }, (_, i) => ({ state: 'off', zone: i % n, u: 0, dur: 1, sx: 0, tx: 0, ty: 0, gold: false, reached: false, x: 0, y: 0, z: 0 })), [n]);
  const ballMeshes = useRef<(THREE.Mesh<THREE.BufferGeometry, THREE.MeshLambertMaterial> | null)[]>([]);
  const ringMeshes = useRef<(THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial> | null)[]>([]);
  const g = useRef({ spawnIn: [1, 1.4], scores: [0, 0], combo: [0, 0] }).current;
  const hands = useHands(n, goal), bursts = useBursts();
  const tick = useRound(hud, ROUND, () => onEnd(g.scores.slice(0, n)));

  useFrame((_, rawDt) => {
    const dt = Math.min(rawDt, 0.05), t = tick(rawDt);
    if (t === null) return;
    const ease = Math.max(0, t) / ROUND;

    if (t >= 0)
      for (let z = 0; z < n; z++) {
        if ((g.spawnIn[z] -= dt) > 0) continue;
        g.spawnIn[z] = 1.7 - 0.85 * ease + Math.random() * 0.3;
        const b = balls.find((b) => b.zone === z && b.state === 'off');
        if (!b) continue;
        Object.assign(b, {
          state: 'in', u: 0, gold: Math.random() < 0.15, reached: false, dur: 1.9 - 0.7 * ease,
          sx: goal.cx(z) + (Math.random() * 2 - 1) * 6,
          tx: goal.cx(z) + (Math.random() * 2 - 1) * goal.hw * 0.85, ty: goal.cy + (Math.random() * 2 - 1) * goal.hh * 0.8,
        });
        if (b.gold) b.dur *= 0.8;
      }

    const at = hands.update(dt);
    balls.forEach((b, i) => {
      const m = ballMeshes.current[i], ring = ringMeshes.current[i];
      if (!m || !ring) return;
      if (b.state === 'in') {
        b.u += dt / b.dur;
        b.x = b.sx + (b.tx - b.sx) * b.u; b.z = FAR * (1 - b.u); b.y = -1 + (b.ty + 1) * b.u + Math.sin(Math.PI * b.u) * 3;
        // A hand on the ring at any moment of the last stretch counts — you block, you don't have to time a swat.
        if (b.u > 0.82 && at.some((h) => h.on && h.p === b.zone && Math.hypot(h.x - b.tx, h.y - b.ty) < REACH)) b.reached = true;
        if (b.u >= 1) {
          const p = b.zone;
          if (b.reached) {
            b.state = 'saved';
            g.scores[p] += (b.gold ? 3 : 1) + Math.floor(++g.combo[p] / 5);
            blip((b.gold ? 900 : 440) + 40 * Math.min(g.combo[p], 12), 0.1, 'triangle');
            bursts.burst(b.tx, b.ty, 0.5, b.gold ? '#fde047' : PLAYER_COLORS[p], b.gold ? 28 : 14, 7);
          } else { b.state = 'missed'; g.combo[p] = 0; blip(90, 0.3); hud.flash('#ef4444'); }
        }
      } else if (b.state !== 'off') {
        const back = b.state === 'saved' ? -1 : 1; // punched back up-field, or past you into the net
        b.z += back * 30 * dt; b.y += (b.state === 'saved' ? 6 : -2) * dt;
        if (b.z < -25 || b.z > 8) b.state = 'off';
      }
      m.visible = b.state !== 'off';
      m.position.set(b.x, b.y, b.z);
      m.rotation.x += dt * 6;
      m.material.color.set(b.gold ? '#fde047' : '#fafafa');
      m.material.emissive.set(b.gold ? '#a16207' : '#000000');
      ring.visible = b.state === 'in';
      ring.position.set(b.tx, b.ty, 0);
      ring.scale.setScalar(REACH * (1 + 2 * (1 - b.u))); // closes to the size of your reach as the ball arrives
      ring.material.opacity = 0.25 + 0.75 * b.u;
      ring.material.color.set(b.reached ? '#4ade80' : b.gold ? '#fde047' : '#fafafa');
    });
    bursts.update(dt);
    scoreHud(hud, n, g.scores);
    for (let p = 0; p < n; p++) hud.p('h', p, comboText(g.combo[p]));
  });

  return (
    <>
      <fog attach="fog" args={['#09090b', 20, 50]} />
      <mesh position={[0, -3.4, -20]} rotation-x={-Math.PI / 2}><planeGeometry args={[40, 60]} /><meshBasicMaterial color="#14532d" transparent opacity={0.6} /></mesh>
      {Array.from({ length: n }, (_, p) => (
        <group key={p} position-x={goal.cx(p)}>
          {[[-goal.hw - 0.3, goal.cy, 0.25, goal.hh * 2 + 0.6], [goal.hw + 0.3, goal.cy, 0.25, goal.hh * 2 + 0.6], [0, goal.cy + goal.hh + 0.4, goal.hw * 2 + 0.85, 0.25]].map(([x, y, w, h], k) => (
            <mesh key={k} geometry={box} position={[x, y, 0]} scale={[w, h, 0.25]}><meshBasicMaterial color="#e4e4e7" /></mesh>
          ))}
        </group>
      ))}
      {balls.map((_, i) => (
        <group key={i}>
          <mesh ref={(m) => void (ballMeshes.current[i] = m as never)} geometry={ballGeo} visible={false}><meshLambertMaterial flatShading /></mesh>
          <mesh ref={(m) => void (ringMeshes.current[i] = m as never)} geometry={ringGeo} visible={false}><meshBasicMaterial transparent /></mesh>
        </group>
      ))}
      {hands.nodes}
      {bursts.node}
    </>
  );
}

export default (props: GameProps) => (
  <Stage n={props.n} camera={{ position: [0, 0.4, 9.5], fov: 50, near: 0.1, far: 120 }}>{(hud) => <Scene {...props} hud={hud} />}</Stage>
);
