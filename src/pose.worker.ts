// Tracking off the main thread, so a 20–60ms model run never stalls a render frame.
// Classic worker on purpose: MediaPipe's loader pulls its wasm glue in with importScripts(), which module
// workers do not have. Vite builds `new Worker(new URL(...))` without a type as exactly that.
import { FilesetResolver, HandLandmarker, PoseLandmarker } from '@mediapipe/tasks-vision';

type Fileset = Awaited<ReturnType<typeof FilesetResolver.forVisionTasks>>;
let fileset: Fileset, landmarker: PoseLandmarker | undefined, hands: HandLandmarker | null | undefined, origin = '';
const gpuThenCpu = <T,>(make: (delegate: 'GPU' | 'CPU') => Promise<T>) => make('GPU').then((v) => ({ v, delegate: 'GPU' }), () => make('CPU').then((v) => ({ v, delegate: 'CPU' })));

self.onmessage = async (e: MessageEvent) => {
  const m = e.data;
  if (m.type === 'init') {
    try {
      origin = m.origin;
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
  else if (m.type === 'frame' && landmarker) {
    const t0 = performance.now(), landmarks = landmarker.detectForVideo(m.bitmap, m.t).landmarks;
    m.bitmap.close();
    postMessage({ type: 'pose', landmarks, t: m.t, ms: performance.now() - t0 });
  } else if (m.type === 'hand') {
    // Fist or open palm, from a tight crop around one palm. Only ever asked for while a menu is up — never mid-game.
    // The hand model loads on first use; IMAGE mode because every crop is a different patch of the frame.
    if (hands === undefined)
      hands = await gpuThenCpu((delegate) => HandLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: `${origin}/models/hand_landmarker.task`, delegate }, runningMode: 'IMAGE', numHands: 1,
        minHandDetectionConfidence: 0.3, minHandPresenceConfidence: 0.3,
        ...(delegate === 'GPU' ? { canvas: new OffscreenCanvas(1, 1) } : {}),
      })).then((made) => made.v, () => null);
    const lm = hands?.detect(m.bitmap).landmarks[0];
    m.bitmap.close();
    if (!lm) return postMessage({ type: 'hand', found: false });
    // Curl: how far each fingertip is from the wrist, relative to its own knuckle. An open hand reads ~1.8–2.0
    // (tips far beyond the knuckles); a fist ~0.9–1.2 (tips folded back onto the palm). Scale-free, so distance is irrelevant.
    const far = (a: number, b: number) => Math.hypot(lm[a].x - lm[b].x, lm[a].y - lm[b].y);
    const curl = [[5, 8], [9, 12], [13, 16], [17, 20]].reduce((sum, [knuckle, tip]) => sum + far(tip, 0) / (far(knuckle, 0) || 1e-6), 0) / 4;
    postMessage({ type: 'hand', found: true, curl });
  }
};
