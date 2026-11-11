// Camera → MediaPipe Pose → up to two players with body-relative hands.
// Games read the mutable `players` array every frame; nothing here touches React.
import type { NormalizedLandmark, PoseLandmarker } from '@mediapipe/tasks-vision';

// x, y: -1..1 inside the player's own zone, y up. vx, vy: zone-units per second, measured at camera rate.
// t: when the camera frame behind this reading was captured (performance.now clock).
export type Hand = { x: number; y: number; vx: number; vy: number; seen: boolean; t: number };
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
  // The whole body, for games played with more than hands: every landmark (MediaPipe's numbering) as
  // [x, y, visibility, vx, vy], in shoulder-widths from the middle of the shoulders, x toward screen-right, y up.
  // Body-relative like everything else: walking about the room moves nothing here. Smoothed like the hands.
  rig: number[][];
  // Where the body frame itself is in the (mirrored) camera picture: shoulder midpoint and shoulder-width, in units of
  // the picture's height — x runs 0..aspect. Only the Mirror look needs it: there the game is drawn over the picture.
  frame: { x: number; y: number; sw: number; aspect: number };
};
export const JOINT = { head: 0, shoulders: [11, 12], elbows: [13, 14], wrists: [15, 16], hips: [23, 24], knees: [25, 26], ankles: [27, 28], toes: [31, 32] } as const; // pairs are [screen-left, screen-right]

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
  rigCalm: 4.5, rigQuick: 14, // the whole-body figure: it is looked at, not aimed with, so it may jitter a little but must never lag
  speedCut: 2.5, // the speed estimate that opens the smoothing filter up. Calm on purpose: a jumpy one lets rest-noise through.
  velocityCut: 5, // smoothing for the hand speed used by game hit detection
  // cutoff (Hz) on the speed estimate itself: higher = the filter notices the start of a move sooner
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
  direct: stored('romp.frames') !== 'copied', // stream camera frames straight into the tracker (off = copy them out of the <video>, the old route)
  // How players are shown in full-body games: 'camera' = their own picture, lifted out of the room; 'shadow' = the same
  // shape filled with their colour; 'avatar' = a drawn character from the skeleton (no mask needed: the cheapest).
  look: (['camera', 'mirror'].includes(stored('romp.look') ?? '') ? stored('romp.look') : 'shadow') as 'camera' | 'shadow' | 'mirror',
};

const mkPlayer = (): Player => ({
  present: false,
  hands: [{ x: 0, y: 0, vx: 0, vy: 0, seen: false, t: 0 }, { x: 0, y: 0, vx: 0, vy: 0, seen: false, t: 0 }],
  energy: 0,
  body: [],
  palms: [],
  lift: 0,
  liftV: 0,
  steer: 0,
  lean: 0,
  angles: null,
  rig: [],
  frame: { x: 0, y: 0, sw: 0.1, aspect: 16 / 9 },
});
export const players: [Player, Player] = [mkPlayer(), mkPlayer()];
export const perf = { fps: 0, delegate: '' };
queueMicrotask(() => Object.assign(globalThis, { __romp: { perf, track, tuning, players, grip } })); // a handle for DevTools over adb — read-only by convention
export const sim = new URLSearchParams(globalThis.location?.search ?? '').has('sim');

let nPlayers = 1;
export const playerCount = () => nPlayers;
let landmarker: PoseLandmarker | undefined;
export function setPlayers(n: number) {
  nPlayers = n;
  players[1].present &&= n === 2;
  void landmarker?.setOptions({ numPoses: n });
  if (worker && track.frames === 'direct') pairUp(n === 2);
  else worker?.postMessage({ type: 'players', n });
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
  x = NaN; dx = 0; v = 0; calm; quick; // dx controls smoothing; v measures hand speed
  constructor(calm: () => number, quick: () => number) { this.calm = calm; this.quick = quick; }
  next(v: number, dt: number) {
    if (Number.isNaN(this.x)) return (this.x = v);
    const alpha = (cutoff: number) => { const r = 2 * Math.PI * cutoff * dt; return r / (r + 1); };
    const raw = (v - this.x) / dt;
    this.dx += alpha(tuning.speedCut) * (raw - this.dx);
    this.v += alpha(tuning.velocityCut) * (raw - this.v);
    return (this.x += alpha(this.calm() + this.quick() * Math.abs(this.dx)) * (v - this.x));
  }
  reset() { this.x = NaN; this.dx = this.v = 0; }
}
const euro = (kind: 'hand' | 'body' | 'lift' | 'rig') => new OneEuro(() => tuning[`${kind}Calm`], () => tuning[`${kind}Quick`]);
const mkFilters = () => ({
  fx: euro('body'), fy: euro('body'), sw: euro('body'), lift: euro('lift'), lean: euro('lift'), steer: euro('lift'),
  hands: [0, 1].map(() => ({ x: euro('hand'), y: euro('hand'), lost: 0 })),
  rig: Array.from({ length: 33 }, () => [euro('rig'), euro('rig')]),
});
const filters = [mkFilters(), mkFilters()];
const resetFilters = (F: ReturnType<typeof mkFilters>) =>
  [F.fx, F.fy, F.sw, F.lift, F.lean, F.steer, ...F.hands.flatMap((h) => [h.x, h.y]), ...F.rig.flat()].forEach((f) => f.reset());

const prev: (NormalizedLandmark[] | null)[] = [null, null];
const lastApply = [0, 0], strangers = [0, 0]; // strangers: readings in a row that belonged to the other side
// Each player's own standing shoulder height: learned while they stand, re-learned if they walk to a new spot.
const stand = [{ y: NaN, x: NaN, since: 0, ratio: 0 }, { y: NaN, x: NaN, since: 0, ratio: 0 }];
// `now` is when the frame was captured, so every reading carries its true age and speeds use true frame spacing.
// With two players each has a tracker of their own, looking at their own side of the picture (see startWorker): a
// reading then arrives for one `seat` at a time, in its own rhythm. With one player, one tracker sees the whole frame.
function apply(poses: NormalizedLandmark[][], aspect: number, now = performance.now(), seat = -1) {
  const slots = seat < 0 ? assignSlots(poses, aspect, nPlayers) : [];
  if (seat >= 0) {
    // A tracker only speaks for its own side: a body whose shoulders are past the middle belongs to the other seat
    // (screen-left is the raw picture's right-hand side: the TV is a mirror).
    const lm = poses[0], mid = lm && seen(lm[L_SHOULDER]) && seen(lm[R_SHOULDER]) ? (lm[L_SHOULDER].x + lm[R_SHOULDER].x) / 2 : NaN;
    slots[seat] = (seat === 0 ? mid > 0.45 : mid < 0.55) ? lm : (undefined as never);
    strangers[seat] = lm && !slots[seat] ? strangers[seat] + 1 : 0;
  }
  players.forEach((pl, i) => {
    if (seat >= 0 && i !== seat) return;
    const dt = Math.min(0.2, Math.max(1e-3, (now - lastApply[i]) / 1000));
    lastApply[i] = now;
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
    pl.frame = { ...f, aspect };
    WRISTS.forEach((w, h) => {
      const hf = F.hands[h], r = handInZone(lm, w, aspect, nPlayers, f);
      if (r.seen) {
        hf.lost = 0;
        pl.hands[h] = { x: hf.x.next(r.x, dt), y: hf.y.next(r.y, dt), vx: hf.x.v, vy: hf.y.v, seen: true, t: now };
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
    pl.liftV = F.lift.dx;
    pl.lean = F.lean.next(leanOf(lm, aspect), dt);
    // Steering: where you started is centre (re-learned very slowly, ~20s, so it follows you across a session
    // but not across a lane change). Lean and side-step add up, so either way of "going left" works.
    if (Number.isNaN(st.x)) st.x = raw.x;
    st.x += (raw.x - st.x) * 0.0015;
    pl.steer = F.steer.next(Math.max(-1, Math.min(1, pl.lean / tuning.leanFull + (raw.x - st.x) / f.sw / tuning.shiftFull)), dt);
    pl.angles = limbAngles(lm, aspect);
    // The player's left is on screen-left (the TV is a mirror), so MediaPipe's odd (left) indices are screen-left too.
    pl.rig = lm.map((q, k) => {
      const [fx, fy] = F.rig[k], x = fx.next((mx(q, aspect) - f.x) / f.sw, dt), y = fy.next((f.y - q.y) / f.sw, dt);
      return [x, y, q.visibility ?? 1, fx.v, fy.v];
    });

    const was = prev[i];
    if (was)
      for (const k of ENERGY_POINTS) {
        const d = Math.hypot((lm[k].x - was[k].x) * aspect, lm[k].y - was[k].y) / f.sw;
        if (d > tuning.energyDeadband && d < 1) pl.energy += d; // d >= 1 is a slot swap, not movement
      }
    prev[i] = lm;
  });
}

// The players' cut-outs (see pose.worker.ts compose): the newest picture, how many players are in it, and a counter that
// goes up with each one. `want` is a count of things on screen showing a cut-out; the mask costs GPU time, so it is
// only computed while that is above zero. `ok` turns true once a picture has actually arrived on this device.
export const cutout = { bitmap: null as ImageBitmap | null, slots: 0, seq: 0, ms: 0, ok: false, asked: false, dropped: false, slowFor: 0 };
let cutWanted = 0;
export function wantCutout(on: boolean) {
  cutWanted = Math.max(0, cutWanted + (on ? 1 : -1));
  const ask = cutWanted > 0 && tuning.look === 'camera' && nPlayers === 1;
  if (ask !== cutout.asked) { cutout.asked = ask; worker?.postMessage({ type: 'cut', on: ask }); }
}

// camFps vs the pose fps tells you which side is the bottleneck; grab = copying the frame out, model = the tracker itself.
export const track = { lag: 0, camera: '', camFps: 0, grabMs: 0, modelMs: 0, frames: '', partner: '', fps2: 0, model2: 0 }; // partner/fps2/model2: player two's own tracker // frames: 'direct' (streamed to the tracker) or 'copied'

// Fist-to-press. The pose model cannot see fingers, so while a menu wants it (`want`), the palm of the pointing hand
// is cropped out of the frame and sent to a hand model after each pose result. Games never set `want`: zero cost in play.
export const grip = { want: false, hand: 1, closed: false, curl: 0, seenAt: 0, busy: false }; // ms from camera frame to usable pose — shown next to the fps on the home screen

export const feed = { video: null as HTMLVideoElement | null }; // the live camera element, for the Mirror look
export async function startPose(video: HTMLVideoElement) {
  feed.video = video;
  if (landmarker || worker || sim) return sim ? startSim() : undefined;
  // Standard camera capture; exposure and focus are managed by the browser.
  const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: 1280, height: 720, frameRate: { ideal: 30 } } });
  video.srcObject = stream;
  const cam = stream.getVideoTracks()[0];
  await video.play();
  const settings = cam.getSettings();
  track.camera = `${settings.width}×${settings.height} @${Math.round(settings.frameRate ?? 0)}`;
  const model = `/models/pose_landmarker_${tuning.model}.task`;
  if (!(await startWorker(video, model, cam).catch(() => false))) await startInline(video, model);
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
      return arrived - t >= 0 && arrived - t < 300 ? t : arrived; // ignore nonsensical capture timestamps
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
  camTrack = cam;
  perf.delegate = `${ready} worker`;
  if (cutout.asked) w.postMessage({ type: 'cut', on: true });

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
    apply(m.landmarks, aspect, t, m.seat ?? -1);
    if (m.seat === 0 && strangers[0] > 20) { strangers[0] = 0; w.postMessage({ type: 'relook' }); }
    perf.fps += (1000 / (now - last) - perf.fps) * 0.1;
    track.lag += (now - t - track.lag) * 0.1;
    track.modelMs += (m.ms - track.modelMs) * 0.1;
    // The mask is a luxury. If the tracker cannot hold ~17 frames a second with it on, for four seconds running,
    // it goes — for the rest of the session — and players are drawn as characters instead. Tracking speed is the game.
    // (Not when the look was chosen by hand on the Tracking screen: then it is the player's call.)
    if (cutout.asked) {
      cutout.slowFor = perf.fps < 17 ? cutout.slowFor + (now - last) / 1000 : 0;
      if (cutout.slowFor > 4) { cutout.dropped = true; cutout.asked = false; tuning.look = 'shadow'; w.postMessage({ type: 'cut', on: false }); }
    }
    if (m.cut) { cutout.bitmap?.close(); Object.assign(cutout, { bitmap: m.cut.bitmap, slots: m.cut.slots, seq: cutout.seq + 1, ok: true }); cutout.ms += (m.cutMs - cutout.ms) * 0.1; }
    else if (cutout.bitmap && !cutout.asked) { cutout.bitmap.close(); cutout.bitmap = null; cutout.slots = 0; }
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
  if (nPlayers === 2 && !copying) pairUp(true);
  // `captureTime` is when the sensor took the frame (same clock as performance.now): true frame spacing for the
  // speed estimate and the age of each reading — not the jittery moment the callback ran.
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

// Two players, two trackers. The first worker keeps the GPU and takes player one's side of the picture; a second
// worker runs the light model on the CPU and takes player two's — so they work at the same time instead of queueing
// for one GPU. Each gets its own copy of the camera track's frames. The sides overlap a little in the middle so an
// arm reaching toward the partner is not cut off. (Only on the direct route: copied frames go to one worker.)
let partner: Worker | null = null, camTrack: MediaStreamTrack | null = null;
const SIDES = [{ x0: 0.42, w: 0.58 }, { x0: 0, w: 0.58 }]; // raw picture: seat 0 (screen-left) is its right-hand side
function pairUp(on: boolean) {
  worker?.postMessage(on ? { type: 'half', seat: 0, ...SIDES[0] } : { type: 'half', seat: -1 });
  worker?.postMessage({ type: 'players', n: 1 });
  if (!on) return void partner?.postMessage({ type: 'idle', on: true });
  if (partner) return void partner.postMessage({ type: 'idle', on: false });
  if (!camTrack || typeof MediaStreamTrackProcessor !== 'function') return;
  const w = (partner = new Worker(new URL('./pose.worker.ts', import.meta.url))), clock = frameClock();
  let last = performance.now();
  w.onmessage = (e) => {
    const m = e.data;
    if (m.type === 'ready') {
      const { readable } = new MediaStreamTrackProcessor({ track: camTrack!.clone(), maxBufferSize: 1 });
      w.postMessage({ type: 'half', seat: 1, ...SIDES[1] });
      w.postMessage({ type: 'stream', readable }, [readable as unknown as Transferable]);
      track.partner = m.delegate;
    }
    if (m.type !== 'pose') return;
    const now = performance.now();
    apply(m.landmarks, m.aspect, clock.time(m.ts, m.arrived), 1);
    if (strangers[1] > 20) { strangers[1] = 0; w.postMessage({ type: 'relook' }); }
    track.fps2 += (1000 / (now - last) - track.fps2) * 0.1; track.model2 += (m.ms - track.model2) * 0.1;
    last = now;
  };
  w.postMessage({ type: 'init', origin: location.origin, timeOrigin: performance.timeOrigin, model: '/models/pose_landmarker_lite.task', n: 1, cpu: true });
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
      pl.hands[0] = { x: -0.5, y: keys.has('a') || keys.has('j') ? 0.8 : -0.5, vx: 0, vy: 0, seen: true, t: performance.now() };
      if (keys.has('d') || e.key === 'd' || e.key === 'j') pl.hands[1] = { x: 0.5, y: keys.has('d') || keys.has('j') ? 0.8 : -0.5, vx: 0, vy: 0, seen: true, t: performance.now() };
    }
  };
  addEventListener('keydown', body);
  addEventListener('keyup', body);
  // A stand-in body for the games that use all of it: the hands go where the sim hands are, Z / C swing a foot out,
  // Q / E lift a knee, arrows move the rest. Enough to play every game with a keyboard and a mouse.
  const pose = () => {
    for (const pl of players.slice(0, nPlayers)) {
      const rig: number[][] = Array.from({ length: 33 }, () => [0, 0, 1, 0, 0]), dy = pl.lift * 0.8, dx = pl.lean;
      const set = (k: number, x: number, y: number) => { rig[k][3] = pl.rig[k] ? (x - pl.rig[k][0]) * 60 : 0; rig[k][4] = pl.rig[k] ? (y - pl.rig[k][1]) * 60 : 0; rig[k][0] = x; rig[k][1] = y; };
      set(0, dx, 0.75 + dy);
      [-1, 1].forEach((side, h) => {
        const hand = pl.hands[h], knee = keys.has(h ? 'e' : 'q'), kick = keys.has(h ? 'c' : 'z') || keys.has('j'); // J = a jumping jack
        set(11 + h, side * 0.5 + dx * 0.8, dy); set(23 + h, side * 0.3, -1.6 + dy * 0.6);
        set(15 + h, hand.x * tuning.reachX[nPlayers - 1] + dx, hand.y * tuning.reachY + tuning.centerY + dy); set(19 + h, rig[15 + h][0], rig[15 + h][1]); set(13 + h, (rig[15 + h][0] + rig[11 + h][0]) / 2, (rig[15 + h][1] + rig[11 + h][1]) / 2 - 0.2);
        set(25 + h, side * (knee ? 0.5 : 0.32), knee ? -1.5 : -2.7 + dy * 0.3); set(27 + h, side * (keys.has('j') ? 0.95 : kick ? 1.5 : 0.35), keys.has('j') ? -3.8 : kick ? -2.6 : knee ? -2.5 : -3.8); set(31 + h, rig[27 + h][0] + side * 0.25, rig[27 + h][1] - 0.1);
      });
      pl.rig = rig;
    }
    requestAnimationFrame(pose);
  };
  requestAnimationFrame(pose);
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
