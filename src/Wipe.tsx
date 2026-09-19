// Wipe — the screen is filthy; scrub it clean with both hands. Grime creeps back, faster every layer.
// Clear your whole side for a bonus and a fresh, tougher layer. Reach is body-relative, so it is compact.
import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { H, Stage, blip, scoreHud, useBursts, useHands, useRound, type GameProps, type Hud } from './stage.tsx';

const ROUND = 60, COLS = 16, ROWS = 8, SCRUB = 1.15; // SCRUB = radius a hand cleans, in tiles
const LAYERS = ['#78716c', '#57534e', '#7c2d12', '#365314', '#1e3a8a'];
const tileGeo = new THREE.PlaneGeometry(0.96, 0.96), tmp = new THREE.Object3D(), tint = new THREE.Color();

function Scene({ n, onEnd, hud }: GameProps & { hud: Hud }) {
  const tiles = useMemo(() => Array.from({ length: COLS * ROWS }, (_, i) => {
    const x = (i % COLS) - COLS / 2 + 0.5, y = Math.floor(i / COLS) - ROWS / 2 + 0.5 - 0.4;
    return { x, y, zone: n === 2 && x > 0 ? 1 : 0, dirt: 1, cleanFor: 0 };
  }), [n]);
  const mesh = useMemo(() => {
    const m = new THREE.InstancedMesh(tileGeo, new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.92 }), COLS * ROWS);
    m.frustumCulled = false;
    return m;
  }, []);
  const g = useRef({ scores: [0, 0], layer: [0, 0], said: [0, 0], painted: [-1, -1] }).current;
  const hands = useHands(n), bursts = useBursts();
  const tick = useRound(hud, ROUND, () => onEnd(g.scores.slice(0, n)));

  useFrame((_, rawDt) => {
    const dt = Math.min(rawDt, 0.05), t = tick(rawDt);
    if (t === null) return;
    const at = hands.update(dt), left = [0, 0], total = [0, 0];

    tiles.forEach((tile, i) => {
      const z = tile.zone;
      if (t >= 0 && tile.dirt > 0.5 && at.some((h) => h.on && h.p === z && Math.hypot(h.x - tile.x, h.y - tile.y) < SCRUB)) {
        tile.dirt = 0; tile.cleanFor = 0; g.scores[z]++;
        if (Math.random() < 0.3) bursts.burst(tile.x, tile.y, 0.5, '#e0f2fe', 4, 3);
        if (Math.random() < 0.2) blip(1200 + Math.random() * 600, 0.03, 'sine', undefined, 0.05);
      } else if (tile.dirt < 1 && (tile.cleanFor += dt) > 4 - Math.min(3, g.layer[z] * 0.6)) tile.dirt = Math.min(1, tile.dirt + dt * 0.8); // grime creeps back
      total[z]++;
      if (tile.dirt > 0.5) left[z]++;
      tmp.position.set(tile.x, tile.y, 0);
      tmp.scale.setScalar(tile.dirt);
      tmp.updateMatrix();
      mesh.setMatrixAt(i, tmp.matrix);
      if (g.painted[z] !== g.layer[z]) mesh.setColorAt(i, tint.set(LAYERS[g.layer[z] % LAYERS.length]));
    });
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    g.painted = [...g.layer];

    for (let p = 0; p < n; p++) {
      if (t >= 0 && left[p] <= total[p] * 0.04) { // spotless: bonus, and a tougher layer drops in
        g.scores[p] += 20; g.layer[p]++; g.said[p] = t + 1.2;
        tiles.forEach((tile) => tile.zone === p && ((tile.dirt = 1), (tile.cleanFor = 0)));
        blip(990, 0.3, 'triangle'); hud.flash('#e0f2fe');
      }
      hud.p('h', p, t < 0 ? 'Scrub it clean' : g.said[p] > t ? 'Sparkling! +20' : `${Math.round(100 - (100 * left[p]) / total[p])}% clean`);
    }
    bursts.update(dt);
    scoreHud(hud, n, g.scores);
  });

  return (
    <>
      <primitive object={mesh} />
      {hands.nodes}
      {bursts.node}
      {n === 2 && <mesh position-z={0.5}><planeGeometry args={[0.06, H]} /><meshBasicMaterial color="#fafafa" /></mesh>}
    </>
  );
}

export default (props: GameProps) => <Stage n={props.n}>{(hud) => <Scene {...props} hud={hud} />}</Stage>;
