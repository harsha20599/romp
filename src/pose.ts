// Camera → MediaPipe Pose → up to two players with body-relative hands.
// Games read the mutable `players` array every frame; nothing here touches React.
import type { NormalizedLandmark, PoseLandmarker } from '@mediapipe/tasks-vision';

export type Hand = { x: number; y: number; seen: boolean }; // -1..1 inside the player's own zone, y up
export type Player = { present: boolean; hands: [Hand, Hand]; energy: number };

// Calibration knobs. Guesses until tuned on the real tablet at real distance (PLAN P4).
export const tuning = {
  reachX: [1.5, 1.1], // shoulder-widths of sideways reach that span the zone — [1 player, 2 players]
  reachY: 1.4, // same, vertically
  centerY: 0.2, // zone centre sits this many shoulder-widths above the shoulder line
  minVis: 0.5, // landmark visibility below this = not seen
  energyDeadband: 0.05, // per-landmark travel (shoulder-widths/frame) ignored as jitter
  energyPerPoint: 12, // shoulder-widths of summed limb travel per activity point
  model: 'lite' as 'lite' | 'full', // 'full' if lite loses people at 3m
};

const mkPlayer = (): Player => ({
  present: false,
  hands: [{ x: 0, y: 0, seen: false }, { x: 0, y: 0, seen: false }],
  energy: 0,
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
function apply(poses: NormalizedLandmark[][], aspect: number) {
  const slots = assignSlots(poses, aspect, nPlayers);
  players.forEach((pl, i) => {
    const lm = slots[i];
    pl.present = !!lm;
    if (!lm) return void (prev[i] = null);
    WRISTS.forEach((w, h) => (pl.hands[h] = handInZone(lm, w, aspect, nPlayers)));
    const was = prev[i], sw = bodyFrame(lm, aspect).sw;
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

// ?sim — the mouse is everyone's right hand. For building and checking games with no camera.
function startSim() {
  perf.delegate = 'sim';
  addEventListener('pointermove', (e) => {
    const hand = { x: (e.clientX / innerWidth) * 2 - 1, y: 1 - (e.clientY / innerHeight) * 2, seen: true };
    for (const pl of players.slice(0, nPlayers)) {
      pl.energy += Math.hypot(hand.x - pl.hands[1].x, hand.y - pl.hands[1].y);
      pl.present = true;
      pl.hands[1] = hand;
    }
  });
}
