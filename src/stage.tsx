// What every game shares: the 16:9 stage + HUD, the round clock, sound, and the players' hands.
// R3F rules kept here: nothing per-frame goes through React state; HUD is DOM text written via refs.
import { useMemo, useRef, type ReactNode } from 'react';
import { Canvas, type CameraProps } from '@react-three/fiber';
import * as THREE from 'three';
import { players } from './pose.ts';

export const W = 16, H = 9, COUNTDOWN = 3;
export const PLAYER_COLORS = ['#818cf8', '#34d399'];
export type GameProps = { n: number; onEnd: (scores: number[]) => void };
export type Hud = (key: 'clock' | 's0' | 's1' | 'h0' | 'h1', text: string) => void;

// A player's zone on the orthographic stage: the whole width solo, a half each together.
export const zoneHalf = (n: number) => W / 2 / n;
export const zoneX = (n: number, p: number) => (n === 1 ? 0 : (p - 0.5) * (W / 2));

let ctx: AudioContext | undefined;
export const audio = () => (ctx ??= new AudioContext());
export function blip(freq: number, dur = 0.08, type: OscillatorType = 'sine', at = audio().currentTime, vol = 0.15) {
  const o = audio().createOscillator(), g = audio().createGain();
  o.type = type;
  o.frequency.value = freq;
  g.gain.setValueAtTime(vol, at);
  g.gain.exponentialRampToValueAtTime(0.001, at + dur);
  o.connect(g).connect(audio().destination);
  o.start(at);
  o.stop(at + dur);
}

export function Stage({ n, camera, children }: { n: number; camera?: CameraProps; children: (hud: Hud) => ReactNode }) {
  const els = useRef<Record<string, HTMLElement | null>>({}), shown = useRef<Record<string, string>>({});
  const hud: Hud = (key, text) => {
    if (shown.current[key] === text || !els.current[key]) return;
    els.current[key]!.textContent = shown.current[key] = text;
  };
  const el = (key: string, className: string) => <div className={`hud ${className}`} ref={(e) => void (els.current[key] = e)} />;
  return (
    <div className="stage">
      {/* Default camera: orthographic, 1 unit = 1/16 of the stage width on any display. */}
      <Canvas orthographic={!camera} dpr={[1, 1.5]} gl={{ antialias: true, alpha: true, powerPreference: 'high-performance' }}
        camera={camera ?? { zoom: 1, position: [0, 0, 10], left: -W / 2, right: W / 2, top: H / 2, bottom: -H / 2 }}>
        <ambientLight intensity={1.2} />
        <directionalLight position={[3, 5, 8]} intensity={2} />
        {children(hud)}
      </Canvas>
      {el('clock', 'clock')}
      {el('s0', n === 1 ? 'score solo' : 'score p1')}{el('h0', n === 1 ? 'hint solo' : 'hint p1')}
      {n === 2 && el('s1', 'score p2')}{n === 2 && el('h1', 'hint p2')}
    </div>
  );
}

// Call the returned tick(dt) once per frame: seconds into the round (negative during the countdown), or null once over.
export function useRound(hud: Hud, length: number, finish: () => void) {
  const r = useRef({ t: -COUNTDOWN, done: false });
  return (dt: number) => {
    const g = r.current;
    if (g.done) return null;
    g.t += Math.min(dt, 0.05);
    hud('clock', String(Math.ceil(g.t < 0 ? -g.t : length - g.t)));
    if (g.t < length) return g.t;
    g.done = true;
    blip(880, 0.4);
    finish();
    return null;
  };
}

export const scoreHud = (hud: Hud, n: number, scores: number[]) => {
  for (let p = 0; p < n; p++) hud(`s${p}` as 's0', players[p].present ? String(scores[p]) : 'Step into view');
};

// Hands on the stage: a cursor and a tapering ribbon each. `update(dt)` moves them and returns where they are.
const TRAIL = 12;
const cursorGeo = new THREE.SphereGeometry(0.18, 12, 8);
export type StageHand = { p: number; x: number; y: number; px: number; py: number; speed: number; on: boolean };

export function useHands(n: number) {
  const hands = useMemo(
    () =>
      Array.from({ length: n * 2 }, (_, i) => {
        const geo = new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(new Float32Array(TRAIL * 6), 3));
        geo.setIndex(Array.from({ length: TRAIL - 1 }, (_, k) => [2 * k, 2 * k + 1, 2 * k + 2, 2 * k + 1, 2 * k + 3, 2 * k + 2]).flat());
        const color = PLAYER_COLORS[i >> 1];
        const ribbon = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.7, side: THREE.DoubleSide }));
        const cursor = new THREE.Mesh(cursorGeo, new THREE.MeshBasicMaterial({ color }));
        ribbon.frustumCulled = false; // rewritten every frame; cached bounds would be stale
        return { ribbon, cursor, pts: new Float32Array(TRAIL * 2), state: { p: i >> 1, x: 0, y: 0, px: 0, py: 0, speed: 0, on: false } as StageHand };
      }),
    [n],
  );
  const update = (dt: number) =>
    hands.map(({ ribbon, cursor, pts, state: s }, i) => {
      const hand = players[s.p].hands[i & 1], was = s.on;
      s.on = ribbon.visible = cursor.visible = players[s.p].present && hand.seen;
      if (!s.on) return s;
      s.px = s.x;
      s.py = s.y;
      s.x = zoneX(n, s.p) + hand.x * zoneHalf(n);
      s.y = (hand.y * H) / 2;
      if (!was) { s.px = s.x; s.py = s.y; }
      s.speed = was ? Math.hypot(s.x - s.px, s.y - s.py) / Math.max(dt, 1e-3) : 0;
      cursor.position.set(s.x, s.y, 1);
      if (was) pts.copyWithin(2, 0, (TRAIL - 1) * 2);
      else for (let k = 0; k < TRAIL; k++) pts.set([s.x, s.y], k * 2);
      pts.set([s.x, s.y], 0);
      const pos = ribbon.geometry.attributes.position as THREE.BufferAttribute;
      for (let k = 0; k < TRAIL; k++) {
        const a = Math.max(k - 1, 0) * 2, b = Math.min(k + 1, TRAIL - 1) * 2;
        const dx = pts[b] - pts[a], dy = pts[b + 1] - pts[a + 1], len = Math.hypot(dx, dy) || 1, w = 0.16 * (1 - k / TRAIL);
        pos.setXYZ(2 * k, pts[2 * k] - (dy / len) * w, pts[2 * k + 1] + (dx / len) * w, 0.9);
        pos.setXYZ(2 * k + 1, pts[2 * k] + (dy / len) * w, pts[2 * k + 1] - (dx / len) * w, 0.9);
      }
      pos.needsUpdate = true;
      return s;
    });
  const nodes = hands.map((h, i) => <group key={i}><primitive object={h.ribbon} /><primitive object={h.cursor} /></group>);
  return { update, nodes };
}

// Distance from point p to segment a→b — "did this swing pass through that thing".
export function segDist(px: number, py: number, ax: number, ay: number, bx: number, by: number) {
  const dx = bx - ax, dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy || 1)));
  return Math.hypot(px - ax - t * dx, py - ay - t * dy);
}
