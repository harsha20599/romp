// Slice — fruit-slicer. 1P owns the whole stage; 2P get a half each (compact footprint: hands are
// body-relative, so nobody needs to spread out). All per-frame state lives in refs — no setState in useFrame.
import { useMemo, useRef } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { players } from './pose.ts';

const W = 16, H = 9, R = 0.7, GRAVITY = -9, ROUND = 60, COUNTDOWN = 3;
const SLICE_SPEED = 6; // stage units/s a hand must move to cut — tune on device
const POOL = 24, TRAIL = 10;
const COLORS = ['#f43f5e', '#f59e0b', '#84cc16', '#22d3ee', '#a78bfa', '#fb923c'];
const HAND_COLORS = ['#818cf8', '#34d399'];

const fruitGeo = new THREE.IcosahedronGeometry(R, 1);
const handGeo = new THREE.SphereGeometry(0.18, 12, 8);

type Fruit = { live: boolean; pop: number; bomb: boolean; zone: number; x: number; y: number; vx: number; vy: number; spin: number };
export type SliceProps = { n: number; onEnd: (scores: number[]) => void };

let audio: AudioContext | undefined;
function blip(freq: number, dur = 0.08) {
  audio ??= new AudioContext();
  const o = audio.createOscillator(), g = audio.createGain();
  o.frequency.value = freq;
  g.gain.setValueAtTime(0.15, audio.currentTime);
  g.gain.exponentialRampToValueAtTime(0.001, audio.currentTime + dur);
  o.connect(g).connect(audio.destination);
  o.start();
  o.stop(audio.currentTime + dur);
}

// Distance from point p to segment a→b.
function segDist(px: number, py: number, ax: number, ay: number, bx: number, by: number) {
  const dx = bx - ax, dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy || 1)));
  return Math.hypot(px - ax - t * dx, py - ay - t * dy);
}

function Scene({ n, onEnd, hud }: SliceProps & { hud: React.RefObject<(HTMLElement | null)[]> }) {
  const fruits = useMemo<Fruit[]>(
    () => Array.from({ length: POOL }, () => ({ live: false, pop: 0, bomb: false, zone: 0, x: 0, y: 0, vx: 0, vy: 0, spin: 0 })),
    [],
  );
  const meshes = useRef<(THREE.Mesh<THREE.BufferGeometry, THREE.MeshLambertMaterial> | null)[]>([]);
  const handMeshes = useRef<(THREE.Mesh | null)[]>([]);
  // One trail per hand. ponytail: 1px GL lines — swap for a mesh ribbon (drei <Trail>) if it reads weak on the TV.
  const trails = useMemo(
    () =>
      Array.from({ length: n * 2 }, (_, i) => {
        const geo = new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(new Float32Array(TRAIL * 3), 3));
        const line = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: HAND_COLORS[i >> 1] }));
        line.frustumCulled = false; // positions are rewritten every frame; the cached bounds would be stale
        return line;
      }),
    [n],
  );
  const s = useRef({ t: -COUNTDOWN, spawnIn: [0, 0], scores: [0, 0], combo: [0, 0], last: trails.map(() => ({ x: 0, y: 0, ok: false })), done: false, shown: '' });

  const zoneHalf = W / 2 / n;
  const zoneX = (z: number) => (n === 1 ? 0 : (z - 0.5) * (W / 2));

  useFrame((_, rawDt) => {
    const g = s.current, dt = Math.min(rawDt, 0.05);
    if (g.done) return;
    g.t += dt;
    const playing = g.t >= 0;

    if (playing)
      for (let z = 0; z < n; z++) {
        if ((g.spawnIn[z] -= dt) > 0) continue;
        g.spawnIn[z] = 1 - 0.55 * (g.t / ROUND) + Math.random() * 0.3; // ramps from ~1.1s to ~0.6s
        const f = fruits.find((f) => !f.live && f.pop <= 0);
        if (!f) continue;
        const side = Math.random() * 2 - 1;
        Object.assign(f, {
          live: true, zone: z, bomb: Math.random() < 0.12, spin: Math.random() * 4 - 2,
          x: zoneX(z) + side * zoneHalf * 0.7, y: -H / 2 - R,
          vx: -side * (0.5 + Math.random()), vy: 10 + Math.random() * 2,
        });
      }

    // Hands: move cursors, push trails, cut fruit.
    for (let i = 0; i < n * 2; i++) {
      const p = i >> 1, hand = players[p].hands[i & 1], mesh = handMeshes.current[i], last = g.last[i], trail = trails[i];
      const on = players[p].present && hand.seen;
      if (mesh) mesh.visible = trail.visible = on;
      if (!on) { last.ok = false; continue; }
      const x = zoneX(p) + hand.x * zoneHalf, y = (hand.y * H) / 2;
      mesh?.position.set(x, y, 1);
      const pos = trail.geometry.attributes.position as THREE.BufferAttribute, a = pos.array as Float32Array;
      if (last.ok) a.copyWithin(3, 0, (TRAIL - 1) * 3);
      else for (let k = 0; k < TRAIL; k++) a.set([x, y, 1], k * 3);
      a.set([x, y, 1], 0);
      pos.needsUpdate = true;

      if (playing && last.ok && Math.hypot(x - last.x, y - last.y) / dt > SLICE_SPEED)
        for (const f of fruits) {
          if (!f.live || f.zone !== p || segDist(f.x, f.y, last.x, last.y, x, y) > R * 1.15) continue;
          f.live = false;
          f.pop = 0.25;
          if (f.bomb) { g.scores[p] = Math.max(0, g.scores[p] - 5); g.combo[p] = 0; blip(90, 0.3); }
          else { g.scores[p] += 1 + Math.floor(++g.combo[p] / 5); blip(500 + 40 * Math.min(g.combo[p], 12)); }
        }
      Object.assign(last, { x, y, ok: true });
    }

    // Fruit: fly, pop, fall out.
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

    // HUD — DOM text via refs, written only when it changes.
    const clock = playing ? String(Math.ceil(ROUND - g.t)) : String(Math.ceil(-g.t));
    const text = [clock, ...[0, 1].map((p) => (players[p].present ? `${g.scores[p]}` : 'Step into view'))].join('|');
    if (text !== g.shown) {
      g.shown = text;
      text.split('|').forEach((v, k) => hud.current[k] && (hud.current[k]!.textContent = v));
    }

    if (g.t >= ROUND) { g.done = true; blip(880, 0.4); onEnd(g.scores.slice(0, n)); }
  });

  return (
    <>
      <ambientLight intensity={1.2} />
      <directionalLight position={[3, 5, 8]} intensity={2} />
      {fruits.map((_, i) => (
        <mesh key={i} ref={(m) => void (meshes.current[i] = m as never)} geometry={fruitGeo} visible={false}>
          <meshLambertMaterial flatShading transparent />
        </mesh>
      ))}
      {trails.map((line, i) => (
        <group key={i}>
          <primitive object={line} />
          <mesh ref={(m) => void (handMeshes.current[i] = m)} geometry={handGeo} visible={false}>
            <meshBasicMaterial color={HAND_COLORS[i >> 1]} />
          </mesh>
        </group>
      ))}
      {n === 2 && (
        <mesh>
          <planeGeometry args={[0.04, H]} />
          <meshBasicMaterial color="#3f3f46" />
        </mesh>
      )}
    </>
  );
}

export default function Slice(props: SliceProps) {
  const hud = useRef<(HTMLElement | null)[]>([]);
  const set = (k: number) => (el: HTMLElement | null) => void (hud.current[k] = el);
  return (
    <div className="stage">
      {/* Fixed 16:9 stage, orthographic: 1 unit = 1/16 of the width on any display. */}
      <Canvas orthographic camera={{ zoom: 1, position: [0, 0, 10], left: -W / 2, right: W / 2, top: H / 2, bottom: -H / 2 }}
        dpr={[1, 1.5]} gl={{ antialias: true, alpha: true, powerPreference: 'high-performance' }}>
        <Scene {...props} hud={hud} />
      </Canvas>
      <div className="hud clock" ref={set(0)} />
      <div className={props.n === 1 ? 'hud score solo' : 'hud score p1'} ref={set(1)} />
      {props.n === 2 && <div className="hud score p2" ref={set(2)} />}
    </div>
  );
}
