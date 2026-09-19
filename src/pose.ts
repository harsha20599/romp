// Camera → MediaPipe Pose → up to two players with body-relative hands.
// Games read the mutable `players` array every frame; nothing here touches React.
import type { NormalizedLandmark, PoseLandmarker } from '@mediapipe/tasks-vision';

export type Hand = { x: number; y: number; seen: boolean }; // -1..1 inside the player's own zone, y up
export type Player = {
  present: boolean;
  hands: [Hand, Hand]; // [screen-left, screen-right]
  energy: number;
  lift: number; // shoulder-widths above the player's own standing height: >0 jumping, <0 crouching
  lean: number; // shoulders' sideways offset from the hips, in shoulder-widths; >0 = toward screen-right
  angles: number[] | null; // 8 limb angles (radians, screen space) — see LIMBS
};

// Calibration knobs. Guesses until tuned on the real tablet at real distance (PLAN P4).
export const tuning = {
  reachX: [1.5, 1.1], // shoulder-widths of sideways reach that span the zone — [1 player, 2 players]
  reachY: 1.4, // same, vertically
  centerY: 0.2, // zone centre sits this many shoulder-widths above the shoulder line
  minVis: 0.5, // landmark visibility below this = not seen
  jump: 0.3, // lift above this = in the air
  crouch: -0.6, // lift below this = ducking
  leanOver: 0.3, // |lean| above this = leaning
  handUp: 0.5, // hand y above this = raised
  standBand: 0.25, // |lift| inside this counts as "standing"; the baseline follows it slowly
  energyDeadband: 0.05, // per-landmark travel (shoulder-widths/frame) ignored as jitter
  energyPerPoint: 12, // shoulder-widths of summed limb travel per activity point
  model: 'lite' as 'lite' | 'full', // 'full' if lite loses people at 3m
};

const mkPlayer = (): Player => ({
  present: false,
  hands: [{ x: 0, y: 0, seen: false }, { x: 0, y: 0, seen: false }],
  energy: 0,
  lift: 0,
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
export function handInZone(lm: NormalizedLandmark[], wrist: number, aspect: number, n: number): Hand {
  const f = bodyFrame(lm, aspect), w = lm[wrist];
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

const prev: (NormalizedLandmark[] | null)[] = [null, null];
// Each player's own standing shoulder height: learned while they stand, re-learned if they walk to a new spot.
const stand = [{ y: NaN, since: 0 }, { y: NaN, since: 0 }];
function apply(poses: NormalizedLandmark[][], aspect: number) {
  const slots = assignSlots(poses, aspect, nPlayers);
  players.forEach((pl, i) => {
    const lm = slots[i];
    pl.present = !!lm;
    if (!lm) return void ((prev[i] = null), (stand[i].y = NaN));
    WRISTS.forEach((w, h) => (pl.hands[h] = handInZone(lm, w, aspect, nPlayers)));
    const was = prev[i], f = bodyFrame(lm, aspect), sw = f.sw, st = stand[i], now = performance.now();
    if (Number.isNaN(st.y)) st.y = f.y;
    pl.lift = (st.y - f.y) / sw;
    if (Math.abs(pl.lift) < tuning.standBand) { st.y += (f.y - st.y) * 0.02; st.since = now; }
    else if (now - st.since > 4000) st.y = f.y; // out of band for 4s = they moved, not a 4s squat
    pl.lean = leanOf(lm, aspect);
    pl.angles = limbAngles(lm, aspect);
    if (was)
      for (const k of ENERGY_POINTS) {
        const d = Math.hypot((lm[k].x - was[k].x) * aspect, lm[k].y - was[k].y) / sw;
        if (d > tuning.energyDeadband && d < 1) pl.energy += d; // d >= 1 is a slot swap, not movement
      }
    prev[i] = lm;
  });
}

export async function startPose(video: HTMLVideoElement) {
  if (landmarker || sim) return sim ? startSim() : undefined;
  video.srcObject = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: 'user', width: 1280, height: 720, frameRate: 30 },
  });
  await video.play();
  const { FilesetResolver, PoseLandmarker } = await import('@mediapipe/tasks-vision');
  const fileset = await FilesetResolver.forVisionTasks('/wasm');
  const make = (delegate: 'GPU' | 'CPU') =>
    PoseLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: `/models/pose_landmarker_${tuning.model}.task`, delegate },
      runningMode: 'VIDEO', // VIDEO mode smooths landmarks itself — no filter of our own
      numPoses: nPlayers,
    }).then((l) => ((perf.delegate = delegate), l));
  landmarker = await make('GPU').catch(() => make('CPU'));

  // ponytail: inference on the main thread (~20ms/frame). Move to a worker if render fps suffers.
  let last = performance.now();
  const tick = () => {
    const now = performance.now();
    apply(landmarker!.detectForVideo(video, now).landmarks, video.videoWidth / video.videoHeight);
    perf.fps += (1000 / (now - last) - perf.fps) * 0.1;
    last = now;
    video.requestVideoFrameCallback(tick);
  };
  video.requestVideoFrameCallback(tick);
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
      pl.hands[0] = { x: -0.5, y: keys.has('a') ? 0.8 : -0.5, seen: true };
      if (keys.has('d') || e.key === 'd') pl.hands[1] = { x: 0.5, y: keys.has('d') ? 0.8 : -0.5, seen: true };
    }
  };
  addEventListener('keydown', body);
  addEventListener('keyup', body);
  addEventListener('pointermove', (e) => {
    const hand = { x: (e.clientX / innerWidth) * 2 - 1, y: 1 - (e.clientY / innerHeight) * 2, seen: true };
    for (const pl of players.slice(0, nPlayers)) {
      pl.energy += Math.hypot(hand.x - pl.hands[1].x, hand.y - pl.hands[1].y);
      pl.present = true;
      pl.hands[1] = hand;
    }
  });
}
