// Shape Up — hole-in-the-wall. A pose grows toward you; match it with your whole body before it lands.
// Poses use the full wingspan, so this one is solo or take-turns only (PLAN §3: "wide" footprint).
import { useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { players, poseMatch as match, sim } from './pose.ts';
import { PLAYER_COLORS, Stage, blip, useRound, type GameProps, type Hud } from './stage.tsx';

const D = Math.PI / 180, PER_POSE = 5, SHOW = 1; // seconds per pose, of which the last one shows the verdict
const LEGS = [-95, -90, -85, -90];
// Limb angles in degrees, screen space (0 = pointing right, 90 = up), in pose.ts LIMBS order:
// screen-left upper arm, forearm, screen-right upper arm, forearm, then thigh, shin for each leg.
const POSES: number[][] = [
  [180, 180, 0, 0, ...LEGS], // T
  [135, 135, 45, 45, ...LEGS], // Y
  [100, 95, 80, 85, ...LEGS], // both up
  [180, 90, 0, 90, ...LEGS], // goalposts
  [100, 95, 0, 0, ...LEGS], // left up, right out
  [180, 180, 80, 85, ...LEGS], // left out, right up
  [150, 150, 30, 30, -120, -115, -60, -65], // star
  [-135, -45, -45, -135, ...LEGS], // hands on hips
  [180, 180, 0, 0, -150, -90, -30, -90], // wide squat
  [135, 135, -45, -45, ...LEGS], // diagonal
  [100, 95, 80, 85, -135, -130, -85, -90], // up, left leg out
].map((pose) => pose.map((deg) => deg * D));
const STAND = [-100, -95, -80, -85, ...LEGS].map((deg) => deg * D);
const ROUND = 8 * PER_POSE;

// A stick figure built from the same 8 angles, so target and player are directly comparable on screen.
const limbGeo = new THREE.BoxGeometry(1, 0.24, 0.1).translate(0.5, 0, 0); // pivots at its near end
const JOINTS = [[-0.75, 2], [0, 0], [0.75, 2], [0, 0], [-0.4, 0], [0, 0], [0.4, 0], [0, 0]]; // even slots chain from the limb before
const LENGTHS = [1.1, 1, 1.1, 1, 1.5, 1.4, 1.5, 1.4];
function poseFigure(limbs: (THREE.Mesh | null)[], angles: number[]) {
  let x = 0, y = 0;
  angles.forEach((a, i) => {
    if (i % 2 === 0) [x, y] = JOINTS[i];
    limbs[i]?.position.set(x, y, 0);
    limbs[i]?.rotation.set(0, 0, a);
    x += Math.cos(a) * LENGTHS[i];
    y += Math.sin(a) * LENGTHS[i];
  });
}
function Figure({ limbs, color, opacity }: { limbs: React.RefObject<(THREE.Mesh | null)[]>; color: string; opacity: number }) {
  const mat = <meshBasicMaterial color={color} transparent opacity={opacity} />;
  return (
    <>
      {LENGTHS.map((len, i) => <mesh key={i} ref={(m) => void (limbs.current[i] = m)} geometry={limbGeo} scale-x={len}>{mat}</mesh>)}
      <mesh position={[0, 1, 0]}><planeGeometry args={[1.5, 2.2]} />{mat}</mesh>
      <mesh position={[0, 2.75, 0]}><circleGeometry args={[0.42, 24]} />{mat}</mesh>
    </>
  );
}

function Scene({ onEnd, hud }: GameProps & { hud: Hud }) {
  const target = useRef<THREE.Group>(null), targetLimbs = useRef<(THREE.Mesh | null)[]>([]), myLimbs = useRef<(THREE.Mesh | null)[]>([]);
  const g = useRef({ order: [...POSES].sort(() => Math.random() - 0.5), score: 0, best: 0, judged: -1 }).current;
  const tick = useRound(hud, ROUND, () => onEnd([g.score]));

  useFrame((_, dt) => {
    const t = tick(dt);
    if (t === null) return;
    const i = Math.floor(Math.max(0, t) / PER_POSE), into = Math.max(0, t) - i * PER_POSE, pose = g.order[i % g.order.length];
    const flying = into < PER_POSE - SHOW;
    // ponytail: ?sim has no skeleton, so the sim player simply copies the target while the right hand is raised.
    const mine = players[0].angles ?? (sim && players[0].hands[1].y > 0.5 ? pose : STAND);

    poseFigure(targetLimbs.current, pose);
    poseFigure(myLimbs.current, mine);
    target.current?.scale.setScalar(flying ? 0.3 + 0.7 * (into / (PER_POSE - SHOW)) ** 2 : 1);
    if (target.current) target.current.visible = t >= 0;

    if (t < 0) return hud('h0', 'Match the shape');
    if (flying) {
      if (into > PER_POSE - SHOW - 0.6) g.best = Math.max(g.best, match(mine, pose)); // best moment of the last 0.6s counts
      hud('h0', '');
    } else if (g.judged !== i) {
      g.judged = i;
      g.score += g.best;
      hud('h0', `${g.best}%`);
      blip(g.best >= 60 ? 660 : 140, 0.2);
      g.best = 0;
    }
    hud('s0', players[0].present ? String(g.score) : 'Step into view');
  });

  return (
    <group position-y={-0.9} scale={0.95}>
      <group ref={target} position-z={-1}><Figure limbs={targetLimbs} color="#fbbf24" opacity={0.55} /></group>
      <Figure limbs={myLimbs} color={PLAYER_COLORS[0]} opacity={0.9} />
    </group>
  );
}

export default (props: GameProps) => <Stage n={1}>{(hud) => <Scene {...props} hud={hud} />}</Stage>;
