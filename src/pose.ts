// Camera → MediaPipe Pose → up to two players with body-relative hands.
// Games read the mutable `players` array every frame; nothing here touches React.
import type { NormalizedLandmark, PoseLandmarker } from '@mediapipe/tasks-vision';

// x, y: -1..1 inside the player's own zone, y up. vx, vy: zone-units per second, measured at camera rate.
// t: when the camera frame behind this reading was captured (performance.now clock) — the renderer predicts forward from it.
export type Hand = { x: number; y: number; vx: number; vy: number; seen: boolean; t: number };
export type Player = {
  present: boolean;
  hands: [Hand, Hand]; // [screen-left, screen-right]
  energy: number;
  lift: number; // shoulder-widths above the player's own standing height: >0 jumping, <0 crouching
  steer: number; // -1..1 analog left/right: leaning and side-stepping both count, whichever the player does
  lean: number; // shoulders' sideways offset from the hips, in shoulder-widths; >0 = toward screen-right
  angles: number[] | null; // 8 limb angles (radians, screen space) — see LIMBS
};

// Calibration knobs. Guesses until tuned on the real tablet at real distance (PLAN P4).
export const tuning = {
  reachX: [1.5, 1.1], // shoulder-widths of sideways reach that span the zone — [1 player, 2 players]
  reachY: 1.4, // same, vertically
  centerY: 0.2, // zone centre sits this many shoulder-widths above the shoulder line
  minVis: 0.5, // landmark visibility below this = not seen
  // One-Euro smoothing: `calm` is the cutoff (Hz) for a still hand — lower = steadier but laggier;
  // `quick` is how fast the cutoff opens up with speed — higher = less lag on fast swings.
  handCalm: 1.5, handQuick: 6,
  bodyCalm: 1.2, bodyQuick: 3, // shoulder frame (position + width) the hands are measured against
  liftCalm: 3.5, liftQuick: 6, // jump / crouch / lean signals
  speedCut: 2.5, // cutoff (Hz) on the speed estimate itself: higher = the filter notices the start of a move sooner
  lookahead: 0.03, // seconds predicted ahead on top of measured camera-to-screen age — hides tracking latency
  maxLead: 0.14, // never predict further than this, however stale the reading
  leanFull: 0.45, // lean (shoulder-widths) that steers fully to one side
  shiftFull: 0.7, // sideways step (shoulder-widths from where you started) that steers fully to one side
  handHold: 0.25, // seconds a hand keeps its last position after tracking loses it — stops flicker
  jump: 0.3, // lift above this = in the air
  crouch: -0.6, // lift below this = ducking
  leanOver: 0.3, // |lean| above this = leaning
  handUp: 0.5, // hand y above this = raised
  freezeStill: 1.5, // Freeze: movement rate (shoulder-widths of limb travel per second) that counts as "you moved"
  standBand: 0.25, // |lift| inside this counts as "standing"; the baseline follows it slowly
  energyDeadband: 0.05, // per-landmark travel (shoulder-widths/frame) ignored as jitter
  energyPerPoint: 12, // shoulder-widths of summed limb travel per activity point
  model: 'lite' as 'lite' | 'full', // 'full' if lite loses people at 3m
};

const mkPlayer = (): Player => ({
  present: false,
  hands: [{ x: 0, y: 0, vx: 0, vy: 0, seen: false, t: 0 }, { x: 0, y: 0, vx: 0, vy: 0, seen: false, t: 0 }],
  energy: 0,
  lift: 0,
  steer: 0,
  lean: 0,
  angles: null,
});
export const players: [Player, Player] = [mkPlayer(), mkPlayer()];
export const perf = { fps: 0, delegate: '' };
export const sim = new URLSearchParams(globalThis.location?.search ?? '').has('sim');

let nPlayers = 1;
let landmarker: PoseLandmarker | undefined;
export function setPlayers(n: number) {
  nPlayers = n;
  players[1].present &&= n === 2;
  void landmarker?.setOptions({ numPoses: n });
  worker?.postMessage({ type: 'players', n });
}

const L_SHOULDER = 11, R_SHOULDER = 12, WRISTS = [15, 16] as const;
const ENERGY_POINTS = [11, 12, 15, 16, 23, 24, 27, 28]; // shoulders, wrists, hips, ankles
// Upper arm, forearm (screen-left then screen-right), then thigh, shin — the order Shape Up's poses use.
export const LIMBS = [[11, 13], [13, 15], [12, 14], [14, 16], [23, 25], [25, 27], [24, 26], [26, 28]] as const;

// Mirrored (the TV is a mirror) and aspect-corrected so a shoulder-width is the same unit on both axes.
const mx = (p: NormalizedLandmark, aspect: number) => (1 - p.x) * aspect;
const seen = (p: NormalizedLandmark) => (p.visibility ?? 1) >= tuning.minVis;

export function bodyFrame(lm: NormalizedLandmark[], aspect: number) {
  const a = lm[L_SHOULDER], b = lm[R_SHOULDER];
  return {
    x: (mx(a, aspect) + mx(b, aspect)) / 2,
    y: (a.y + b.y) / 2,
    sw: Math.hypot(mx(a, aspect) - mx(b, aspect), a.y - b.y) || 1e-6,
  };
}

// The narrow-room rule: a hand is read relative to its owner's shoulders, in shoulder-widths,
// with gain — never as a position in the camera frame.
export function handInZone(lm: NormalizedLandmark[], wrist: number, aspect: number, n: number, f = bodyFrame(lm, aspect)) {
  const w = lm[wrist];
  const clamp = (v: number) => Math.max(-1, Math.min(1, v));
  return {
    x: clamp((mx(w, aspect) - f.x) / f.sw / tuning.reachX[n - 1]),
    y: clamp(((f.y - w.y) / f.sw - tuning.centerY) / tuning.reachY),
    seen: seen(w),
  };
}

export const leanOf = (lm: NormalizedLandmark[], aspect: number) => {
  const f = bodyFrame(lm, aspect);
  return (f.x - (mx(lm[23], aspect) + mx(lm[24], aspect)) / 2) / f.sw;
};
export const limbAngles = (lm: NormalizedLandmark[], aspect: number) =>
  LIMBS.map(([a, b]) => Math.atan2(lm[a].y - lm[b].y, mx(lm[b], aspect) - mx(lm[a], aspect)));

// 100 at ≤10° average error, 0 at ≥50°. Arms count double: they carry the shape, legs mostly just stand.
export function poseMatch(a: number[], b: number[]) {
  const err = a.reduce((sum, v, i) => sum + Math.abs(Math.atan2(Math.sin(v - b[i]), Math.cos(v - b[i]))) * (i < 4 ? 2 : 1), 0) / 12 / (Math.PI / 180);
  return Math.round(Math.max(0, Math.min(100, (50 - err) * 2.5)));
}

// Biggest n bodies play; left-to-right on screen = P1, P2.
export function assignSlots(poses: NormalizedLandmark[][], aspect: number, n: number) {
  return poses
    .filter((lm) => seen(lm[L_SHOULDER]) && seen(lm[R_SHOULDER]))
    .map((lm) => ({ lm, f: bodyFrame(lm, aspect) }))
    .sort((a, b) => b.f.sw - a.f.sw)
    .slice(0, n)
    .sort((a, b) => a.f.x - b.f.x)
    .map((p) => p.lm);
}

// One-Euro filter (Casiez et al.): heavy smoothing when still, almost none when moving fast.
export class OneEuro {
  x = NaN; dx = 0; calm; quick;
  constructor(calm: () => number, quick: () => number) { this.calm = calm; this.quick = quick; }
  next(v: number, dt: number) {
    if (Number.isNaN(this.x)) return (this.x = v);
    const alpha = (cutoff: number) => { const r = 2 * Math.PI * cutoff * dt; return r / (r + 1); };
    this.dx += alpha(tuning.speedCut) * ((v - this.x) / dt - this.dx);
    return (this.x += alpha(this.calm() + this.quick() * Math.abs(this.dx)) * (v - this.x));
  }
  reset() { this.x = NaN; this.dx = 0; }
}
const euro = (kind: 'hand' | 'body' | 'lift') => new OneEuro(() => tuning[`${kind}Calm`], () => tuning[`${kind}Quick`]);
const mkFilters = () => ({
  fx: euro('body'), fy: euro('body'), sw: euro('body'), lift: euro('lift'), lean: euro('lift'), steer: euro('lift'),
  hands: [0, 1].map(() => ({ x: euro('hand'), y: euro('hand'), lost: 0 })),
});
const filters = [mkFilters(), mkFilters()];
const resetFilters = (F: ReturnType<typeof mkFilters>) =>
  [F.fx, F.fy, F.sw, F.lift, F.lean, F.steer, ...F.hands.flatMap((h) => [h.x, h.y])].forEach((f) => f.reset());

const prev: (NormalizedLandmark[] | null)[] = [null, null];
let lastApply = 0;
// Each player's own standing shoulder height: learned while they stand, re-learned if they walk to a new spot.
const stand = [{ y: NaN, x: NaN, since: 0 }, { y: NaN, x: NaN, since: 0 }];
// `now` is when the frame was captured, so every reading carries its true age and speeds use true frame spacing.
function apply(poses: NormalizedLandmark[][], aspect: number, now = performance.now()) {
  const slots = assignSlots(poses, aspect, nPlayers);
  const dt = Math.min(0.2, Math.max(1e-3, (now - lastApply) / 1000));
  lastApply = now;
  players.forEach((pl, i) => {
    const lm = slots[i], F = filters[i], st = stand[i];
    pl.present = !!lm;
    if (!lm) return void ((prev[i] = null), (st.y = st.x = NaN), resetFilters(F));

    // The shoulder frame is smoothed harder than the hands: its noise is multiplied into every hand reading.
    const raw = bodyFrame(lm, aspect);
    const f = { x: F.fx.next(raw.x, dt), y: F.fy.next(raw.y, dt), sw: F.sw.next(raw.sw, dt) };
    WRISTS.forEach((w, h) => {
      const hf = F.hands[h], r = handInZone(lm, w, aspect, nPlayers, f);
      if (r.seen) {
        hf.lost = 0;
        pl.hands[h] = { x: hf.x.next(r.x, dt), y: hf.y.next(r.y, dt), vx: hf.x.dx, vy: hf.y.dx, seen: true, t: now };
      } else if ((hf.lost += dt) > tuning.handHold) {
        pl.hands[h] = { ...pl.hands[h], vx: 0, vy: 0, seen: false };
        hf.x.reset(); hf.y.reset();
      }
    });

    if (Number.isNaN(st.y)) st.y = raw.y;
    const lift = (st.y - raw.y) / f.sw;
    if (Math.abs(lift) < tuning.standBand) { st.y += (raw.y - st.y) * 0.02; st.since = now; }
    else if (now - st.since > 4000) st.y = raw.y; // out of band for 4s = they moved, not a 4s squat
    pl.lift = F.lift.next(lift, dt);
    pl.lean = F.lean.next(leanOf(lm, aspect), dt);
    // Steering: where you started is centre (re-learned very slowly, ~20s, so it follows you across a session
    // but not across a lane change). Lean and side-step add up, so either way of "going left" works.
    if (Number.isNaN(st.x)) st.x = raw.x;
    st.x += (raw.x - st.x) * 0.0015;
    pl.steer = F.steer.next(Math.max(-1, Math.min(1, pl.lean / tuning.leanFull + (raw.x - st.x) / f.sw / tuning.shiftFull)), dt);
    pl.angles = limbAngles(lm, aspect);

    const was = prev[i];
    if (was)
      for (const k of ENERGY_POINTS) {
        const d = Math.hypot((lm[k].x - was[k].x) * aspect, lm[k].y - was[k].y) / f.sw;
        if (d > tuning.energyDeadband && d < 1) pl.energy += d; // d >= 1 is a slot swap, not movement
      }
    prev[i] = lm;
  });
}

export const track = { lag: 0 }; // ms from camera frame to usable pose — shown next to the fps on the home screen

export async function startPose(video: HTMLVideoElement) {
  if (landmarker || worker || sim) return sim ? startSim() : undefined;
  // 640×480 on purpose: the model works at 256px anyway, so a bigger frame only costs upload time — i.e. latency.
  // 4:3 also sees more height, which is what jumps and raised hands need.
  video.srcObject = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: 640, height: 480, frameRate: 30 } });
  await video.play();
  const model = `/models/pose_landmarker_${tuning.model}.task`;
  if (!(await startWorker(video, model).catch(() => false))) await startInline(video, model);
}

// Preferred: inference in a worker. Frames are handed over as ImageBitmaps, one in flight at a time, so the
// worker always gets the newest frame and the main thread never waits on the model.
let worker: Worker | undefined;
async function startWorker(video: HTMLVideoElement, model: string) {
  if (typeof OffscreenCanvas === 'undefined' || typeof createImageBitmap === 'undefined') return false;
  const w = new Worker(new URL('./pose.worker.ts', import.meta.url));
  const ready = await new Promise<string | null>((resolve) => {
    const giveUp = setTimeout(() => resolve(null), 25000);
    w.onerror = () => resolve(null);
    w.onmessage = (e) => (e.data.type === 'ready' || e.data.type === 'failed') && (clearTimeout(giveUp), resolve(e.data.type === 'ready' ? e.data.delegate : null));
    w.postMessage({ type: 'init', wasm: `${location.origin}/wasm`, model: location.origin + model, n: nPlayers });
  });
  if (!ready) return w.terminate(), false;
  worker = w;
  perf.delegate = `${ready} worker`;
  let busy = false, last = performance.now();
  w.onmessage = (e) => {
    if (e.data.type !== 'pose') return;
    busy = false;
    const now = performance.now();
    apply(e.data.landmarks, video.videoWidth / video.videoHeight, e.data.t);
    perf.fps += (1000 / (now - last) - perf.fps) * 0.1;
    track.lag += (now - e.data.t - track.lag) * 0.1;
    last = now;
  };
  const tick = async () => {
    video.requestVideoFrameCallback(tick);
    if (busy) return;
    busy = true;
    const t = performance.now(), bitmap = await createImageBitmap(video).catch(() => null);
    if (bitmap) w.postMessage({ type: 'frame', bitmap, t }, [bitmap]); else busy = false;
  };
  video.requestVideoFrameCallback(tick);
  return true;
}

// Fallback: the original main-thread path, for browsers where the worker route is not available.
async function startInline(video: HTMLVideoElement, model: string) {
  const { FilesetResolver, PoseLandmarker } = await import('@mediapipe/tasks-vision');
  const fileset = await FilesetResolver.forVisionTasks('/wasm');
  const make = (delegate: 'GPU' | 'CPU') =>
    PoseLandmarker.createFromOptions(fileset, { baseOptions: { modelAssetPath: model, delegate }, runningMode: 'VIDEO', numPoses: nPlayers })
      .then((l) => ((perf.delegate = `${delegate} inline`), l));
  landmarker = await make('GPU').catch(() => make('CPU'));
  let last = performance.now();
  const tick = () => {
    const now = performance.now();
    apply(landmarker!.detectForVideo(video, now).landmarks, video.videoWidth / video.videoHeight, now);
    perf.fps += (1000 / (now - last) - perf.fps) * 0.1;
    track.lag += (performance.now() - now - track.lag) * 0.1;
    last = now;
    video.requestVideoFrameCallback(tick);
  };
  video.requestVideoFrameCallback(tick);
}

// Where a hand is *now*: its last reading pushed forward along its own velocity by the reading's age.
export function predict(hand: Hand, now = performance.now()) {
  const lead = Math.min(tuning.maxLead, Math.max(0, (now - hand.t) / 1000) + tuning.lookahead);
  return { x: Math.max(-1, Math.min(1, hand.x + hand.vx * lead)), y: Math.max(-1, Math.min(1, hand.y + hand.vy * lead)) };
}

// ?sim — the mouse is everyone's right hand; arrows jump/crouch/lean; A / D raise the left / right hand.
// For building and checking games with no camera.
function startSim() {
  perf.delegate = 'sim';
  const keys = new Set<string>();
  const body = (e: KeyboardEvent) => {
    e.type === 'keydown' ? keys.add(e.key) : keys.delete(e.key);
    for (const pl of players.slice(0, nPlayers)) {
      pl.present = true;
      pl.lift = keys.has('ArrowUp') ? 0.6 : keys.has('ArrowDown') ? -1 : 0;
      pl.lean = keys.has('ArrowRight') ? 0.6 : keys.has('ArrowLeft') ? -0.6 : 0;
      pl.steer = Math.sign(pl.lean);
      pl.hands[0] = { x: -0.5, y: keys.has('a') ? 0.8 : -0.5, vx: 0, vy: 0, seen: true, t: performance.now() };
      if (keys.has('d') || e.key === 'd') pl.hands[1] = { x: 0.5, y: keys.has('d') ? 0.8 : -0.5, vx: 0, vy: 0, seen: true, t: performance.now() };
    }
  };
  addEventListener('keydown', body);
  addEventListener('keyup', body);
  let lastMove = 0;
  addEventListener('pointermove', (e) => {
    const now = performance.now(), dt = Math.max(1e-3, (now - lastMove) / 1000);
    lastMove = now;
    const x = (e.clientX / innerWidth) * 2 - 1, y = 1 - (e.clientY / innerHeight) * 2;
    for (const pl of players.slice(0, nPlayers)) {
      const was = pl.hands[1];
      pl.energy += Math.hypot(x - was.x, y - was.y);
      pl.present = true;
      pl.hands[1] = { x, y, vx: (x - was.x) / dt, vy: (y - was.y) / dt, seen: true, t: now };
    }
  });
  setInterval(() => { // a mouse at rest sends no events, so its last velocity would stick
    if (performance.now() - lastMove > 60) for (const pl of players) pl.hands[1] = { ...pl.hands[1], vx: 0, vy: 0, t: performance.now() };
  }, 30);
}
