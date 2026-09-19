// Smash — a tower of crates on a platform; knock every one of them off with your hands. Pure physics (Rapier):
// the crates are rigid bodies, your hands are kinematic colliders, and a fast swing adds a real shove.
// Clear the platform for a bonus and a taller tower. Hands are body-relative over your own tower: compact.
import { useLayoutEffect, useMemo, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { BallCollider, CuboidCollider, Physics, RigidBody, type RapierRigidBody } from '@react-three/rapier';
import { hardness } from './meta.ts';
import { Stage, hitSound, music, scoreHud, segDist, sfx, useBursts, useFitted, useHands, useRound, type GameProps, type Hud } from './stage.tsx';

const ROUND = 60, CRATES = 21, SIZE = 0.9, DECK = 0, SWING = 4; // SWING = hand speed (units/s) that counts as a hit rather than a nudge

function Scene({ n, stage, onEnd, hud }: GameProps & { hud: Hud }) {
  const camera = useThree((s) => s.camera);
  useLayoutEffect(() => camera.lookAt(0, 2, 0), [camera]);
  const hard = hardness(stage);
  const area = useMemo(() => ({ cx: (p: number) => (n === 1 ? 0 : (p - 0.5) * 7.4), hw: 3, hh: 2.8, cy: 2.4 }), [n]);
  const crate = useFitted('/assets/kit/crate.glb', SIZE), clones = useMemo(() => Array.from({ length: CRATES * n }, () => crate.clone()), [crate, n]);
  const bodies = useRef<(RapierRigidBody | null)[]>([]), fists = useRef<(RapierRigidBody | null)[]>([]);
  const g = useRef({ scores: [0, 0], combo: [0, 0], wave: [0, 0], live: clones.map(() => false), rebuildAt: [0.5, 0.5], said: [0, 0] }).current;
  const hands = useHands(n, area), bursts = useBursts();
  const tick = useRound(hud, ROUND, () => { music.stop(); onEnd(g.scores.slice(0, n)); });
  useLayoutEffect(() => { music.start('arcade'); return () => music.stop(); }, []);

  // A pyramid that grows a row with every wave: 3-2-1, then 4-3-2-1, up to 6 wide.
  const build = (p: number) => {
    const rows = Math.min(6, 3 + g.wave[p]);
    let k = 0;
    for (let row = 0; row < rows; row++)
      for (let col = 0; col < rows - row && k < CRATES; col++, k++) {
        const body = bodies.current[p * CRATES + k];
        if (!body) continue;
        g.live[p * CRATES + k] = true;
        body.setEnabled(true);
        body.setTranslation({ x: area.cx(p) + (col - (rows - row - 1) / 2) * (SIZE + 0.04), y: DECK + SIZE / 2 + row * SIZE + 0.02, z: 0 }, true);
        body.setRotation({ x: 0, y: 0, z: 0, w: 1 }, true);
        body.setLinvel({ x: 0, y: 0, z: 0 }, true);
        body.setAngvel({ x: 0, y: 0, z: 0 }, true);
      }
    sfx('impactWood_medium', { vol: 0.6 });
  };

  useFrame((_, rawDt) => {
    const dt = Math.min(rawDt, 0.05), t = tick(rawDt);
    if (t === null) return;

    hands.update(dt).forEach((h, i) => {
      fists.current[i]?.setNextKinematicTranslation({ x: h.on ? h.x : 0, y: h.on ? h.y : -40, z: 0 });
      if (!h.on || h.speed < SWING || t < 0) return;
      // A kinematic fist only pushes sideways. A real swing also drives the crate it touches back and up.
      for (let k = 0; k < CRATES; k++) {
        const j = h.p * CRATES + k, body = bodies.current[j];
        if (!body || !g.live[j]) continue;
        const c = body.translation();
        // Test the whole swing since last frame, not just where the hand is now — a fast arm covers a crate-width per frame.
        if (segDist(c.x, c.y, h.px, h.py, h.x, h.y) > SIZE * 0.9 || Math.abs(c.z) > 1) continue;
        const kick = (Math.min(h.speed, 16) * 0.2) / hard, len = Math.hypot(h.x - h.px, h.y - h.py) || 1;
        body.applyImpulse({ x: ((h.x - h.px) / len) * kick * 0.8, y: ((h.y - h.py) / len) * kick * 0.8 + kick * 0.3, z: -kick * 0.6 }, true);
        if (Math.random() < 0.3) sfx('impactWood_heavy', { vol: Math.min(1, h.speed / 12) });
      }
    });

    for (let p = 0; p < n; p++) {
      let standing = 0;
      for (let k = 0; k < CRATES; k++) {
        const j = p * CRATES + k, body = bodies.current[j];
        if (body && !g.live[j] && body.isEnabled()) body.setEnabled(false); // parked bodies must not fall forever
        if (!body || !g.live[j]) continue;
        const c = body.translation(), r = body.rotation();
        clones[j].position.set(c.x, c.y, c.z);
        clones[j].quaternion.set(r.x, r.y, r.z, r.w);
        if (c.y > DECK - 2.5) { standing++; continue; }
        g.live[j] = false; body.setEnabled(false); // off the platform: that is a point
        g.scores[p] += 1 + Math.floor(++g.combo[p] / 8);
        hitSound('impactWood_medium', g.combo[p], 0.6);
        bursts.burst(c.x, DECK - 1.5, c.z, '#b45309', 10, 6);
      }
      clones.slice(p * CRATES, (p + 1) * CRATES).forEach((c, k) => (c.visible = g.live[p * CRATES + k]));
      if (t >= 0 && standing === 0 && g.rebuildAt[p] === 0) { // cleared
        if (g.wave[p]++ || t > 1) { g.scores[p] += 10; g.said[p] = t + 1.3; sfx('confirmation'); hud.flash('#fde047'); }
        g.rebuildAt[p] = t + 0.8;
      }
      if (g.rebuildAt[p] && t >= g.rebuildAt[p]) { g.rebuildAt[p] = 0; g.combo[p] = 0; build(p); }
      hud.p('h', p, t < 0 ? 'Knock them all off' : g.said[p] > t ? 'Cleared! +10' : `Tower ${g.wave[p] + 1} · ${standing} left`);
    }
    bursts.update(dt);
    music.intensity(0.3 + Math.max(g.combo[0], g.combo[1]) / 14);
    scoreHud(hud, n, g.scores);
  });

  return (
    <>
      <Physics gravity={[0, -14, 0]}>
        {Array.from({ length: n }, (_, p) => (
          <RigidBody key={p} type="fixed" colliders={false}>
            <CuboidCollider args={[3.3, 0.25, 1.1]} position={[area.cx(p), DECK - 0.25, 0]} friction={0.9} />
          </RigidBody>
        ))}
        {clones.map((_, j) => (
          <RigidBody key={j} ref={(b) => void (bodies.current[j] = b)} colliders={false} position={[0, -30 - j * 2, 0]} angularDamping={0.3}>
            <CuboidCollider args={[SIZE / 2, SIZE / 2, SIZE / 2]} friction={0.7} restitution={0.15} density={hard} />
          </RigidBody>
        ))}
        {Array.from({ length: n * 2 }, (_, i) => (
          <RigidBody key={i} ref={(b) => void (fists.current[i] = b)} type="kinematicPosition" colliders={false} position={[0, -40, 0]}>
            <BallCollider args={[0.5]} />
          </RigidBody>
        ))}
      </Physics>
      {Array.from({ length: n }, (_, p) => (
        <mesh key={p} position={[area.cx(p), DECK - 0.25, 0]}><boxGeometry args={[6.6, 0.5, 2.2]} /><meshStandardMaterial color="#52525b" emissive="#4f46e5" emissiveIntensity={0.15} /></mesh>
      ))}
      {clones.map((c, j) => <primitive key={j} object={c} visible={false} />)}
      {hands.nodes}
      {bursts.node}
    </>
  );
}

export default (props: GameProps) => (
  <Stage n={props.n} camera={{ position: [0, 3, 8.2], fov: 50, near: 0.1, far: 100 }}>{(hud) => <Scene {...props} hud={hud} />}</Stage>
);
