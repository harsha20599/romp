// Rocket — every squat is a burn. Go deeper for a bigger kick; stop squatting and gravity wins.
// Score is the highest altitude you reach. One body-width of floor each, so it is compact.
import { useLayoutEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { players, tuning } from './pose.ts';
import { hardness } from './meta.ts';
import { H, PLAYER_COLORS, Stage, W, music, sfx, useBursts, useRound, zoneX, type GameProps, type Hud } from './stage.tsx';

const ROUND = 45, STARS = 90, GRAVITY = 5, DRAG = 0.35;
const starGeo = new THREE.CircleGeometry(0.05, 6), tmp = new THREE.Object3D();

function Scene({ n, stage, onEnd, hud }: GameProps & { hud: Hud }) {
  const hard = hardness(stage); // heavier gravity on higher stages
  useLayoutEffect(() => { music.start('calm', undefined, 0.5); return () => music.stop(); }, []);
  const rockets = useRef<(THREE.Group | null)[]>([]), grounds = useRef<(THREE.Mesh | null)[]>([]);
  const stars = useMemo(() => {
    const mesh = new THREE.InstancedMesh(starGeo, new THREE.MeshBasicMaterial({ color: '#e4e4e7' }), STARS);
    mesh.frustumCulled = false;
    return { mesh, at: Array.from({ length: STARS }, () => ({ x: (Math.random() - 0.5) * W, y: (Math.random() - 0.5) * H, depth: 0.3 + Math.random() * 0.7 })) };
  }, []);
  const g = useRef({ alt: [0, 0], vel: [0, 0], best: [0, 0], reps: [0, 0], down: [false, false], deepest: [0, 0] }).current;
  const bursts = useBursts();
  const tick = useRound(hud, ROUND, () => onEnd(g.best.slice(0, n).map(Math.round)));

  useFrame((_, rawDt) => {
    const dt = Math.min(rawDt, 0.05), t = tick(rawDt);
    if (t === null) return;

    for (let p = 0; p < n; p++) {
      const pl = players[p], x = zoneX(n, p);
      // One rep = down past the crouch line, then back up to standing. Depth of the squat sets the size of the burn.
      if (pl.lift < tuning.crouch) { g.down[p] = true; g.deepest[p] = Math.min(g.deepest[p], pl.lift); }
      else if (g.down[p] && pl.lift > -tuning.standBand) {
        const depth = Math.min(1, (tuning.crouch - g.deepest[p]) / 0.6);
        g.down[p] = false; g.deepest[p] = 0;
        if (t >= 0) { g.vel[p] += 8 + 7 * depth; g.reps[p]++; sfx('laser', { vol: 0.5, rate: 0.5 + depth * 0.4 }); sfx('impactSoft_heavy', { vol: 0.6 }); bursts.burst(x, -2.6, 0.5, '#fb923c', 16 + 16 * depth, 6); }
      }
      g.vel[p] -= (GRAVITY * hard + DRAG * g.vel[p]) * dt;
      g.alt[p] = Math.max(0, g.alt[p] + g.vel[p] * dt);
      if (g.alt[p] === 0) g.vel[p] = Math.max(0, g.vel[p]);
      g.best[p] = Math.max(g.best[p], g.alt[p]);

      const r = rockets.current[p], ground = grounds.current[p];
      if (r) { r.visible = pl.present; r.position.set(x, -1.6 + Math.max(-0.6, Math.min(1.2, g.vel[p] * 0.08)), 0); r.rotation.z = Math.sin(t * 9) * 0.02 * Math.min(10, g.vel[p]); }
      if (ground) ground.position.set(x, -3.2 - g.alt[p] * 0.6, -0.5);
      if (g.vel[p] > 1 && Math.random() < 0.5) bursts.burst(x, -2.5, 0.2, '#fbbf24', 1, 2);
      hud.p('s', p, pl.present ? `${Math.round(g.alt[p])} m` : 'Step into view');
      hud.p('h', p, t < 0 ? 'Squat to launch' : g.down[p] ? 'Up!' : `${g.reps[p]} squats · best ${Math.round(g.best[p])} m`);
    }

    // Stars stream past at the speed of the faster rocket; nearer ones move more.
    const flow = Math.max(g.vel[0], n === 2 ? g.vel[1] : 0, 0.3);
    stars.at.forEach((s, i) => {
      s.y -= flow * s.depth * 0.25 * dt;
      if (s.y < -H / 2) { s.y += H; s.x = (Math.random() - 0.5) * W; }
      tmp.position.set(s.x, s.y, -1);
      tmp.scale.setScalar(s.depth * 1.6);
      tmp.updateMatrix();
      stars.mesh.setMatrixAt(i, tmp.matrix);
    });
    stars.mesh.instanceMatrix.needsUpdate = true;
    bursts.update(dt);
    music.intensity(0.3 + Math.max(g.vel[0], g.vel[1]) / 20);
  });

  return (
    <>
      <primitive object={stars.mesh} />
      {Array.from({ length: n }, (_, p) => (
        <group key={p}>
          <mesh ref={(m) => void (grounds.current[p] = m)}><planeGeometry args={[W / n - 0.4, 1.6]} /><meshBasicMaterial color="#3f3f46" /></mesh>
          <group ref={(r) => void (rockets.current[p] = r)}>
            <mesh position-y={0.2}><cylinderGeometry args={[0.38, 0.38, 1.5, 16]} /><meshLambertMaterial color="#e4e4e7" /></mesh>
            <mesh position-y={1.35}><coneGeometry args={[0.38, 0.8, 16]} /><meshLambertMaterial color={PLAYER_COLORS[p]} /></mesh>
            {[-1, 1].map((side) => (
              <mesh key={side} position={[side * 0.5, -0.35, 0]} rotation-z={side * 0.5}><boxGeometry args={[0.18, 0.7, 0.05]} /><meshLambertMaterial color={PLAYER_COLORS[p]} /></mesh>
            ))}
          </group>
        </group>
      ))}
      {bursts.node}
      {n === 2 && <mesh position-z={-0.4}><planeGeometry args={[0.04, H]} /><meshBasicMaterial color="#3f3f46" /></mesh>}
    </>
  );
}

export default (props: GameProps) => <Stage n={props.n}>{(hud) => <Scene {...props} hud={hud} />}</Stage>;
