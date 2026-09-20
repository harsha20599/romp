// The renderer: one PlayCanvas app and one canvas for the whole session. A game builds its scene under a root entity
// and hands back a tick; when the round ends the root is destroyed and the app idles. Keeping one GL context alive
// means shaders compiled in round one are still compiled in round ten, and a low-memory phone never has to
// re-create a context mid-session. Only the engine parts we use are imported, so the rest is tree-shaken away.
import {
  AppBase, AppOptions, WebglGraphicsDevice, RenderComponentSystem, CameraComponentSystem, LightComponentSystem, AnimComponentSystem,
  ContainerHandler, TextureHandler, Entity, Color, Mesh, MeshInstance, StandardMaterial, ShaderMaterial, VertexBuffer, VertexFormat, CameraFrame,
  SphereGeometry, BoxGeometry, CylinderGeometry, ConeGeometry, CapsuleGeometry, TorusGeometry, BoundingBox, Mat4, Vec3, Quat,
  FILLMODE_NONE, RESOLUTION_AUTO, PROJECTION_ORTHOGRAPHIC, PROJECTION_PERSPECTIVE, GAMMA_SRGB, TONEMAP_LINEAR, FOG_LINEAR, FOG_NONE,
  BLEND_NORMAL, CULLFACE_NONE, SEMANTIC_POSITION, SEMANTIC_ATTR12, SEMANTIC_ATTR13, TYPE_FLOAT32, BUFFER_DYNAMIC, SHADERLANGUAGE_GLSL, CHUNKAPI_2_8,
  type Asset, type Geometry, type Material, type ContainerResource, type GraphNode,
} from 'playcanvas';
import { effects, pace } from './pace.ts';

export const W = 16, H = 9;
export type View = { position: [number, number, number]; fov: number; near: number; far: number; lookAt?: [number, number, number] };


const canvas = document.createElement('canvas');
canvas.style.cssText = 'display:block;width:100%;height:100%';
const device = new WebglGraphicsDevice(canvas, { alpha: true, antialias: true, powerPreference: 'high-performance' });
export const app = new AppBase(canvas);
{
  const options = new AppOptions();
  options.graphicsDevice = device;
  options.componentSystems = [RenderComponentSystem, CameraComponentSystem, LightComponentSystem, AnimComponentSystem];
  options.resourceHandlers = [TextureHandler, ContainerHandler];
  app.init(options);
  app.setCanvasFillMode(FILLMODE_NONE);
  app.setCanvasResolution(RESOLUTION_AUTO);
  app.autoRender = false; // nothing to draw until a game mounts
  app.start();
  Object.assign(window, { __pc: app }); // DevTools handle, like __romp
}

// Quality steps down by itself, once, for the rest of the session: if the frame rate sags, drop to 1x resolution and
// lose the bloom. Responsiveness beats gloss — and a device that could not hold it in one game will not in the next.
const quality = { slow: 0, last: 0 };
const pixelRatio = () => (device.maxPixelRatio = pace.lean ? 1 : Math.min(window.devicePixelRatio || 1, 1.25));
pixelRatio();

// ---- colour ---------------------------------------------------------------------------------------------------------
const colors = new Map<string, Color>(), linears = new Map<string, Float32Array>();
export const color = (hex: string) => colors.get(hex) ?? (colors.set(hex, new Color().fromString(hex)), colors.get(hex)!);
// Uniforms set straight on a mesh instance skip the material's own sRGB→linear step, so do it here (cached per colour).
const linear = (hex: string) => {
  let v = linears.get(hex);
  if (!v) { const c = color(hex); linears.set(hex, (v = new Float32Array([c.r, c.g, c.b].map((s) => (s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4))))); }
  return v;
};

// ---- things a round owns, freed when it ends -------------------------------------------------------------------------
let owned: { destroy: () => void }[] = [];
export const own = <T extends { destroy: () => void }>(thing: T) => (owned.push(thing), thing);

// ---- materials ------------------------------------------------------------------------------------------------------
type Look = { opacity?: number; twoSided?: boolean; emissive?: string; glow?: number; fog?: boolean };
const finish = (m: StandardMaterial, look: Look) => {
  m.useFog = look.fog ?? true;
  if (look.opacity !== undefined) { m.opacity = look.opacity; m.blendType = BLEND_NORMAL; }
  if (look.twoSided) m.cull = CULLFACE_NONE;
  m.update();
  return own(m);
};
// Unlit: the colour is the colour, whatever the lights are doing. Pass `opacity` for anything that will ever fade.
export function flat(hex: string, look: Look = {}) {
  const m = new StandardMaterial();
  m.useLighting = false; m.useSkybox = false;
  m.diffuse = color('#000000'); m.emissive = color(hex);
  return finish(m, look);
}
// Lit, matte. `emissive` + `glow` make it shine (and bloom).
export function lit(hex: string, look: Look = {}) {
  const m = new StandardMaterial();
  m.useMetalness = false; m.specular = color('#000000'); m.gloss = 0; m.useSkybox = false;
  m.diffuse = color(hex);
  if (look.emissive) { m.emissive = color(look.emissive); m.emissiveIntensity = look.glow ?? 1; }
  return finish(m, look);
}
const instancesOf = (e: Entity) => (e.findComponents('render') as unknown as { meshInstances: MeshInstance[] }[]).flatMap((r) => r.meshInstances);
// Per-object colour and opacity without a material each: set on the mesh instance, the shared material stays shared.
export const tint = (e: Entity, hex: string, slot: 'emissive' | 'diffuse' = 'emissive') => { for (const mi of instancesOf(e)) mi.setParameter(`material_${slot}`, linear(hex)); };
export const fade = (e: Entity, opacity: number) => { for (const mi of instancesOf(e)) mi.setParameter('material_opacity', opacity); };
export const show = (e: Entity, on: boolean) => { if (e.enabled !== on) e.enabled = on; return on; };

// ---- meshes ---------------------------------------------------------------------------------------------------------
function meshOf(positions: number[], normals: number[], indices?: number[]) {
  const m = new Mesh(device);
  m.setPositions(positions); m.setNormals(normals);
  if (indices) m.setIndices(indices);
  m.update();
  return own(m);
}
const fromGeometry = (g: Geometry, bake?: Mat4) => {
  if (bake && g.positions) {
    const p = g.positions as number[], nrm = g.normals as number[] | undefined, v = new Vec3();
    for (let i = 0; i < p.length; i += 3) { bake.transformPoint(v.set(p[i], p[i + 1], p[i + 2]), v); p[i] = v.x; p[i + 1] = v.y; p[i + 2] = v.z; }
    if (nrm) for (let i = 0; i < nrm.length; i += 3) { bake.transformVector(v.set(nrm[i], nrm[i + 1], nrm[i + 2]), v).normalize(); nrm[i] = v.x; nrm[i + 1] = v.y; nrm[i + 2] = v.z; }
  }
  return own(Mesh.fromGeometry(device, g));
};
export const shapes = {
  // Flat shapes face the camera (+z), unlike the engine's own plane which lies on the floor.
  quad: (w: number, h: number) => meshOf([-w / 2, -h / 2, 0, w / 2, -h / 2, 0, w / 2, h / 2, 0, -w / 2, h / 2, 0], [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1], [0, 1, 2, 0, 2, 3]),
  floor: (w: number, d: number) => meshOf([-w / 2, 0, d / 2, w / 2, 0, d / 2, w / 2, 0, -d / 2, -w / 2, 0, -d / 2], [0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0], [0, 1, 2, 0, 2, 3]),
  circle: (r: number, segments: number) => {
    const p = [0, 0, 0], nrm = [0, 0, 1], idx: number[] = [];
    for (let k = 0; k <= segments; k++) { const a = (k / segments) * Math.PI * 2; p.push(Math.cos(a) * r, Math.sin(a) * r, 0); nrm.push(0, 0, 1); if (k) idx.push(0, k, k + 1); }
    return meshOf(p, nrm, idx);
  },
  ring: (inner: number, outer: number, segments: number, start = 0) => {
    const p: number[] = [], nrm: number[] = [], idx: number[] = [];
    for (let k = 0; k <= segments; k++) {
      const a = start + (k / segments) * Math.PI * 2, c = Math.cos(a), s = Math.sin(a);
      p.push(c * inner, s * inner, 0, c * outer, s * outer, 0); nrm.push(0, 0, 1, 0, 0, 1);
      if (k) idx.push(2 * k - 2, 2 * k - 1, 2 * k + 1, 2 * k - 2, 2 * k + 1, 2 * k);
    }
    return meshOf(p, nrm, idx);
  },
  // A faceted ball: an icosahedron, each face split `detail` times, every face with its own normal.
  facets: (r: number, detail = 0) => {
    const t = (1 + Math.sqrt(5)) / 2, v = [[-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0], [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t], [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1]];
    let faces = [[0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11], [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8], [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9], [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1]].map((f) => f.map((i) => v[i]));
    const mid = (a: number[], b: number[]) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
    for (let d = 0; d < detail; d++) faces = faces.flatMap(([a, b, c]) => { const ab = mid(a, b), bc = mid(b, c), ca = mid(c, a); return [[a, ab, ca], [b, bc, ab], [c, ca, bc], [ab, bc, ca]]; });
    const p: number[] = [], nrm: number[] = [];
    for (const face of faces) {
      const on = face.map((q) => { const l = Math.hypot(q[0], q[1], q[2]); return [(q[0] / l) * r, (q[1] / l) * r, (q[2] / l) * r]; });
      const [a, b, c] = on, ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], wx = c[0] - a[0], wy = c[1] - a[1], wz = c[2] - a[2];
      const n = [uy * wz - uz * wy, uz * wx - ux * wz, ux * wy - uy * wx], l = Math.hypot(n[0], n[1], n[2]);
      for (const q of on) { p.push(...q); nrm.push(n[0] / l, n[1] / l, n[2] / l); }
    }
    return meshOf(p, nrm);
  },
  sphere: (radius: number, bands = 12) => fromGeometry(new SphereGeometry({ radius, latitudeBands: bands, longitudeBands: bands })),
  box: (w: number, h: number, d: number) => fromGeometry(new BoxGeometry({ halfExtents: new Vec3(w / 2, h / 2, d / 2) })),
  cylinder: (radius: number, height: number, sides = 16) => fromGeometry(new CylinderGeometry({ radius, height, capSegments: sides })),
  cone: (radius: number, height: number, sides = 16) => fromGeometry(new ConeGeometry({ baseRadius: radius, peakRadius: 0, height, capSegments: sides })),
  // A rounded limb lying along +x that pivots at its near end: its straight part runs from x=0 to x=1, so scale.x is its length.
  limb: (radius: number) => fromGeometry(new CapsuleGeometry({ radius, height: 1 + radius * 2, sides: 10, heightSegments: 1 }), new Mat4().setTRS(new Vec3(0.5, 0, 0), new Quat().setFromEulerAngles(0, 0, -90), Vec3.ONE)),
  capsule: (radius: number, height: number) => fromGeometry(new CapsuleGeometry({ radius, height, sides: 12, heightSegments: 1 })),
  // Half a torus standing up in the xy plane (the engine's lies flat), like a horseshoe magnet.
  arch: (ring: number, tube: number) => fromGeometry(new TorusGeometry({ ringRadius: ring, tubeRadius: tube, sectorAngle: 180, segments: 20, sides: 8 }), new Mat4().setFromEulerAngles(90, 0, 0)),
};

// An entity under `parent`, optionally with a mesh. Shadows are off everywhere: nothing here casts or receives them.
export function node(parent: GraphNode, mesh?: Mesh, material?: Material, at?: [number, number, number]) {
  const e = new Entity();
  if (mesh && material) e.addComponent('render', { meshInstances: [new MeshInstance(mesh, material)], castShadows: false, receiveShadows: false });
  if (at) e.setLocalPosition(...at);
  parent.addChild(e);
  return e;
}

// ---- models ---------------------------------------------------------------------------------------------------------
const loading = new Map<string, Promise<Asset>>();
export const glb = (url: string) => {
  let p = loading.get(url);
  if (!p) loading.set(url, (p = new Promise((resolve, reject) => app.assets.loadFromUrl(url, 'container', (err, asset) => (err || !asset ? reject(new Error(String(err))) : resolve(asset))))));
  return p;
};
export const boundsOf = (e: Entity) => {
  e.syncHierarchy();
  const box = new BoundingBox();
  instancesOf(e).forEach((mi, i) => (i ? box.add(mi.aabb) : box.copy(mi.aabb)));
  return box;
};
const quiet = (e: Entity) => { for (const r of e.findComponents('render') as unknown as { castShadows: boolean; receiveShadows: boolean }[]) r.castShadows = r.receiveShadows = false; return e; };
// A loaded model, scaled so its largest side is `size` and re-centred on its own origin (y on the floor if `floor`).
// What comes back is a template that is never drawn: `.clone()` it for every copy you want on stage.
export async function fitted(url: string, size: number, floor = false) {
  const inner = quiet(((await glb(url)).resource as ContainerResource).instantiateRenderEntity()), box = boundsOf(inner);
  const k = size / Math.max(box.halfExtents.x, box.halfExtents.y, box.halfExtents.z) / 2, root = new Entity(), mid = new Entity();
  mid.setLocalPosition(-box.center.x * k, floor ? -(box.center.y - box.halfExtents.y) * k : -box.center.y * k, -box.center.z * k);
  mid.setLocalScale(k, k, k);
  mid.addChild(inner); root.addChild(mid);
  return own(root);
}
export const instantiate = async (url: string) => { const asset = await glb(url); return { entity: quiet((asset.resource as ContainerResource).instantiateRenderEntity()), asset }; };

// Give every mesh under `e` its own copy of its material that can be cut by a plane: setClip(e, nx, ny, nz, w) keeps
// the side where n·p + w > 0. Used by Slice, where each half of a fruit is the whole fruit minus the other side.
export function clippable(e: Entity) {
  for (const mi of instancesOf(e)) {
    const m = own(mi.material.clone()) as StandardMaterial, chunks = m.getShaderChunks(SHADERLANGUAGE_GLSL);
    m.shaderChunksVersion = CHUNKAPI_2_8;
    chunks.set('litUserDeclarationPS', 'uniform vec4 uClip;');
    chunks.set('litUserMainStartPS', 'if (dot(vPositionW, uClip.xyz) + uClip.w < 0.0) discard;');
    m.cull = CULLFACE_NONE;
    m.update();
    mi.material = m;
    mi.setParameter('uClip', [0, 0, 0, 1]);
  }
}
const clip = new Float32Array(4);
export function setClip(e: Entity, nx: number, ny: number, nz: number, w: number) {
  clip[0] = nx; clip[1] = ny; clip[2] = nz; clip[3] = w;
  for (const mi of instancesOf(e)) mi.setParameter('uClip', clip);
}

// ---- many small things, one draw call --------------------------------------------------------------------------------
// Every instance is a position, a uniform scale and a colour. Bursts, stars and Wipe's tiles are all this.
const dots = () => {
  const m = new ShaderMaterial({
    uniqueName: 'romp-dots',
    attributes: { vertex_position: SEMANTIC_POSITION, aPlace: SEMANTIC_ATTR12, aColor: SEMANTIC_ATTR13 },
    vertexGLSL: `attribute vec3 vertex_position; attribute vec4 aPlace; attribute vec4 aColor;
      uniform mat4 matrix_model; uniform mat4 matrix_viewProjection; varying vec4 vColor;
      void main(void) { vColor = aColor; gl_Position = matrix_viewProjection * matrix_model * vec4(vertex_position * aPlace.w + aPlace.xyz, 1.0); }`,
    fragmentGLSL: `#include "gammaPS"
      varying vec4 vColor;
      void main(void) { gl_FragColor = vec4(gammaCorrectOutput(vColor.rgb), vColor.a); }`,
  });
  return m;
};
export function instanced(parent: GraphNode, mesh: Mesh, count: number, opacity = 1) {
  const material = own(dots());
  if (opacity < 1) material.blendType = BLEND_NORMAL;
  material.cull = CULLFACE_NONE;
  material.update();
  const format = new VertexFormat(device, [{ semantic: SEMANTIC_ATTR12, components: 4, type: TYPE_FLOAT32 }, { semantic: SEMANTIC_ATTR13, components: 4, type: TYPE_FLOAT32 }]);
  const data = new Float32Array(count * 8), buffer = own(new VertexBuffer(device, format, count, { usage: BUFFER_DYNAMIC, data: data.buffer as ArrayBuffer }));
  const mi = new MeshInstance(mesh, material);
  mi.setInstancing(buffer); // also switches culling off for it: its bounds say nothing about where the instances are
  const e = new Entity();
  e.addComponent('render', { meshInstances: [mi], castShadows: false, receiveShadows: false });
  parent.addChild(e);
  for (let i = 0; i < count; i++) data[i * 8 + 7] = opacity;
  return {
    entity: e,
    place(i: number, x: number, y: number, z: number, scale: number) { const o = i * 8; data[o] = x; data[o + 1] = y; data[o + 2] = z; data[o + 3] = scale; },
    paint(i: number, hex: string) { data.set(linear(hex), i * 8 + 4); },
    commit() { buffer.setData(data.buffer as ArrayBuffer); },
  };
}

// A strip of triangles rewritten every frame (the hand ribbons).
export function ribbon(parent: GraphNode, points: number, material: Material) {
  const mesh = own(new Mesh(device)), positions = new Float32Array(points * 6), indices: number[] = [];
  for (let k = 0; k < points - 1; k++) indices.push(2 * k, 2 * k + 1, 2 * k + 2, 2 * k + 1, 2 * k + 3, 2 * k + 2);
  mesh.setPositions(positions); mesh.setIndices(indices); mesh.update();
  const e = node(parent, mesh, material);
  (e.render!.meshInstances[0]).cull = false; // rewritten every frame; cached bounds would be stale
  return { entity: e, positions, commit() { mesh.setPositions(positions); mesh.update(undefined, false); } };
}

// ---- a round --------------------------------------------------------------------------------------------------------
export type Scene = { root: Entity; camera: Entity; ambient: (hex: string, k?: number) => void; sky: (hex: string | null) => void; fog: (hex: string, start: number, end: number) => void };
type Tick = (dt: number) => void;
let live: { root: Entity; frame?: CameraFrame; tick?: Tick; t: number; warm: number; hidden: GraphNode[] } | null = null;
let paused = false;

const compiled = () => (device as unknown as { _shaderStats: { linked: number } })._shaderStats.linked;

// Hit-stop: on a big impact the game's clock all but stops for a few frames. It reads as weight, and it puts the
// feedback exactly where the eye is.
const slow = { until: 0, k: 1 };
export const hitStop = (ms = 70, k = 0.06) => { slow.until = performance.now() + ms; slow.k = k; };

app.on('update', (dt: number) => {
  if (!live?.tick || paused) return;
  // Everything a round will ever draw is compiled and uploaded before "Go". Pooled things start hidden, and a shader
  // is only built the first time something is actually drawn — which would be mid-round, as a dropped frame the first
  // time a bomb or a power-up appears. So the first two frames draw everything, culling off, with the canvas itself
  // hidden and the game not yet ticking: the real pipeline, the real render targets, and nothing for the player to see.
  if (live.warm > 0) {
    if (--live.warm > 0) return;
    for (const n of live.hidden) n.enabled = false;
    live.hidden = [];
    (live.root.findComponents('camera') as unknown as { frustumCulling: boolean }[]).forEach((c) => (c.frustumCulling = true));
    canvas.style.visibility = '';
    pace.shaders = compiled();
  }
  // Paced by the wall clock, not the engine's dt (which is clamped, and would hide exactly the stalls we want to see).
  const now = performance.now(), real = quality.last ? (now - quality.last) / 1000 : dt;
  quality.last = now;
  live.t += dt;
  pace.late = compiled() - pace.shaders;
  if (live.t > 2 && pace.dts.length < 30000) pace.dts.push(real * 1000); // the first 2s are the countdown: loading lives there on purpose
  // Two slow seconds' worth of frames under ~48fps and the session goes lean.
  if (!pace.lean && live.t > 3) {
    quality.slow = real > 1 / 48 ? quality.slow + real : Math.max(0, quality.slow - real * 2);
    if (quality.slow > 2) { pace.lean = true; pixelRatio(); resize(); if (live.frame) { live.frame.enabled = false; live.frame.update(); } }
  }
  live.tick(performance.now() < slow.until ? dt * slow.k : dt);
});

export function begin(view?: View): Scene {
  end();
  const root = new Entity('round'), camera = new Entity('camera');
  camera.addComponent('camera', {
    clearColor: new Color(0, 0, 0, 0), gammaCorrection: GAMMA_SRGB, toneMapping: TONEMAP_LINEAR, frustumCulling: false,
    ...(view ? { projection: PROJECTION_PERSPECTIVE, fov: view.fov, nearClip: view.near, farClip: view.far } : { projection: PROJECTION_ORTHOGRAPHIC, orthoHeight: H / 2, nearClip: 0.1, farClip: 100 }),
  });
  camera.setPosition(...(view ? view.position : ([0, 0, 10] as [number, number, number])));
  if (view?.lookAt) camera.lookAt(...view.lookAt);
  root.addChild(camera);
  // One sun over the right shoulder plus a flat fill. (A directional light shines down its own -y.)
  const sun = new Entity('sun');
  sun.addComponent('light', { type: 'directional', color: new Color(1, 1, 1), intensity: 0.7, castShadows: false });
  sun.setPosition(3, 5, 8); sun.lookAt(0, 0, 0); sun.rotateLocal(90, 0, 0);
  root.addChild(sun);
  app.scene.ambientLight = new Color(0.45, 0.45, 0.45);
  app.scene.fog.type = FOG_NONE;
  app.root.addChild(root);
  live = { root, t: 0, warm: 0, hidden: [] };
  quality.last = 0;
  return {
    root, camera,
    ambient: (hex, k = 1) => { const c = color(hex); app.scene.ambientLight = new Color(c.r * k, c.g * k, c.b * k); },
    sky: (hex) => { const c = hex ? color(hex) : null; camera.camera!.clearColor = c ? new Color(c.r, c.g, c.b, 1) : new Color(0, 0, 0, 0); },
    fog: (hex, start, end) => { const f = app.scene.fog; f.type = FOG_LINEAR; f.color = color(hex).clone(); f.start = start; f.end = end; },
  };
}

// The scene is built: warm it up, then run `tick` every frame until end().
export function run(tick: Tick) {
  if (!live) return;
  const at = live;
  at.root.forEach((n) => { if (!(n as unknown as { _enabled: boolean })._enabled) { at.hidden.push(n); n.enabled = true; } });
  if (effects.on && !pace.lean) {
    const frame = (at.frame = new CameraFrame(app, at.root.findComponent('camera') as never));
    frame.rendering.toneMapping = TONEMAP_LINEAR;
    frame.rendering.samples = 1;
    frame.bloom.intensity = 0.03; frame.bloom.blurLevel = 5;
    frame.update();
  }
  canvas.style.visibility = 'hidden';
  at.warm = 3;
  at.tick = tick;
  app.autoRender = true;
}

export function end() {
  if (!live) return;
  live.frame?.destroy();
  live.root.destroy();
  for (const thing of owned) thing.destroy();
  owned = [];
  live = null;
  app.scene.fog.type = FOG_NONE;
  app.autoRender = false;
  canvas.style.visibility = '';
}

// Where a point in the scene sits on the stage, as fractions of its width and height (for DOM words pinned to the action).
const spot = new Vec3(), pixel = new Vec3();
export function toScreen(x: number, y: number, z = 0): [number, number] | null {
  const camera = live?.root.findComponent('camera') as unknown as { worldToScreen: (world: Vec3, screen: Vec3) => Vec3 } | null;
  if (!camera || !canvas.clientWidth) return null;
  camera.worldToScreen(spot.set(x, y, z), pixel);
  return [pixel.x / canvas.clientWidth, pixel.y / canvas.clientHeight];
}

export function pause(on: boolean) { paused = on; quality.last = 0; app.autoRender = !on && !!live; }

// ---- the canvas lives wherever the current stage is -------------------------------------------------------------------
let host: HTMLElement | null = null;
const resize = () => { if (host) { const r = host.getBoundingClientRect(); if (r.width && r.height) app.resizeCanvas(r.width, r.height); canvas.style.width = canvas.style.height = '100%'; } };
const watcher = new ResizeObserver(resize);
export function mount(el: HTMLElement) { host = el; el.prepend(canvas); watcher.observe(el); resize(); }
export function unmount() { if (host) watcher.unobserve(host); host = null; canvas.remove(); }
