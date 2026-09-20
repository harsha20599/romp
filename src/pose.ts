// Camera → MediaPipe Pose → up to two players with body-relative hands.
// Games read the mutable `players` array every frame; nothing here touches React.
import type { NormalizedLandmark, PoseLandmarker } from '@mediapipe/tasks-vision';

// x, y: -1..1 inside the player's own zone, y up. vx, vy: zone-units per second, measured at camera rate.
// t: when the camera frame behind this reading was captured (performance.now clock) — the renderer predicts forward from it.
// ax, ay: acceleration, zone-units/s² — only trusted for one thing: knowing when a hand is braking (see predict).
export type Hand = { x: number; y: number; vx: number; vy: number; ax: number; ay: number; seen: boolean; t: number };
export type Player = {
  present: boolean;
  hands: [Hand, Hand]; // [screen-left, screen-right]
  energy: number;
  lift: number; // shoulder-widths above the player's own standing height: >0 jumping, <0 crouching
  liftV: number; // …and how fast that is changing, shoulder-widths per second — a squat is obvious long before it is deep
  steer: number; // -1..1 analog left/right: leaning and side-stepping both count, whichever the player does
  lean: number; // shoulders' sideways offset from the hips, in shoulder-widths; >0 = toward screen-right
  body: number[][]; // all 33 landmarks as [x, y, visibility], mirrored, in camera-frame units — for the presence figure and the Tracking screen
  palms: number[][]; // both palm points, same units
  angles: number[] | null; // 8 limb angles (radians, screen space) — see LIMBS
};

const stored = (key: string) => { try { return globalThis.localStorage?.getItem(key) ?? null; } catch { return null; } };

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
  speedCut: 2.5, // the speed estimate that opens the smoothing filter up. Calm on purpose: a jumpy one lets rest-noise through.
  leadCut: 5, // the speed estimate prediction rides on: quicker, because over a ~200ms lead a velocity that is itself 60ms late costs more than its noise
  // cutoff (Hz) on the speed estimate itself: higher = the filter notices the start of a move sooner
  predictFrom: 1.2, predictFull: 3.5, // hand speed (zone-units/s) where prediction starts, and where it is fully on.
  // Below predictFrom a hand is "still": extrapolating a still hand only amplifies noise into wobble.
  // Delay the page cannot see: the camera's own pipeline before a frame reaches us, plus the screen's after we draw.
  // Measured on the Tab S7 (flash test, 2026-09-20): ~90ms on its own panel, ~120ms on the TV in Game mode, ~185ms
  // on the TV outside it. "Measure delay" on the Tracking screen re-measures it for whatever screen is plugged in.
  unseen: Math.max(0, Math.min(300, Number(stored('romp.unseen') ?? 120))) / 1000,
  maxLead: 0.22, // never predict further than this, however stale the reading
  accCut: 2, // cutoff (Hz) on the acceleration estimate
  brakeFrom: 4, // deceleration (zone-units/s²) below which a hand is not "braking" — that much is just noise in the estimate
  leanFull: 0.45, // lean (shoulder-widths) that steers fully to one side
  shiftFull: 0.7, // sideways step (shoulder-widths from where you started) that steers fully to one side
  fistAt: 1.05, openAt: 1.3, // measured: curled fingers read ~0.6, an open palm ~1.8+, so a relaxed half-open hand stays "open" // finger curl (see pose.worker.ts) below which a hand is a fist, and above which it is open again
  handHold: 0.25, // seconds a hand keeps its last position after tracking loses it — stops flicker
  jump: 0.3, // lift above this = in the air
  crouch: -0.6, // lift below this = ducking
  riseFast: 1.5, dropFast: 1.2, // lift speed (shoulder-widths/s) that says "this is a jump / a squat" once it is 40% of the way there
  leanOver: 0.3, // |lean| above this = leaning
  handUp: 0.5, // hand y above this = raised
  freezeStill: 1.5, // Freeze: movement rate (shoulder-widths of limb travel per second) that counts as "you moved"
  standBand: 0.25, // |lift| inside this counts as "standing"; the baseline follows it slowly
  energyDeadband: 0.05, // per-landmark travel (shoulder-widths/frame) ignored as jitter
  energyPerPoint: 12, // shoulder-widths of summed limb travel per activity point
  model: (stored('romp.model') === 'lite' ? 'lite' : 'full') as 'lite' | 'full', // full: steadier wrists, a few ms slower. Switchable on the Tracking screen.
  sharp: stored('romp.sharp') !== 'off', // our own auto-exposure with the shutter capped at 16ms (see tuneCamera): sharper fast hands and a steady 30fps
  direct: stored('romp.frames') !== 'copied', // stream camera frames straight into the tracker (off = copy them out of the <video>, the old route)
  fastCam: stored('romp.cam') !== 'standard', // take the camera's 60fps mode when it has one, even at a smaller picture
};

const mkPlayer = (): Player => ({
  present: false,
  hands: [{ x: 0, y: 0, vx: 0, vy: 0, ax: 0, ay: 0, seen: false, t: 0 }, { x: 0, y: 0, vx: 0, vy: 0, ax: 0, ay: 0, seen: false, t: 0 }],
  energy: 0,
  body: [],
  palms: [],
  lift: 0,
  liftV: 0,
  steer: 0,
  lean: 0,
  angles: null,
});
export const players: [Player, Player] = [mkPlayer(), mkPlayer()];
export const perf = { fps: 0, delegate: '' };
queueMicrotask(() => Object.assign(globalThis, { __romp: { perf, track, tuning, players, grip } })); // a handle for DevTools over adb — read-only by convention
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
// The pose model reports the wrist and two knuckles (pinky, index) for each hand. One point is noisy; the
// visibility-weighted blend of three is steadier, and it sits on the palm — the part you actually swing at fruit.
const HAND_POINTS: Record<number, [number, number][]> = { 15: [[15, 0.4], [17, 0.3], [19, 0.3]], 16: [[16, 0.4], [18, 0.3], [20, 0.3]] };
export function palm(lm: NormalizedLandmark[], wrist: number): NormalizedLandmark {
  let x = 0, y = 0, total = 0;
  for (const [k, weight] of HAND_POINTS[wrist]) { const w = weight * (lm[k].visibility ?? 1); x += lm[k].x * w; y += lm[k].y * w; total += w; }
  return total > 0.05 ? { x: x / total, y: y / total, z: 0, visibility: lm[wrist].visibility ?? 1 } : lm[wrist];
}

export function handInZone(lm: NormalizedLandmark[], wrist: number, aspect: number, n: number, f = bodyFrame(lm, aspect)) {
  const w = palm(lm, wrist);
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

// Intent, not position. A squat takes ~400ms to reach the crouch line, and by then the beam has passed. But a squat
// *starts* unmistakably: the shoulders are already dropping fast when they are less than halfway down. So a move counts
// from the moment it is clearly under way — which is when the player feels they made it — not when it completes.
export const isAir = (pl: Player) => pl.lift > tuning.jump || (pl.lift > tuning.jump * 0.4 && pl.liftV > tuning.riseFast);
export const isLow = (pl: Player) => pl.lift < tuning.crouch || (pl.lift < tuning.crouch * 0.4 && pl.liftV < -tuning.dropFast);

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
  x = NaN; dx = 0; v = 0; ddx = 0; calm; quick; // dx: calm speed, steers the filter · v: quick speed, for prediction · ddx: acceleration
  constructor(calm: () => number, quick: () => number) { this.calm = calm; this.quick = quick; }
  next(v: number, dt: number) {
    if (Number.isNaN(this.x)) return (this.x = v);
    const alpha = (cutoff: number) => { const r = 2 * Math.PI * cutoff * dt; return r / (r + 1); };
    const raw = (v - this.x) / dt, was = this.v;
    this.dx += alpha(tuning.speedCut) * (raw - this.dx);
    this.v += alpha(tuning.leadCut) * (raw - this.v);
    this.ddx += alpha(tuning.accCut) * ((this.v - was) / dt - this.ddx);
    return (this.x += alpha(this.calm() + this.quick() * Math.abs(this.dx)) * (v - this.x));
  }
  reset() { this.x = NaN; this.dx = this.v = this.ddx = 0; }
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
const stand = [{ y: NaN, x: NaN, since: 0, ratio: 0 }, { y: NaN, x: NaN, since: 0, ratio: 0 }];
// `now` is when the frame was captured, so every reading carries its true age and speeds use true frame spacing.
function apply(poses: NormalizedLandmark[][], aspect: number, now = performance.now()) {
  const slots = assignSlots(poses, aspect, nPlayers);
  const dt = Math.min(0.2, Math.max(1e-3, (now - lastApply) / 1000));
  lastApply = now;
  players.forEach((pl, i) => {
    const lm = slots[i], F = filters[i], st = stand[i];
    pl.present = !!lm;
    if (!lm) return void ((prev[i] = null), (st.y = st.x = NaN), (st.ratio = 0), resetFilters(F));

    // The shoulder frame is smoothed harder than the hands: its noise is multiplied into every hand reading.
    const raw = bodyFrame(lm, aspect);
    // Shoulder width is the unit every hand reading is measured in — but on camera it shrinks whenever you twist,
    // and slicing IS twisting, so the hand dot used to swing with your torso. Torso length does not change with a
    // twist. So: learn this player's shoulder-to-torso ratio while they face the camera (a slowly decaying maximum),
    // and take the unit as the larger of the measured shoulders and torso × ratio. Twist → torso holds it up.
    // Bend forward → the torso shortens instead, and the shoulders hold it up.
    if (seen(lm[23]) && seen(lm[24])) {
      const torso = Math.hypot(raw.x - (mx(lm[23], aspect) + mx(lm[24], aspect)) / 2, raw.y - (lm[23].y + lm[24].y) / 2);
      st.ratio = Math.max(st.ratio * 0.9995, Math.min(1.3, raw.sw / (torso || 1e-6)));
      raw.sw = Math.max(raw.sw, torso * st.ratio);
    }
    pl.body = lm.map((q) => [1 - q.x, q.y, q.visibility ?? 1]);
    pl.palms = [palm(lm, 15), palm(lm, 16)].map((q) => [1 - q.x, q.y]);
    const f = { x: F.fx.next(raw.x, dt), y: F.fy.next(raw.y, dt), sw: F.sw.next(raw.sw, dt) };
    WRISTS.forEach((w, h) => {
      const hf = F.hands[h], r = handInZone(lm, w, aspect, nPlayers, f);
      if (r.seen) {
        hf.lost = 0;
        pl.hands[h] = { x: hf.x.next(r.x, dt), y: hf.y.next(r.y, dt), vx: hf.x.v, vy: hf.y.v, ax: hf.x.ddx, ay: hf.y.ddx, seen: true, t: now };
      } else if ((hf.lost += dt) > tuning.handHold) {
        pl.hands[h] = { ...pl.hands[h], vx: 0, vy: 0, ax: 0, ay: 0, seen: false };
        hf.x.reset(); hf.y.reset();
      }
    });

    if (Number.isNaN(st.y)) st.y = raw.y;
    const lift = (st.y - raw.y) / f.sw;
    if (Math.abs(lift) < tuning.standBand) { st.y += (raw.y - st.y) * 0.02; st.since = now; }
    else if (now - st.since > 4000) st.y = raw.y; // out of band for 4s = they moved, not a 4s squat
    pl.lift = F.lift.next(lift, dt);
    pl.liftV = F.lift.dx;
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

// camFps vs the pose fps tells you which side is the bottleneck; grab = copying the frame out, model = the tracker itself.
export const track = { lag: 0, camera: '', camFps: 0, grabMs: 0, modelMs: 0, frames: '' }; // frames: 'direct' (streamed to the tracker) or 'copied'

// Fist-to-press. The pose model cannot see fingers, so while a menu wants it (`want`), the palm of the pointing hand
// is cropped out of the frame and sent to a hand model after each pose result. Games never set `want`: zero cost in play.
export const grip = { want: false, hand: 1, closed: false, curl: 0, seenAt: 0, busy: false }; // ms from camera frame to usable pose — shown next to the fps on the home screen

export async function startPose(video: HTMLVideoElement) {
  if (landmarker || worker || sim) return sim ? startSim() : undefined;
  // 1280×720: the tracker crops each person out of the frame and scales the crop to 256px. At three metres a
  // player is ~430px tall at 720p but only ~290px at 480p — the bigger frame gives the crop real detail to shrink
  // from (less sensor noise in, steadier landmarks out). 60fps is asked for, not required: if the camera can, each
  // frame's exposure is shorter, which is what keeps a fast hand from smearing.
  const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: 1280, height: 720, frameRate: { ideal: 60 } } });
  video.srcObject = stream;
  const cam = stream.getVideoTracks()[0];
  await video.play();
  track.camera = await tuneCamera(cam, video);
  const model = `/models/pose_landmarker_${tuning.model}.task`;
  if (!(await startWorker(video, model, cam).catch(() => false))) await startInline(video, model);
}

// A smeared hand cannot be tracked accurately by any model. Measured on the Tab S7 (2026-09-20, adb + DevTools): left
// to itself indoors the camera exposes every frame for 40ms at ISO 50 — 40ms of blur, and only 25 frames a second,
// because a 40ms exposure cannot fit 30 times into a second. Chrome does expose manual exposure on this camera, so we
// run our own auto-exposure with the shutter capped: 16ms, with the gain (ISO) servoed to keep the *player* — the
// box around the tracked player, the middle of the frame otherwise — at a sensible brightness. Only if the gain
// runs out does the shutter lengthen, and never past one frame. "Sharp motion" off = the camera's own auto-exposure.
async function tuneCamera(cam: MediaStreamTrack, video: HTMLVideoElement) {
  const caps = (cam.getCapabilities?.() ?? {}) as Record<string, { min: number; max: number } & string[]>, fastest = Math.round(caps.frameRate?.max ?? 0);
  // A 60fps mode halves both the wait for the next frame and the blur inside each one. That is worth a smaller
  // picture (the tracker only ever looks at a 256px crop of the player) — but never below 480 lines.
  if (tuning.fastCam && fastest >= 50 && (cam.getSettings().frameRate ?? 0) < 50)
    await cam.applyConstraints({ frameRate: { min: 50 }, height: { min: 480, ideal: 720 }, aspectRatio: { ideal: 16 / 9 } }).catch(() => {});
  const set = cam.getSettings();
  const note = [`${set.width}×${set.height} @${Math.round(set.frameRate ?? 0)}${fastest ? ` (camera max ${fastest})` : ''}`];
  const tryApply = (advanced: Record<string, unknown>) => cam.applyConstraints({ advanced: [advanced] } as MediaTrackConstraints).then(() => true, () => false);
  if (caps.focusMode?.includes('continuous')) await tryApply({ focusMode: 'continuous' });
  if (!tuning.sharp) return note.join(' · ');
  if (!caps.exposureMode?.includes('manual') || !caps.exposureTime || !caps.iso) return [...note, 'camera has no manual exposure'].join(' · ');

  const FRAME = 330, clampTo = (v: number, r: { min: number; max: number }) => Math.max(r.min, Math.min(r.max, v)); // exposureTime is in units of 100µs
  let shutter = clampTo(160, caps.exposureTime), iso = clampTo(400, caps.iso);
  const apply = () => tryApply({ exposureMode: 'manual', exposureTime: shutter, iso });
  if (!(await apply())) return [...note, 'shutter refused'].join(' · ');
  const eye = new OffscreenCanvas(16, 16).getContext('2d', { willReadFrequently: true })!;
  setInterval(() => {
    if (!video.videoWidth || document.hidden) return;
    const b = players[0].present ? players[0].body : null, vw = video.videoWidth, vh = video.videoHeight;
    // Meter on the player: the box around every landmark the tracker can see (stored mirrored; the frame is not) —
    // face, arms, clothes and a little background, so a black T-shirt alone cannot drive the gain to the ceiling.
    const pts = b?.filter((q) => q[2] > 0.5) ?? [], xs = pts.length > 5 ? pts.map((q) => 1 - q[0]) : [0.25, 0.75], ys = pts.length > 5 ? pts.map((q) => q[1]) : [0.25, 0.75];
    const x = Math.max(0, Math.min(...xs)), y = Math.max(0, Math.min(...ys)), w = Math.min(1, Math.max(...xs)) - x, h = Math.min(1, Math.max(...ys)) - y;
    if (w < 0.02 || h < 0.02) return;
    eye.drawImage(video, x * vw, y * vh, w * vw, h * vh, 0, 0, 16, 16);
    const d = eye.getImageData(0, 0, 16, 16).data;
    let luma = 0;
    for (let i = 0; i < d.length; i += 4) luma += (d[i] * 2 + d[i + 1] * 5 + d[i + 2]) / 8;
    luma /= d.length / 4;
    const was = `${shutter}/${iso}`;
    if (luma < 85) { if (iso < caps.iso.max) iso = clampTo(iso * 1.35, caps.iso); else shutter = Math.min(FRAME, shutter * 1.25); } // gain first; blur only as the last resort
    else if (luma > 150) { if (shutter > 160) shutter = Math.max(160, shutter / 1.25); else if (iso > caps.iso.min) iso = clampTo(iso / 1.35, caps.iso); else shutter = clampTo(shutter / 1.25, caps.exposureTime); }
    if (`${shutter}/${iso}` !== was) void apply();
    track.camera = [...note, `shutter ${(shutter / 10).toFixed(0)}ms · ISO ${Math.round(iso)} · player brightness ${Math.round(luma)}`].join(' · ');
  }, 1200);
  return [...note, `shutter ${(shutter / 10).toFixed(0)}ms`].join(' · ');
}

// Not in TypeScript's DOM library yet.
declare const MediaStreamTrackProcessor: undefined | (new (init: { track: MediaStreamTrack; maxBufferSize?: number }) => { readable: ReadableStream });

// A streamed frame carries a timestamp on the capture pipeline's clock, not the page's. The offset between the two
// is constant, and it is pinned down in two steps. A frame cannot arrive before it was taken, so the largest
// (timestamp − arrival) ever seen is the offset, short by the quickest delivery (a few ms). Then the page's own video
// callback — which does report each frame's capture time on the page clock — names the exact frame: whichever
// recent capture time sits within that few-ms window of the estimate is the same frame, and that pair is exact.
export function frameClock() {
  let loose = -Infinity, exact = NaN;
  const seenAt: number[] = [];
  return {
    saw(captureTime: number) { seenAt.push(captureTime); if (seenAt.length > 8) seenAt.shift(); },
    time(ts: number, arrived: number) {
      loose = Math.max(loose, ts - arrived);
      for (const cap of seenAt) { const d = ts - loose - cap; if (d > -2 && d < 10) { exact = ts - cap; break; } }
      const t = ts - (Number.isNaN(exact) ? loose : exact);
      return arrived - t >= 0 && arrived - t < 300 ? t : arrived; // a nonsense timestamp must never reach the predictor
    },
  };
}

// Preferred: inference in a worker, fed straight from the camera. Where the browser can stream a camera track into a
// worker, the page never touches a pixel: no copy, and no dependence on a main thread that is busy drawing the game.
// Otherwise frames are copied out of the <video> as ImageBitmaps, one in the tracker and the newest waiting behind it.
let worker: Worker | undefined;
async function startWorker(video: HTMLVideoElement, model: string, cam: MediaStreamTrack) {
  if (typeof OffscreenCanvas === 'undefined' || typeof createImageBitmap === 'undefined') return false;
  const w = new Worker(new URL('./pose.worker.ts', import.meta.url));
  const ready = await new Promise<string | null>((resolve) => {
    const giveUp = setTimeout(() => resolve(null), 25000);
    w.onerror = () => resolve(null);
    w.onmessage = (e) => (e.data.type === 'ready' || e.data.type === 'failed') && (clearTimeout(giveUp), resolve(e.data.type === 'ready' ? e.data.delegate : null));
    w.postMessage({ type: 'init', origin: location.origin, timeOrigin: performance.timeOrigin, model, n: nPlayers });
  });
  if (!ready) return w.terminate(), false;
  worker = w;
  perf.delegate = `${ready} worker`;

  const clock = frameClock();
  let busy = false, last = performance.now(), sent = 0, lastCam = 0, copying = false, aspect = 16 / 9, waiting: { bitmap: ImageBitmap; t: number } | null = null;
  const send = (frame: { bitmap: ImageBitmap; t: number }) => {
    busy = true;
    sent = frame.t = Math.max(sent + 1, frame.t); // the model wants strictly increasing timestamps
    w.postMessage({ type: 'frame', ...frame }, [frame.bitmap]);
  };
  w.onmessage = (e) => {
    const m = e.data;
    if (m.type === 'nostream') return void (copying = true, track.frames = 'copied');
    if (m.type === 'hand') {
      grip.busy = false;
      if (!m.found) return;
      grip.seenAt = performance.now();
      grip.curl = m.curl;
      grip.closed = grip.closed ? m.curl < tuning.openAt : m.curl < tuning.fistAt; // hysteresis: no flicker at the boundary
      return;
    }
    if (m.type !== 'pose') return;
    busy = false;
    if (waiting) { send(waiting); waiting = null; }
    const now = performance.now(), t = m.ts === undefined ? m.t : clock.time(m.ts, m.arrived);
    aspect = m.aspect ?? video.videoWidth / video.videoHeight;
    apply(m.landmarks, aspect, t);
    if (m.luma !== undefined) lumaTap?.(t, m.luma);
    tape?.push([Math.round(t), Math.round(now - t), m.landmarks.map((lm: NormalizedLandmark[]) => lm.flatMap((q) => [+q.x.toFixed(4), +q.y.toFixed(4), +(q.visibility ?? 1).toFixed(2)]))]);
    perf.fps += (1000 / (now - last) - perf.fps) * 0.1;
    track.lag += (now - t - track.lag) * 0.1;
    track.modelMs += (m.ms - track.modelMs) * 0.1;
    last = now;
    if (copying) void askGrip(video, w); else w.postMessage({ type: 'grip', rect: gripRect(aspect, 1) });
  };
  if (tuning.direct && typeof MediaStreamTrackProcessor === 'function')
    try {
      const { readable } = new MediaStreamTrackProcessor({ track: cam, maxBufferSize: 1 });
      w.postMessage({ type: 'stream', readable }, [readable as unknown as Transferable]);
      track.frames = 'direct';
    } catch { copying = true; }
  else copying = true;
  if (copying) track.frames = 'copied';
  // `captureTime` is when the sensor took the frame (same clock as performance.now): true frame spacing for the
  // speed estimate, and the true age of every reading for prediction — not the jittery moment the callback ran.
  // On the direct route this callback only keeps the clock; on the copy route it also lifts the frame out.
  const tick = async (now: number, meta?: VideoFrameCallbackMetadata) => {
    video.requestVideoFrameCallback(tick);
    track.camFps += (1000 / Math.max(1, now - lastCam) - track.camFps) * 0.1;
    lastCam = now;
    if (meta?.captureTime) clock.saw(meta.captureTime);
    if (!copying) return;
    const t0 = performance.now(), bitmap = await createImageBitmap(video).catch(() => null);
    if (!bitmap) return;
    track.grabMs += (performance.now() - t0 - track.grabMs) * 0.1;
    const frame = { bitmap, t: meta?.captureTime ?? now };
    if (!busy) return send(frame);
    waiting?.bitmap.close();
    waiting = frame;
  };
  video.requestVideoFrameCallback(tick);
  return true;
}

// A square around the pointing hand's palm (1.8 shoulder-widths across: the whole hand with margin, whatever the
// distance), as fractions of the unmirrored camera frame: [x, y, size ÷ frame width]. null = nobody is asking.
function gripRect(vw: number, vh: number) {
  const pl = players[0], palmAt = pl.palms[grip.hand];
  if (!grip.want || !pl.present || !pl.hands[grip.hand].seen || !palmAt) return null;
  const [ls, rs] = [pl.body[11], pl.body[12]];
  const size = Math.max(96 / 720 * vh, Math.min(vh, 1.8 * Math.hypot((ls[0] - rs[0]) * vw, (ls[1] - rs[1]) * vh)));
  const sx = Math.max(0, Math.min(vw - size, (1 - palmAt[0]) * vw - size / 2)); // palms are stored mirrored; the frame is not
  return [sx / vw, Math.max(0, Math.min(vh - size, palmAt[1] * vh - size / 2)) / vh, size / vw];
}
// Copy route only: cut the crop out of the <video> here and hand it over.
async function askGrip(video: HTMLVideoElement, w: Worker) {
  const vw = video.videoWidth, vh = video.videoHeight, rect = grip.busy ? null : gripRect(vw, vh);
  if (!rect) return;
  grip.busy = true;
  const px = Math.round(rect[2] * vw);
  const bitmap = await createImageBitmap(video, Math.round(rect[0] * vw), Math.round(rect[1] * vh), px, px, { resizeWidth: 224, resizeHeight: 224, resizeQuality: 'medium' }).catch(() => null);
  if (bitmap) w.postMessage({ type: 'hand', bitmap }, [bitmap]); else grip.busy = false;
}

// A tuning tape: every raw tracker result for a few seconds — [capture time, age on arrival, landmarks per body].
// Replayed on the build machine, it lets the filters be tuned against the real player in the real room.
let tape: unknown[] | null = null;
export function record(seconds: number) {
  tape = [];
  return new Promise<unknown[]>((resolve) => setTimeout(() => { resolve(tape ?? []); tape = null; }, seconds * 1000));
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

// Where a hand is *now*: its last reading pushed forward by how old that reading really is — its measured age in the
// page plus the delay the page cannot see (tuning.unseen). Straight-line extrapolation over ~200ms has one ugly
// failure: a hand that is slowing to reverse (every slice, every punch) gets thrown far past its turning point. So a
// braking hand is only ever carried as far as the spot where it would stop: v²/2a. Only deceleration beyond
// `brakeFrom` counts — the estimate is noisy, and a rule that flips on its sign would itself be a source of wobble.
// `cap`: the most lead this caller wants. Games take all of it; a pointer wants precision, not anticipation.
export function predict(hand: Hand, now = performance.now(), cap = tuning.maxLead) {
  const speed = Math.hypot(hand.vx, hand.vy), k = Math.max(0, Math.min(1, (speed - tuning.predictFrom) / (tuning.predictFull - tuning.predictFrom)));
  const lead = Math.min(cap, Math.max(0, (now - hand.t) / 1000) + (sim ? 0 : tuning.unseen)) * k * k * (3 - 2 * k);
  const carry = (v: number, a: number) => {
    const brake = Math.max(0, -a * Math.sign(v) - tuning.brakeFrom), l = brake > 0 ? Math.min(lead, Math.abs(v) / brake) : lead;
    return v * l - 0.5 * Math.sign(v) * brake * l * l;
  };
  return { x: Math.max(-1, Math.min(1, hand.x + carry(hand.vx, hand.ax))), y: Math.max(-1, Math.min(1, hand.y + carry(hand.vy, hand.ay))) };
}

// Measures tuning.unseen on the spot: the screen flashes white/black ~2x a second, the camera watches the room
// brighten and dim, and the delay from "page changed the screen" to "page received a picture that shows it" is exactly
// the part of the loop no timestamp can see — display chain + camera pipeline. One flash is buried in noise; twenty
// folded on top of each other are not. Returns ms, or null if the room never visibly changed (too bright / screen too small).
let lumaTap: ((t: number, luma: number) => void) | null = null;
export async function measureDelay(video: HTMLVideoElement, flips = 24) {
  const el = document.body.appendChild(Object.assign(document.createElement('div'), { style: 'position:fixed;inset:0;z-index:99;background:#000' }));
  const eye = new OffscreenCanvas(16, 9).getContext('2d', { willReadFrequently: true })!, samples: [number, number][] = [], marks: { t: number; on: boolean }[] = [];
  let running = true, on = false;
  const watch = (now: number) => {
    if (!running) return;
    eye.drawImage(video, 0, 0, 16, 9);
    const d = eye.getImageData(0, 0, 16, 9).data;
    let sum = 0;
    for (let i = 0; i < d.length; i += 4) sum += d[i] + d[i + 1] + d[i + 2];
    samples.push([now, sum / (d.length / 4) / 3]);
    video.requestVideoFrameCallback(watch);
  };
  // Watch through the tracker's own eyes where possible — the streamed frames, stamped as they reach the browser —
  // so the figure is the delay the tracker actually suffers, with the model running. Else through the <video>.
  if (worker && track.frames === 'direct') { lumaTap = (t, v) => samples.push([t, v]); worker.postMessage({ type: 'luma', on: true }); }
  else video.requestVideoFrameCallback(watch);
  for (let k = 0; k < flips; k++) {
    await new Promise((r) => requestAnimationFrame(r));
    on = !on; el.style.background = on ? '#fff' : '#000'; marks.push({ t: performance.now(), on });
    await new Promise((r) => setTimeout(r, 430 + Math.random() * 120)); // jittered, so nothing periodic in the room can line up with it
  }
  running = false; el.remove(); lumaTap = null; worker?.postMessage({ type: 'luma', on: false });
  // Fold: every flash's response, sign-corrected, in 10ms bins relative to its own flip.
  const bins: number[][] = Array.from({ length: 40 }, () => []);
  for (const m of marks.slice(2)) { // the first two are spent letting the camera's exposure settle
    const before = samples.filter(([t]) => t < m.t && t > m.t - 250).map(([, v]) => v);
    if (!before.length) continue;
    const base = before.reduce((a, b) => a + b) / before.length;
    for (const [t, v] of samples) { const dt = t - m.t; if (dt >= 0 && dt < 400) bins[Math.floor(dt / 10)].push((m.on ? 1 : -1) * (v - base)); }
  }
  const curve = bins.map((b) => (b.length ? b.reduce((a, c) => a + c) / b.length : NaN)), late = curve.slice(30).filter((v) => !Number.isNaN(v));
  const settled = late.reduce((a, b) => a + b, 0) / Math.max(1, late.length);
  if (Math.abs(settled) < 0.6) return null;
  const half = curve.findIndex((v) => !Number.isNaN(v) && v / settled > 0.5); // halfway up = the middle of the exposure that caught it
  return half < 0 ? null : half * 10 + 5;
}

// ?sim — the mouse is everyone's right hand; arrows jump/crouch/lean; A / D raise the left / right hand; F closes the fist.
// For building and checking games with no camera.
function startSim() {
  perf.delegate = 'sim';
  const keys = new Set<string>();
  const body = (e: KeyboardEvent) => {
    e.type === 'keydown' ? keys.add(e.key) : keys.delete(e.key);
    Object.assign(grip, { closed: keys.has('f'), seenAt: performance.now() }); // F = make a fist
    for (const pl of players.slice(0, nPlayers)) {
      pl.present = true;
      pl.lift = keys.has('ArrowUp') ? 0.6 : keys.has('ArrowDown') ? -1 : 0;
      pl.liftV = 0;
      pl.lean = keys.has('ArrowRight') ? 0.6 : keys.has('ArrowLeft') ? -0.6 : 0;
      pl.steer = Math.sign(pl.lean);
      pl.hands[0] = { x: -0.5, y: keys.has('a') ? 0.8 : -0.5, vx: 0, vy: 0, ax: 0, ay: 0, seen: true, t: performance.now() };
      if (keys.has('d') || e.key === 'd') pl.hands[1] = { x: 0.5, y: keys.has('d') ? 0.8 : -0.5, vx: 0, vy: 0, ax: 0, ay: 0, seen: true, t: performance.now() };
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
      pl.hands[1] = { x, y, vx: (x - was.x) / dt, vy: (y - was.y) / dt, ax: 0, ay: 0, seen: true, t: now };
    }
  });
  setInterval(() => { // a mouse at rest sends no events, so its last velocity would stick
    if (performance.now() - lastMove > 60) for (const pl of players) pl.hands[1] = { ...pl.hands[1], vx: 0, vy: 0, t: performance.now() };
  }, 30);
}
