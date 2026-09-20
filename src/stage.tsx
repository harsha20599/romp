// What every game shares: the 16:9 stage + HUD, the round clock, sound, and the players' hands.
// R3F rules kept here: nothing per-frame goes through React state; HUD is DOM text written via refs.
import { Suspense, createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Canvas, useFrame, useThree, type CameraProps, type RootState } from '@react-three/fiber';
import { PerformanceMonitor, useGLTF } from '@react-three/drei';
import { Bloom, EffectComposer } from '@react-three/postprocessing';
import * as THREE from 'three';
import { players, predict, sim, track, tuning } from './pose.ts';
import { blip, say, sfx, whoosh } from './audio.ts';
export { audio, blip, jingle, music, say, sfx, whoosh } from './audio.ts';

export const W = 16, H = 9, COUNTDOWN = 3;
export const PLAYER_COLORS = ['#818cf8', '#34d399'];
// `stage` is the difficulty stage (1–5); games scale themselves with hardness(stage) from meta.ts.
export type GameProps = { n: number; stage: number; onEnd: (scores: number[]) => void };
// Bloom is the one effect that costs real GPU time next to the pose model; the home screen can switch it off.
export const effects = { on: (() => { try { return localStorage.getItem('romp.fx') !== 'off'; } catch { return true; } })() };
type HudKey = 'clock' | 'big' | 's0' | 's1' | 'h0' | 'h1';
export type Hud = ((key: HudKey, text: string) => void) & { flash: (color: string) => void; shake: (amount?: number) => void; p: (kind: 's' | 'h', p: number, text: string) => void };

// The shell's hook into a running game: a tap or click anywhere on the stage asks to pause, and while paused the
// frame loop stops (so every game's clock stops with it). Context, so no game has to know any of this exists.
export const Shell = createContext({ paused: false, pause: () => {} });

// How long ago the player actually did what the game is only now seeing: measured frame-to-tracker age, plus the
// measured delay the page cannot see (camera pipeline + screen). Timing games judge against the past by this much.
export const inputLag = () => (sim ? 0 : Math.max(0.06, Math.min(0.4, track.lag / 1000 + tuning.unseen)));

// Hit-stop: on a big impact the game's clock all but stops for a few frames. It reads as weight, and it puts the
// feedback exactly where the eye is. Games that want it run their loop through useTick instead of useFrame.
const slow = { until: 0, k: 1 };
export const hitStop = (ms = 70, k = 0.06) => { slow.until = performance.now() + ms; slow.k = k; };
export const useTick = (fn: (state: RootState, dt: number) => void) => useFrame((state, dt) => fn(state, performance.now() < slow.until ? dt * slow.k : dt));

// A player's zone on the orthographic stage: the whole width solo, a half each together.
export const zoneHalf = (n: number) => W / 2 / n;
export const zoneX = (n: number, p: number) => (n === 1 ? 0 : (p - 0.5) * (W / 2));

// Everything a round will ever draw is compiled and uploaded before "Go". Pooled things start hidden, and three.js
// only builds a shader / uploads a mesh or texture the first time it is actually drawn — which used to be mid-round,
// as a dropped frame the first time a bomb or a power-up appeared. So: one throwaway render with everything forced
// visible, into a 1px offscreen target (the player never sees it), then a compile pass for the on-screen variant.
function Warm() {
  const { gl, scene, camera } = useThree();
  useEffect(() => {
    const hidden: THREE.Object3D[] = [], culled: THREE.Object3D[] = [], target = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType });
    scene.traverse((o) => { if (!o.visible) hidden.push(o); if (o.frustumCulled) culled.push(o); o.visible = true; o.frustumCulled = false; });
    gl.setRenderTarget(target);
    gl.render(scene, camera);
    gl.setRenderTarget(null);
    for (const o of hidden) o.visible = false;
    for (const o of culled) o.frustumCulled = true;
    gl.compile(scene, camera);
    target.dispose();
    pace.programs = gl.info.programs?.length ?? 0;
  }, [gl, scene, camera]);
  return null;
}

// Frame pacing, measured where it matters — on the device, during a real round. Read out by the shell after each game.
export const pace = { dts: [] as number[], programs: 0, late: 0 };
function Pace() {
  const gl = useThree((s) => s.gl);
  useFrame(({ clock }, dt) => { if (clock.elapsedTime > 2 && pace.dts.length < 30000) pace.dts.push(dt * 1000); // the first 2s are the countdown: loading and warm-up live there on purpose
    pace.late = (gl.info.programs?.length ?? 0) - pace.programs; });
  return null;
}
export function paceSummary() {
  const d = pace.dts.sort((a, b) => a - b), at = (q: number) => +(d[Math.floor((d.length - 1) * q)] ?? 0).toFixed(1);
  const out = { frames: d.length, p50: at(0.5), p95: at(0.95), p99: at(0.99), worst: at(1), over34ms: d.filter((v) => v > 34).length, shadersBuiltMidRound: pace.late };
  pace.dts = [];
  return out;
}

export function Stage({ n, camera, children }: { n: number; camera?: CameraProps; children: (hud: Hud) => ReactNode }) {
  const els = useRef<Record<string, HTMLElement | null>>({}), shown = useRef<Record<string, string>>({});
  const hud = useMemo<Hud>(() => {
    const set = (key: string, text: string) => {
      if (shown.current[key] === text || !els.current[key]) return;
      els.current[key]!.textContent = shown.current[key] = text;
      // New words pop. `scale` (not `transform`) so the centring transforms on these elements are left alone.
      if (text && key !== 'clock' && !key.startsWith('s')) els.current[key]!.animate([{ scale: key === 'big' ? 1.7 : 1.35 }, { scale: 1 }], { duration: 320, easing: 'cubic-bezier(0.34, 1.56, 0.64, 1)' });
    };
    // Web Animations API: a full-stage colour wash that fades itself out.
    const flash = (color: string) => els.current.flash?.animate([{ background: color, opacity: 0.45 }, { background: color, opacity: 0 }], 350);
    const shake = (amount = 1) => els.current.stage?.animate(
      Array.from({ length: 7 }, (_, k) => ({ transform: k === 6 ? 'none' : `translate(${(Math.random() - 0.5) * 24 * amount}px, ${(Math.random() - 0.5) * 24 * amount}px)` })), 260);
    return Object.assign(set, { flash, shake, p: (kind: 's' | 'h', p: number, text: string) => set(kind + p, text) });
  }, []);
  const shell = useContext(Shell);
  // Quality steps down by itself: if the frame rate sags, drop to 1x resolution and lose the bloom. Responsiveness beats gloss.
  const [lean, setLean] = useState(false);
  const el = (key: string, className: string) => <div className={`hud ${className}`} ref={(e) => void (els.current[key] = e)} />;
  return (
    <div className="stage" ref={(e) => void (els.current.stage = e)} onClick={shell.pause}>
      {/* Default camera: orthographic, 1 unit = 1/16 of the stage width on any display. */}
      <Canvas orthographic={!camera} frameloop={shell.paused ? 'never' : 'always'} dpr={lean ? 1 : [1, 1.25]} gl={{ antialias: true, alpha: true, powerPreference: 'high-performance' }}
        camera={camera ?? { zoom: 1, position: [0, 0, 10], left: -W / 2, right: W / 2, top: H / 2, bottom: -H / 2 }}>
        <PerformanceMonitor onDecline={() => setLean(true)} />
        <ambientLight intensity={1.2} />
        <directionalLight position={[3, 5, 8]} intensity={2} />
        <Suspense fallback={null}>{children(hud)}<Warm /></Suspense>
        <Pace />
        {effects.on && !lean && <EffectComposer multisampling={0}><Bloom intensity={0.7} luminanceThreshold={0.55} luminanceSmoothing={0.2} mipmapBlur /></EffectComposer>}
      </Canvas>
      {el('flash', 'flash')}{el('clock', 'clock')}{el('big', 'big')}
      {el('s0', n === 1 ? 'score solo' : 'score p1')}{el('h0', n === 1 ? 'hint solo' : 'hint p1')}
      {n === 2 && el('s1', 'score p2')}{n === 2 && el('h1', 'hint p2')}
    </div>
  );
}

// Top clock, plus a big 3-2-1-Go in the middle of the stage.
let lastCue = '';
export function countdown(hud: Hud, t: number, length: number) {
  const left = Math.ceil(t < 0 ? -t : length - t), cue = t < 0 ? String(left) : t < 0.7 ? 'go' : length - t <= 10 ? `end${left}` : '';
  hud('clock', String(left));
  hud('big', t < 0 ? String(left) : t < 0.7 ? 'Go!' : '');
  if (cue === lastCue) return;
  lastCue = cue;
  if (t < 0 || cue === 'go') say(cue); // the announcer counts you in: "3, 2, 1, go"
  else if (left === 10) say('hurry_up');
  else if (cue && left <= 5) sfx('tick', { vol: 0.6, jitter: 0 }) || blip(1000, 0.04);
}

// Call the returned tick(dt) once per frame: seconds into the round (negative during the countdown), or null once over.
export function useRound(hud: Hud, length: number, finish: () => void) {
  const r = useRef({ t: -COUNTDOWN, done: false });
  return (dt: number) => {
    const g = r.current;
    if (g.done) return null;
    g.t += Math.min(dt, 0.05);
    countdown(hud, g.t, length);
    if (g.t < length) return g.t;
    g.done = true;
    say('time_over');
    finish();
    return null;
  };
}

export const scoreHud = (hud: Hud, n: number, scores: number[]) => {
  for (let p = 0; p < n; p++) hud.p('s', p, players[p].present ? String(Math.round(scores[p])) : 'Step into view');
};
export const comboText = (combo: number) => (combo >= 5 ? `Combo ×${combo}` : '');

// Rising pitch with the combo is the oldest trick in the book, and it works: a sample for body, a blip for the climb.
export function hitSound(family: string, combo = 0, vol = 0.8) {
  sfx(family, { vol, rate: 1 + Math.min(combo, 12) * 0.03 });
  if (combo >= 3) blip(440 * 2 ** (Math.min(combo, 24) / 12), 0.07, 'triangle', undefined, 0.06);
}

// A loaded model, scaled so its largest side is `size` and re-centred on its own origin (y on the floor if `floor`).
export function useFitted(url: string, size: number, floor = false) {
  const { scene } = useGLTF(url);
  return useMemo(() => {
    const box = new THREE.Box3().setFromObject(scene), dim = box.getSize(new THREE.Vector3()), mid = box.getCenter(new THREE.Vector3());
    const k = size / Math.max(dim.x, dim.y, dim.z), inner = scene.clone(), root = new THREE.Group();
    inner.position.set(-mid.x * k, floor ? -box.min.y * k : -mid.y * k, -mid.z * k);
    inner.scale.setScalar(k);
    root.add(inner);
    return root;
  }, [scene, size, floor]);
}

// Particle bursts: one InstancedMesh for the whole game, however many hits happen at once.
const MAX_BITS = 240, bitGeo = new THREE.IcosahedronGeometry(0.11, 0), tmp = new THREE.Object3D(), tint = new THREE.Color();
export function useBursts() {
  const b = useMemo(() => {
    const mesh = new THREE.InstancedMesh(bitGeo, new THREE.MeshBasicMaterial(), MAX_BITS);
    mesh.frustumCulled = false;
    mesh.count = MAX_BITS;
    mesh.setColorAt(0, tint); // per-instance colour from the first frame: adding it at the first hit meant a new shader, built mid-round
    return { mesh, bits: Array.from({ length: MAX_BITS }, () => ({ life: 0, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0 })), at: 0 };
  }, []);
  const burst = (x: number, y: number, z: number, color: string, count = 14, speed = 6) => {
    tint.set(color);
    for (let k = 0; k < count; k++) {
      const i = (b.at = (b.at + 1) % MAX_BITS), a = Math.random() * Math.PI * 2, v = speed * (0.4 + Math.random() * 0.6);
      Object.assign(b.bits[i], { life: 0.5 + Math.random() * 0.3, x, y, z, vx: Math.cos(a) * v, vy: Math.sin(a) * v + 2, vz: (Math.random() - 0.5) * v });
      b.mesh.setColorAt(i, tint);
    }
    if (b.mesh.instanceColor) b.mesh.instanceColor.needsUpdate = true;
  };
  const update = (dt: number) => {
    b.bits.forEach((bit, i) => {
      if (bit.life > 0) { bit.life -= dt; bit.vy -= 12 * dt; bit.x += bit.vx * dt; bit.y += bit.vy * dt; bit.z += bit.vz * dt; }
      tmp.position.set(bit.x, bit.y, bit.z);
      tmp.scale.setScalar(Math.max(0, bit.life) * 2);
      tmp.updateMatrix();
      b.mesh.setMatrixAt(i, tmp.matrix);
    });
    b.mesh.instanceMatrix.needsUpdate = true;
  };
  return { burst, update, node: <primitive object={b.mesh} /> };
}

// Hands on the stage: a cursor and a tapering ribbon each. `update(dt)` moves them and returns where they are.
const TRAIL = 12, SPAN = 5;
const cursorGeo = new THREE.SphereGeometry(0.18, 12, 8);
export type StageHand = { p: number; x: number; y: number; px: number; py: number; speed: number; on: boolean; pts: Float32Array };

// `map` places the zones; the default is the orthographic stage split into n columns.
export type HandMap = { cx: (p: number) => number; hw: number; hh: number; cy?: number };
// `swing`: hand speed (stage units/s) that earns a whoosh the moment it is reached; 0 = silent hands.
export function useHands(n: number, map: HandMap = { cx: (p) => zoneX(n, p), hw: zoneHalf(n), hh: H / 2 }, swing = 6) {
  const hands = useMemo(
    () =>
      Array.from({ length: n * 2 }, (_, i) => {
        const geo = new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(new Float32Array(TRAIL * 6), 3));
        geo.setIndex(Array.from({ length: TRAIL - 1 }, (_, k) => [2 * k, 2 * k + 1, 2 * k + 2, 2 * k + 1, 2 * k + 3, 2 * k + 2]).flat());
        const color = PLAYER_COLORS[i >> 1];
        const ribbon = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.7, side: THREE.DoubleSide }));
        const cursor = new THREE.Mesh(cursorGeo, new THREE.MeshBasicMaterial({ color }));
        ribbon.frustumCulled = false; // rewritten every frame; cached bounds would be stale
        const pts = new Float32Array(TRAIL * 2);
        return { ribbon, cursor, pts, age: new Float32Array(TRAIL), armed: true, state: { p: i >> 1, x: 0, y: 0, px: 0, py: 0, speed: 0, on: false, pts } as StageHand };
      }),
    [n],
  );
  const update = (dt: number) =>
    hands.map((own, i) => {
      const { ribbon, cursor, pts, age, state: s } = own;
      const hand = players[s.p].hands[i & 1], was = s.on;
      s.on = ribbon.visible = cursor.visible = players[s.p].present && hand.seen;
      if (!s.on) return s;
      // The camera updates ~30x a second, the screen 60x: glide toward the latest reading so motion is continuous,
      // and take speed from the tracker (measured at camera rate) — never from per-frame screen deltas.
      // …and the reading is already old when it arrives, so aim at where the hand is by now (pose.ts predict).
      const at = predict(hand), tx = map.cx(s.p) + at.x * map.hw, ty = (map.cy ?? 0) + at.y * map.hh, k = was ? 1 - Math.exp(-dt * 45) : 1;
      s.px = was ? s.x : tx;
      s.py = was ? s.y : ty;
      s.x = s.px + (tx - s.px) * k;
      s.y = s.py + (ty - s.py) * k;
      cursor.position.set(s.x, s.y, 1);
      if (was) { pts.copyWithin(2, 0, (TRAIL - 1) * 2); age.copyWithin(1, 0, TRAIL - 1); for (let k = 1; k < TRAIL; k++) age[k] += dt; }
      else for (let k = 0; k < TRAIL; k++) { pts.set([s.x, s.y], k * 2); age[k] = k ? 1 : 0; }
      pts.set([s.x, s.y], 0);
      age[0] = 0;
      // Speed: the tracker's own estimate is steady but slow off the mark (it is low-passed, ~60ms) — a swing was
      // through the fruit before it "counted" as fast. So also measure straight across the last few drawn positions
      // (net distance, so jitter around a still hand reads as nothing) and believe whichever is higher.
      const across = Math.hypot(pts[0] - pts[2 * SPAN], pts[1] - pts[2 * SPAN + 1]) / Math.max(0.03, age[SPAN]);
      s.speed = Math.max(Math.hypot(hand.vx * map.hw, hand.vy * map.hh), age[SPAN] < 0.25 ? across : 0);
      if (swing && own.armed && s.speed > swing) { own.armed = false; whoosh(Math.min(1, s.speed / swing / 3)); }
      else if (s.speed < swing * 0.5) own.armed = true; // one whoosh per swing: re-arms only once the hand has slowed right down
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

// Did this hand's recent path pass within r of (x, y)? Looks back over the last few drawn positions (~100ms), not
// just this frame's step: a hand is often through the target a moment before it registers as "fast enough", and the
// player rightly feels that as a hit. Forgiving on purpose — use segDist on the last step alone for things to avoid.
export function swept(h: StageHand, x: number, y: number, r: number, steps = 6) {
  for (let k = 0; k < steps; k++) if (segDist(x, y, h.pts[2 * k + 2], h.pts[2 * k + 3], h.pts[2 * k], h.pts[2 * k + 1]) <= r) return true;
  return false;
}

// Distance from point p to segment a→b — "did this swing pass through that thing".
export function segDist(px: number, py: number, ax: number, ay: number, bx: number, by: number) {
  const dx = bx - ax, dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy || 1)));
  return Math.hypot(px - ax - t * dx, py - ay - t * dy);
}
