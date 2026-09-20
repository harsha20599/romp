// Tracking off the main thread, so a 20–60ms model run never stalls a render frame.
// Classic worker on purpose: MediaPipe's loader pulls its wasm glue in with importScripts(), which module
// workers do not have. Vite builds `new Worker(new URL(...))` without a type as exactly that.
import { CUT } from './cut.ts';
import { FilesetResolver, HandLandmarker, PoseLandmarker, type MPMask, type NormalizedLandmark } from '@mediapipe/tasks-vision';

type Fileset = Awaited<ReturnType<typeof FilesetResolver.forVisionTasks>>;
let fileset: Fileset, landmarker: PoseLandmarker | undefined, hands: HandLandmarker | null | undefined, origin = '';
let gpu = false;
let clockShift = 0; // worker clock → page clock: each has its own performance.now() zero
let wantLuma = false, lumaBuf = new Uint8Array(0); // delay calibration: report each frame's brightness alongside its pose
let gripRect: number[] | null = null; // [x, y, size] as fractions of the frame, while a menu wants the fist read
// Two players: this tracker looks at one side of the picture only, for one seat, with the light single-person model
// (`side`). Its partner — another worker like this one — takes the other side, so the two run side by side instead
// of one model doing twice the work per frame (which measured 105ms a frame on the tablet: 8 readings a second).
let half: { seat: number; x0: number; w: number } | null = null, side: PoseLandmarker | undefined, idle = false, relook = false, liteIsMain = false;
let wantCut = false, nPlayers = 1; // cut-outs: the camera picture of each player with the room removed — only while something on screen shows them
const glCanvas = new OffscreenCanvas(1, 1); // the pose model's GPU context lives on this canvas; the cut-outs are drawn with it too
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

// ---- cut-outs -------------------------------------------------------------------------------------------------------
// The player, lifted out of their room: for each player a fixed window around their body (so many shoulder-widths
// either side of, above and below the shoulders — the same body-relative frame every game input uses), drawn from
// the camera frame and from the model's own person mask for that frame. Frame and mask belong to the same instant,
// so the edge sits on the body even in a fast swing. Drawn on the model's GPU context (the mask is a texture there),
// side by side as [picture | mask] per player — no alpha channel to get lost on the way — and handed over as a bitmap.
let cutGl: { gl: WebGL2RenderingContext; program: WebGLProgram; vao: WebGLVertexArrayObject; tex: WebGLTexture; u: Record<string, WebGLUniformLocation | null> } | null | undefined;
function cutSetup() {
  const gl = glCanvas.getContext('webgl2') as WebGL2RenderingContext | null;
  if (!gl) return null;
  const shader = (type: number, src: string) => { const sh = gl.createShader(type)!; gl.shaderSource(sh, src); gl.compileShader(sh); return sh; };
  const program = gl.createProgram()!;
  gl.attachShader(program, shader(gl.VERTEX_SHADER, `#version 300 es
    out vec2 uv; void main() { vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2)); uv = p; gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0); }`));
  gl.attachShader(program, shader(gl.FRAGMENT_SHADER, `#version 300 es
    precision mediump float; in vec2 uv; out vec4 color;
    uniform sampler2D picture; uniform sampler2D mask; uniform vec4 window; uniform float flipMask; // window: u at the left edge, v at the top, u at the right edge, v at the bottom
    void main() {
      float half_ = step(0.5, uv.x), x = fract(uv.x * 2.0);
      vec2 at = vec2(mix(window.x, window.z, x), mix(window.w, window.y, uv.y));
      float inside = step(0.0, at.x) * step(at.x, 1.0) * step(0.0, at.y) * step(at.y, 1.0);
      vec2 m = vec2(at.x, mix(at.y, 1.0 - at.y, flipMask)), px = vec2(1.0 / 256.0);
      // The mask is 256px for the whole frame: a small blur turns its staircase into an edge.
      float a = (texture(mask, m).r * 2.0 + texture(mask, m + vec2(px.x, 0.0)).r + texture(mask, m - vec2(px.x, 0.0)).r + texture(mask, m + vec2(0.0, px.y)).r + texture(mask, m - vec2(0.0, px.y)).r) / 6.0;
      color = vec4(mix(texture(picture, at).rgb, vec3(a), half_) * inside, 1.0);
    }`));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return null;
  const u = Object.fromEntries(['picture', 'mask', 'window', 'flipMask'].map((name) => [name, gl.getUniformLocation(program, name)]));
  return { gl, program, vao: gl.createVertexArray()!, tex: gl.createTexture()!, u };
}
function compose(frame: VideoFrame, poses: NormalizedLandmark[][], masks: MPMask[]) {
  if (cutGl === undefined) cutGl = cutSetup();
  if (!cutGl) return null;
  const { gl, program, vao, tex, u } = cutGl, aspect = frame.displayWidth / frame.displayHeight;
  // Same seating rule as the page: the biggest n bodies play; screen-left (mirrored: the larger raw x) is player one.
  const slots = poses.map((lm, i) => ({ i, x: (lm[11].x + lm[12].x) / 2, y: (lm[11].y + lm[12].y) / 2, sw: Math.hypot((lm[11].x - lm[12].x) * aspect, lm[11].y - lm[12].y), ok: (lm[11].visibility ?? 1) >= 0.5 && (lm[12].visibility ?? 1) >= 0.5 }))
    .filter((s) => s.ok && masks[s.i]).sort((a, b) => b.sw - a.sw).slice(0, nPlayers).sort((a, b) => b.x - a.x);
  if (!slots.length) return null;
  const w = CUT.w * 2 * slots.length;
  if (glCanvas.width !== w || glCanvas.height !== CUT.h) { glCanvas.width = w; glCanvas.height = CUT.h; }
  // The model shares this context, so put back everything touched here.
  const was = { program: gl.getParameter(gl.CURRENT_PROGRAM), vao: gl.getParameter(gl.VERTEX_ARRAY_BINDING), fbo: gl.getParameter(gl.FRAMEBUFFER_BINDING), viewport: gl.getParameter(gl.VIEWPORT), active: gl.getParameter(gl.ACTIVE_TEXTURE), blend: gl.isEnabled(gl.BLEND), depth: gl.isEnabled(gl.DEPTH_TEST), scissor: gl.isEnabled(gl.SCISSOR_TEST), cull: gl.isEnabled(gl.CULL_FACE), flip: gl.getParameter(gl.UNPACK_FLIP_Y_WEBGL) };
  gl.activeTexture(gl.TEXTURE1); const was1 = gl.getParameter(gl.TEXTURE_BINDING_2D);
  gl.activeTexture(gl.TEXTURE0); const was0 = gl.getParameter(gl.TEXTURE_BINDING_2D);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.disable(gl.BLEND); gl.disable(gl.DEPTH_TEST); gl.disable(gl.SCISSOR_TEST); gl.disable(gl.CULL_FACE);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  gl.useProgram(program); gl.bindVertexArray(vao);
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, frame as unknown as TexImageSource);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.uniform1i(u.picture, 0); gl.uniform1i(u.mask, 1); gl.uniform1f(u.flipMask, 0);
  slots.forEach((s, k) => {
    gl.viewport(k * CUT.w * 2, 0, CUT.w * 2, CUT.h);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, masks[s.i].getAsWebGLTexture());
    // Mirrored, like everything on the TV: the left edge of the cut-out looks at the larger u.
    gl.uniform4f(u.window, s.x + (CUT.left * s.sw) / aspect, s.y - CUT.up * s.sw, s.x - (CUT.left * s.sw) / aspect, s.y + CUT.down * s.sw);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  });
  gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, was1);
  gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, was0);
  gl.activeTexture(was.active); gl.useProgram(was.program); gl.bindVertexArray(was.vao); gl.bindFramebuffer(gl.FRAMEBUFFER, was.fbo);
  gl.viewport(was.viewport[0], was.viewport[1], was.viewport[2], was.viewport[3]); gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, was.flip);
  if (was.blend) gl.enable(gl.BLEND); if (was.depth) gl.enable(gl.DEPTH_TEST); if (was.scissor) gl.enable(gl.SCISSOR_TEST); if (was.cull) gl.enable(gl.CULL_FACE);
  return { bitmap: glCanvas.transferToImageBitmap(), slots: slots.length };
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
    if (!landmarker || idle) { frame.close(); continue; }
    const arrived = performance.now() + clockShift, ts = frame.timestamp / 1000;
    first ||= ts - 1;
    sent = Math.max(sent + 1, ts - first); // the model wants strictly increasing timestamps
    try {
      const t0 = performance.now();
      let landmarks: NormalizedLandmark[][] = [], cut: ReturnType<typeof compose> = null, cutMs = 0;
      const mine = half, tracker = mine ? side : landmarker;
      if (mine && tracker) {
        // Cut this seat's side out of the frame (no copy: a view onto the same pixels), track in it, and put the
        // landmarks back into whole-frame coordinates so nothing downstream knows the difference.
        const vr = frame.visibleRect!, x = (vr.x + Math.round(mine.x0 * vr.width)) & ~1, w = Math.min(vr.x + vr.width - x, Math.round(mine.w * vr.width)) & ~1;
        const view = new VideoFrame(frame, { visibleRect: { x, y: vr.y, width: w, height: vr.height } });
        if (relook) { relook = false; tracker.detectForVideo(new ImageData(64, 64), sent); sent += 1; } // a blank frame makes it forget whoever it was following
        landmarks = tracker.detectForVideo(view, sent).landmarks.map((lm) => lm.map((q) => ({ ...q, x: (x - vr.x + q.x * w) / vr.width })));
        view.close();
      } else
      // With masks on, the result is only valid inside the callback (the masks are GPU textures the model reuses).
      if (wantCut && !mine) landmarker.detectForVideo(frame, sent, (r) => { landmarks = r.landmarks; const c0 = performance.now(); cut = r.segmentationMasks?.length ? compose(frame, r.landmarks, r.segmentationMasks) : null; cutMs = performance.now() - c0; });
      else if (!mine) landmarks = landmarker.detectForVideo(frame, sent).landmarks;
      const ms = performance.now() - t0 - cutMs;
      proven = true;
      let luma: number | undefined;
      if (wantLuma) { // the Y plane leads every camera format Chrome hands out (I420, NV12); a sparse sample of it is plenty
        if (lumaBuf.length < frame.allocationSize()) lumaBuf = new Uint8Array(frame.allocationSize());
        await frame.copyTo(lumaBuf);
        const n = frame.codedWidth * frame.codedHeight;
        let sum = 0, count = 0;
        for (let i = 0; i < n; i += 97) { sum += lumaBuf[i]; count++; }
        luma = sum / count;
      }
      const picture = cut as { bitmap: ImageBitmap; slots: number } | null; // (assigned inside the callback above)
      (postMessage as (message: unknown, transfer: Transferable[]) => void)({ type: 'pose', seat: mine?.seat, landmarks, ts, arrived, ms, cutMs, luma, aspect: frame.displayWidth / frame.displayHeight, cut: picture }, picture ? [picture.bitmap] : []);
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
      origin = m.origin; nPlayers = m.n;
      clockShift = performance.timeOrigin - m.timeOrigin;
      fileset = await FilesetResolver.forVisionTasks(`${origin}/wasm`);
      liteIsMain = String(m.model).includes('lite');
      const tryBoth = m.cpu ? <T,>(make: (delegate: 'GPU' | 'CPU') => Promise<T>) => make('CPU').then((v) => ({ v, delegate: 'CPU' })) : gpuThenCpu;
      const made = await tryBoth((delegate) => PoseLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: origin + m.model, delegate }, runningMode: 'VIDEO', numPoses: m.n,
        ...(delegate === 'GPU' ? { canvas: glCanvas } : {}),
      }));
      landmarker = made.v;
      gpu = made.delegate === 'GPU';
      postMessage({ type: 'ready', delegate: made.delegate });
    } catch (err) {
      postMessage({ type: 'failed', why: String(err) });
    }
  } else if (m.type === 'players') { nPlayers = m.n; await landmarker?.setOptions({ numPoses: m.n }); }
  else if (m.type === 'half') {
    if (m.seat < 0) { half = null; return; }
    if (liteIsMain) { side = landmarker; await landmarker?.setOptions({ numPoses: 1 }); }
    else side ??= (await gpuThenCpu((delegate) => PoseLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: `${origin}/models/pose_landmarker_lite.task`, delegate }, runningMode: 'VIDEO', numPoses: 1,
      ...(delegate === 'GPU' ? { canvas: new OffscreenCanvas(1, 1) } : {}),
    }))).v;
    half = { seat: m.seat, x0: m.x0, w: m.w };
  } else if (m.type === 'idle') idle = m.on;
  else if (m.type === 'relook') relook = true;
  else if (m.type === 'cut') { if (gpu && wantCut !== m.on) { wantCut = m.on; await landmarker?.setOptions({ outputSegmentationMasks: m.on }); } }
  else if (m.type === 'stream') void pump(m.readable);
  else if (m.type === 'grip') gripRect = m.rect;
  else if (m.type === 'luma') wantLuma = m.on;
  else if (m.type === 'frame' && landmarker) {
    const t0 = performance.now(), landmarks = landmarker.detectForVideo(m.bitmap, m.t).landmarks;
    m.bitmap.close();
    postMessage({ type: 'pose', landmarks, t: m.t, ms: performance.now() - t0 });
  } else if (m.type === 'hand') await readHand(m.bitmap);
};
