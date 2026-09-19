// Tracking off the main thread, so a 20–60ms model run never stalls a render frame.
// Classic worker on purpose: MediaPipe's loader pulls its wasm glue in with importScripts(), which module
// workers do not have. Vite builds `new Worker(new URL(...))` without a type as exactly that.
import { FilesetResolver, HandLandmarker, PoseLandmarker } from '@mediapipe/tasks-vision';

type Fileset = Awaited<ReturnType<typeof FilesetResolver.forVisionTasks>>;
let fileset: Fileset, landmarker: PoseLandmarker | undefined, hands: HandLandmarker | null | undefined, origin = '';
let clockShift = 0; // worker clock → page clock: each has its own performance.now() zero
let gripRect: number[] | null = null; // [x, y, size] as fractions of the frame, while a menu wants the fist read
const gpuThenCpu = <T,>(make: (delegate: 'GPU' | 'CPU') => Promise<T>) => make('GPU').then((v) => ({ v, delegate: 'GPU' }), () => make('CPU').then((v) => ({ v, delegate: 'CPU' })));

// Fist or open palm, from a tight crop around one palm. Only ever asked for while a menu is up — never mid-game.
// The hand model loads on first use; IMAGE mode because every crop is a different patch of the frame.
async function readHand(crop: ImageBitmap) {
  if (hands === undefined)
    hands = await gpuThenCpu((delegate) => HandLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: `${origin}/models/hand_landmarker.task`, delegate }, runningMode: 'IMAGE', numHands: 1,
      minHandDetectionConfidence: 0.3, minHandPresenceConfidence: 0.3,
      ...(delegate === 'GPU' ? { canvas: new OffscreenCanvas(1, 1) } : {}),
    })).then((made) => made.v, () => null);
  const lm = hands?.detect(crop).landmarks[0];
  crop.close();
  if (!lm) return postMessage({ type: 'hand', found: false });
  // Curl: how far each fingertip is from the wrist, relative to its own knuckle. An open hand reads ~1.8–2.0
  // (tips far beyond the knuckles); a fist ~0.9–1.2 (tips folded back onto the palm). Scale-free, so distance is irrelevant.
  const far = (a: number, b: number) => Math.hypot(lm[a].x - lm[b].x, lm[a].y - lm[b].y);
  const curl = [[5, 8], [9, 12], [13, 16], [17, 20]].reduce((sum, [knuckle, tip]) => sum + far(tip, 0) / (far(knuckle, 0) || 1e-6), 0) / 4;
  postMessage({ type: 'hand', found: true, curl });
}

// The direct route: camera frames arrive here as a stream, straight from the capture pipeline — the page never
// touches a pixel. The stream keeps only the newest frame, so after each model run the next read is the freshest
// frame there is: no copy, no hop through the (busy, rendering) main thread, no waiting for its next callback.
async function pump(readable: ReadableStream<VideoFrame>) {
  const reader = readable.getReader();
  let first = 0, sent = 0, proven = false;
  for (;;) {
    const { value: frame, done } = await reader.read();
    if (done || !frame) return;
    if (!landmarker) { frame.close(); continue; }
    const arrived = performance.now() + clockShift, ts = frame.timestamp / 1000;
    first ||= ts - 1;
    sent = Math.max(sent + 1, ts - first); // the model wants strictly increasing timestamps
    try {
      const t0 = performance.now(), landmarks = landmarker.detectForVideo(frame, sent).landmarks;
      proven = true;
      postMessage({ type: 'pose', landmarks, ts, arrived, ms: performance.now() - t0, aspect: frame.displayWidth / frame.displayHeight });
      if (gripRect) {
        const [x, y, size] = gripRect, w = frame.displayWidth, h = frame.displayHeight, px = Math.round(size * w);
        const crop = await createImageBitmap(frame, Math.round(x * w), Math.round(y * h), px, px, { resizeWidth: 224, resizeHeight: 224, resizeQuality: 'medium' }).catch(() => null);
        if (crop) await readHand(crop);
      }
    } catch (err) {
      // A browser that streams frames but cannot feed them to the model: say so once, and the page falls back to copies.
      if (!proven) { frame.close(); void reader.cancel(); return postMessage({ type: 'nostream', why: String(err) }); }
    }
    frame.close();
  }
}

self.onmessage = async (e: MessageEvent) => {
  const m = e.data;
  if (m.type === 'init') {
    try {
      origin = m.origin;
      clockShift = performance.timeOrigin - m.timeOrigin;
      fileset = await FilesetResolver.forVisionTasks(`${origin}/wasm`);
      const made = await gpuThenCpu((delegate) => PoseLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: origin + m.model, delegate }, runningMode: 'VIDEO', numPoses: m.n,
        ...(delegate === 'GPU' ? { canvas: new OffscreenCanvas(1, 1) } : {}),
      }));
      landmarker = made.v;
      postMessage({ type: 'ready', delegate: made.delegate });
    } catch (err) {
      postMessage({ type: 'failed', why: String(err) });
    }
  } else if (m.type === 'players') await landmarker?.setOptions({ numPoses: m.n });
  else if (m.type === 'stream') void pump(m.readable);
  else if (m.type === 'grip') gripRect = m.rect;
  else if (m.type === 'frame' && landmarker) {
    const t0 = performance.now(), landmarks = landmarker.detectForVideo(m.bitmap, m.t).landmarks;
    m.bitmap.close();
    postMessage({ type: 'pose', landmarks, t: m.t, ms: performance.now() - t0 });
  } else if (m.type === 'hand') await readHand(m.bitmap);
};
