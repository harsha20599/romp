// Pose inference off the main thread, so a 20–30ms model run never stalls a render frame.
// Classic worker on purpose: MediaPipe's loader pulls its wasm glue in with importScripts(), which module
// workers do not have. Vite builds `new Worker(new URL(...))` without a type as exactly that.
import { FilesetResolver, PoseLandmarker } from '@mediapipe/tasks-vision';

let landmarker: PoseLandmarker | undefined;
self.onmessage = async (e: MessageEvent) => {
  const m = e.data;
  if (m.type === 'init') {
    try {
      const fileset = await FilesetResolver.forVisionTasks(m.wasm);
      const make = (delegate: 'GPU' | 'CPU') =>
        PoseLandmarker.createFromOptions(fileset, {
          baseOptions: { modelAssetPath: m.model, delegate },
          runningMode: 'VIDEO',
          numPoses: m.n,
          ...(delegate === 'GPU' ? { canvas: new OffscreenCanvas(1, 1) } : {}),
        }).then((l) => ({ l, delegate }));
      const made = await make('GPU').catch(() => make('CPU'));
      landmarker = made.l;
      postMessage({ type: 'ready', delegate: made.delegate });
    } catch (err) {
      postMessage({ type: 'failed', why: String(err) });
    }
  } else if (m.type === 'players') await landmarker?.setOptions({ numPoses: m.n });
  else if (m.type === 'frame' && landmarker) {
    const landmarks = landmarker.detectForVideo(m.bitmap, m.t).landmarks;
    m.bitmap.close();
    postMessage({ type: 'pose', landmarks, t: m.t });
  }
};
