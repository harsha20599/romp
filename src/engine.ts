// The renderer: one PlayCanvas app and one canvas for the whole session. A game builds its scene under a root entity
// and hands back a tick; when the round ends the root is destroyed and the app idles. Keeping one GL context alive
// means shaders compiled in round one are still compiled in round ten, and a low-memory phone never has to
// re-create a context mid-session. Only the engine parts we use are imported, so the rest is tree-shaken away.
import {
  AppBase, AppOptions, WebglGraphicsDevice, RenderComponentSystem, CameraComponentSystem, LightComponentSystem, AnimComponentSystem,
  ContainerHandler, TextureHandler, Entity, Color, Mesh, MeshInstance, StandardMaterial, ShaderMaterial, VertexBuffer, VertexFormat, CameraFrame,
  SphereGeometry, BoxGeometry, CylinderGeometry, ConeGeometry, CapsuleGeometry, TorusGeometry, BoundingBox, Mat4, Vec3, Quat,
  FILLMODE_NONE, RESOLUTION_AUTO, PROJECTION_ORTHOGRAPHIC, PROJECTION_PERSPECTIVE, GAMMA_SRGB, TONEMAP_LINEAR, FOG_LINEAR, FOG_NONE,
  BLEND_NORMAL, CULLFACE_NONE, CULLFACE_FRONT, SEMANTIC_POSITION, SEMANTIC_ATTR12, SEMANTIC_ATTR13, TYPE_FLOAT32, BUFFER_DYNAMIC, SHADERLANGUAGE_GLSL, CHUNKAPI_2_8,
  Texture, PIXELFORMAT_RGBA8, FILTER_LINEAR, ADDRESS_CLAMP_TO_EDGE, BLEND_ADDITIVEALPHA, SEMANTIC_TEXCOORD0,
  type Asset, type Geometry, type Material, type ContainerResource, type GraphNode,
} from 'playcanvas';
import { cutout, feed, players, sim, tuning } from './pose.ts';
import { CUT } from './cut.ts';
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
  // A splat: a circle whose edge wanders, so a wall of them does not look stamped.
  blob: (r: number, points = 40) => {
    const p = [0, 0, 0], nrm = [0, 0, 1], idx: number[] = [], edge = Array.from({ length: points }, (_, k) => { const a = (k / points) * Math.PI * 2; return r * (0.84 + 0.10 * Math.sin(3 * a + 1) + 0.06 * Math.sin(5 * a + 2.3)); });
    for (let k = 0; k <= points; k++) { const a = (k / points) * Math.PI * 2, e = edge[k % points]; p.push(Math.cos(a) * e, Math.sin(a) * e, 0); nrm.push(0, 0, 1); if (k) idx.push(0, k, k + 1); }
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
  limb: (radius: number) => fromGeometry(new CapsuleGeometry({ radius, height: 1 + radius * 2, sides: 10, heightSegments: 1 }), new Mat4().setTRS(new Vec3(0.5, 0, 0), new Quat().setFromEulerAngles(0, 0, -90), new Vec3(1, 1, 0.02))), // pressed flat: limbs are drawn, and layer by their z like paper
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
// Every model here is a painted toy, never metal. Some kits leave glTF's metallic factor at its default of 1, which
// with no sky to reflect renders nearly black — so models are made matte as they come in (once per material).
// …and the nature kit's pastel teal foliage is repainted into the greens of the kit the game already used, so the
// two families of props read as one world.
const REPAINT: Record<string, [number, number, number]> = { leafsGreen: [0.18, 0.62, 0.36], leafsDark: [0.10, 0.46, 0.31], grass: [0.30, 0.68, 0.28], dirt: [0.50, 0.50, 0.56] };
const matte = new WeakSet<object>();
const quiet = (e: Entity) => {
  for (const r of e.findComponents('render') as unknown as { castShadows: boolean; receiveShadows: boolean; meshInstances: MeshInstance[] }[]) {
    r.castShadows = r.receiveShadows = false;
    for (const mi of r.meshInstances) { const m = mi.material as StandardMaterial, paint = REPAINT[m.name]; if (!matte.has(m) && paint) { m.diffuse = new Color(paint[0], paint[1], paint[2]); m.update(); } if (!matte.has(m) && m.useMetalness && m.metalness > 0.3 && !m.metalnessMap) { m.metalness = 0; m.gloss = Math.min(m.gloss, 0.3); m.update(); } matte.add(m); }
  }
  return e;
};
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

// Make everything under `e` cuttable by a plane: setClip(e, nx, ny, nz, w) keeps the side where n·p + w > 0.
// A cut model is hollow, so each mesh is drawn twice: its outside as it was, and its inside — the back faces, which
// is what you see when you look into the cut — flat in `flesh`. That fills the cut with exactly the fruit's own
// outline, whatever its shape and however it tumbles; no separate cap to size, place or z-fight.
const CLIP = ['uniform vec4 uClip;', 'if (dot(vPositionW, uClip.xyz) + uClip.w < 0.0) discard;'];
export function clippable(e: Entity, flesh: string) {
  const inside = own(new StandardMaterial());
  inside.useLighting = false; inside.useSkybox = false; inside.diffuse = color('#000000'); inside.emissive = color(flesh); inside.cull = CULLFACE_FRONT;
  for (const m of [inside]) { m.shaderChunksVersion = CHUNKAPI_2_8; m.getShaderChunks(SHADERLANGUAGE_GLSL).set('litUserDeclarationPS', CLIP[0]); m.getShaderChunks(SHADERLANGUAGE_GLSL).set('litUserMainStartPS', CLIP[1]); m.update(); }
  for (const render of [...(e.findComponents('render') as unknown as { meshInstances: MeshInstance[] }[])]) {
    const lining: MeshInstance[] = [];
    for (const mi of render.meshInstances) {
      const m = own(mi.material.clone()) as StandardMaterial, chunks = m.getShaderChunks(SHADERLANGUAGE_GLSL);
      m.shaderChunksVersion = CHUNKAPI_2_8;
      chunks.set('litUserDeclarationPS', CLIP[0]); chunks.set('litUserMainStartPS', CLIP[1]);
      m.update();
      mi.material = m;
      const back = new MeshInstance(mi.mesh, inside, mi.node);
      back.castShadow = false;
      lining.push(back);
    }
    // (A render component destroys its old mesh instances when given a new list, so the linings get a component of their own.)
    const liner = new Entity('lining');
    liner.addComponent('render', { meshInstances: lining, castShadows: false, receiveShadows: false });
    e.addChild(liner);
  }
  for (const mi of instancesOf(e)) mi.setParameter('uClip', [0, 0, 0, 1]);
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
    fade(i: number, alpha: number) { data[i * 8 + 7] = alpha; },
    commit() { buffer.setData(data.buffer as ArrayBuffer); },
  };
}

// ---- the player's own picture, in the game ---------------------------------------------------------------------------
// One texture holds every player's cut-out side by side, each as [picture | mask] (pose.worker.ts draws it). This
// material turns a slot of it into a character: the body graded toward the game's palette and lit from behind in
// the player's colour, a thick outline and a soft glow around it — the things that make a rough 256px person mask
// look deliberate. `shadow` swaps the picture for a gradient of the player's colour (the same shape, nothing of the room).
let cutTexture: Texture | null = null, cutSeen = -1;
const cutTex = () => cutTexture ?? (cutTexture = new Texture(device, { name: 'cut-outs', width: 4, height: 4, format: PIXELFORMAT_RGBA8, mipmaps: false, minFilter: FILTER_LINEAR, magFilter: FILTER_LINEAR, addressU: ADDRESS_CLAMP_TO_EDGE, addressV: ADDRESS_CLAMP_TO_EDGE }));
export function refreshCutouts() { // call once a frame, by whoever shows cut-outs
  if (cutout.seq === cutSeen || !cutout.bitmap) return cutout.slots;
  cutSeen = cutout.seq;
  if (cutTex().width !== cutout.bitmap.width || cutTex().height !== cutout.bitmap.height) cutTex().resize(cutout.bitmap.width, cutout.bitmap.height);
  cutTex().setSource(cutout.bitmap as unknown as HTMLCanvasElement);
  return cutout.slots;
}
export function cutoutLook(hex: string) {
  const m = new ShaderMaterial({
    uniqueName: 'romp-cutout',
    attributes: { vertex_position: SEMANTIC_POSITION },
    vertexGLSL: `attribute vec3 vertex_position; uniform mat4 matrix_model; uniform mat4 matrix_viewProjection; uniform vec2 uSize; varying vec2 vUv;
      void main(void) { vUv = vertex_position.xy / uSize + 0.5; gl_Position = matrix_viewProjection * matrix_model * vec4(vertex_position, 1.0); }`,
    fragmentGLSL: `#include "gammaPS"
      varying vec2 vUv; uniform sampler2D uCut; uniform vec4 uSlot; uniform vec3 uTint; uniform float uShadow; uniform float uTime;
      float maskAt(vec2 uv) { vec2 c = clamp(uv, vec2(0.004), vec2(0.996)); return texture2D(uCut, vec2((uSlot.x + 0.5 + 0.5 * c.x) * uSlot.y, 1.0 - c.y)).r * step(0.0, uv.x) * step(uv.x, 1.0) * step(0.0, uv.y) * step(uv.y, 1.0); }
      float ring(vec2 uv, float r) { // the mask, grown by r: the widest it gets in eight directions
        vec2 d = vec2(r * 1.333, r); float v = 0.0;
        v = max(v, maskAt(uv + d * vec2(1.0, 0.0))); v = max(v, maskAt(uv + d * vec2(-1.0, 0.0))); v = max(v, maskAt(uv + d * vec2(0.0, 1.0))); v = max(v, maskAt(uv + d * vec2(0.0, -1.0)));
        v = max(v, maskAt(uv + d * vec2(0.7, 0.7))); v = max(v, maskAt(uv + d * vec2(-0.7, 0.7))); v = max(v, maskAt(uv + d * vec2(0.7, -0.7))); v = max(v, maskAt(uv + d * vec2(-0.7, -0.7)));
        return v;
      }
      void main(void) {
        float a = smoothstep(0.42, 0.62, maskAt(vUv)), line = smoothstep(0.4, 0.6, ring(vUv, 0.012)), glow = ring(vUv, 0.035);
        float inner = a * (1.0 - smoothstep(0.55, 0.95, min(maskAt(vUv + vec2(0.02, 0.0)), min(maskAt(vUv - vec2(0.02, 0.0)), min(maskAt(vUv + vec2(0.0, 0.015)), maskAt(vUv - vec2(0.0, 0.015))))))); // just inside the edge
        vec2 c = clamp(vUv, vec2(0.004), vec2(0.996));
        vec3 seen = pow(texture2D(uCut, vec2((uSlot.x + 0.5 * c.x) * uSlot.y, 1.0 - c.y)).rgb, vec3(2.2));
        float luma = dot(seen, vec3(0.3, 0.6, 0.1));
        seen = mix(vec3(luma), seen, 1.25) * 1.12; seen = mix(seen, seen * (0.6 + uTint), 0.22); // a little more colour, and a lean toward the player's own
        // The shadow look: the player's colour printed in halftone dots (bigger toward the top, like light falling on it),
        // with a sheen that crosses now and then. Dots forgive a rough mask far better than a flat fill does.
        vec2 cell = fract(vUv * vec2(54.0, 72.0)) - 0.5; float dotSize = 0.30 + 0.22 * vUv.y, dots = smoothstep(dotSize, dotSize - 0.12, length(cell));
        vec3 flat_ = uTint * (0.22 + 0.25 * vUv.y) + uTint * dots * (0.55 + 0.5 * vUv.y) + vec3(0.3) * dots * smoothstep(0.0, 0.08, sin((vUv.x + vUv.y) * 9.0 - uTime * 1.7) - 0.92);
        vec3 body = mix(seen, flat_, uShadow) + uTint * inner * 0.9; // lit from behind
        vec3 rgb = mix(uTint * 1.3 + 0.15, body, a);
        float alpha = max(a, max(line, glow * glow * 0.45));
        gl_FragColor = vec4(gammaCorrectOutput(rgb), alpha);
      }`,
  });
  m.blendType = BLEND_NORMAL; m.cull = CULLFACE_NONE; m.depthWrite = false;
  m.setParameter('uCut', cutTex()); m.setParameter('uTint', linear(hex)); m.setParameter('uShadow', 0); m.setParameter('uTime', 0);
  m.setParameter('uSize', [CUT.left * 2, CUT.up + CUT.down]); m.setParameter('uSlot', [0, 1, 0, 0]);
  m.update();
  return own(m);
}

// ---- the shadow body -------------------------------------------------------------------------------------------------
// The player as a figure of light printed in halftone dots: a smooth body grown around the skeleton (every limb a
// rounded, tapering capsule, all melted together), its edge glowing in the player's colour, and the parts that play —
// hand tips and foot tips — burning white. Drawn entirely in one fragment shader from 17 joint positions, so it
// costs the tracker nothing (no person mask), looks the same on every device, and cannot have a ragged edge.
// uTips = 1 draws only the glowing tips (over a camera cut-out, or over the room in the Mirror look).
export const BODY_JOINTS = [0, 11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28, 31, 32, 19, 20]; // nose, shoulders, elbows, wrists, hips, knees, ankles, toes, index knuckles
export function bodyLook(hex: string) {
  const m = new ShaderMaterial({
    uniqueName: 'romp-body',
    attributes: { vertex_position: SEMANTIC_POSITION },
    vertexGLSL: `attribute vec3 vertex_position; uniform mat4 matrix_model; uniform mat4 matrix_viewProjection; varying vec2 vAt;
      void main(void) { vAt = vertex_position.xy; gl_Position = matrix_viewProjection * matrix_model * vec4(vertex_position, 1.0); }`,
    fragmentGLSL: `#include "gammaPS"
      varying vec2 vAt; uniform vec3 uTint; uniform float uTime; uniform float uTips; uniform float uJ[34]; uniform float uSeen[17];
      vec2 J(int i) { return vec2(uJ[i * 2], uJ[i * 2 + 1]); }
      float limb(vec2 p, int ia, int ib, float ra, float rb) { // distance to a capsule that tapers from ra to rb; far away if either end is unseen
        vec2 a = J(ia), b = J(ib), ab = b - a; float h = clamp(dot(p - a, ab) / max(dot(ab, ab), 1e-5), 0.0, 1.0);
        return length(p - a - ab * h) - mix(ra, rb, h) + (1.0 - step(0.4, min(uSeen[ia], uSeen[ib]))) * 9.0;
      }
      float melt(float a, float b) { float k = 0.16, h = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0); return mix(b, a, h) - k * h * (1.0 - h); }
      void main(void) {
        vec2 p = vAt, neck = (J(1) + J(2)) * 0.5, hips = (J(7) + J(8)) * 0.5, head = J(0) + vec2(0.0, 0.06);
        float tips = 0.0; // the parts that play
        for (int i = 0; i < 2; i++) { tips += exp(-length(p - mix(J(5 + i), J(15 + i), 0.6)) * 5.5) * step(0.4, uSeen[5 + i]); tips += exp(-length(p - mix(J(11 + i), J(13 + i), 0.6)) * 5.5) * step(0.4, uSeen[11 + i]); }
        tips *= 0.85 + 0.15 * sin(uTime * 6.0);
        if (uTips > 0.5) { gl_FragColor = vec4(gammaCorrectOutput(mix(uTint * 1.5, vec3(1.0), smoothstep(0.25, 0.9, tips))), min(1.0, tips * 1.1)); return; }
        float d = length(p - head) - 0.43;
        d = melt(d, length(p - mix(neck, head, 0.5)) - 0.16);
        { vec2 ab = hips - neck; float h = clamp(dot(p - neck, ab) / max(dot(ab, ab), 1e-5), 0.0, 1.0); d = melt(d, length(p - neck - ab * h) - mix(0.50, 0.40, h)); } // torso
        d = melt(d, limb(p, 1, 2, 0.22, 0.22)); d = melt(d, limb(p, 7, 8, 0.26, 0.26));
        d = melt(d, limb(p, 1, 3, 0.19, 0.15)); d = melt(d, limb(p, 3, 5, 0.15, 0.11)); d = melt(d, limb(p, 5, 15, 0.12, 0.13));
        d = melt(d, limb(p, 2, 4, 0.19, 0.15)); d = melt(d, limb(p, 4, 6, 0.15, 0.11)); d = melt(d, limb(p, 6, 16, 0.12, 0.13));
        d = melt(d, limb(p, 7, 9, 0.27, 0.19)); d = melt(d, limb(p, 9, 11, 0.18, 0.12)); d = melt(d, limb(p, 11, 13, 0.13, 0.11));
        d = melt(d, limb(p, 8, 10, 0.27, 0.19)); d = melt(d, limb(p, 10, 12, 0.18, 0.12)); d = melt(d, limb(p, 12, 14, 0.13, 0.11));
        float body = smoothstep(0.02, -0.02, d), line = smoothstep(0.10, 0.06, abs(d - 0.03)), glow = exp(-max(d, 0.0) * 4.2) * 0.55;
        // Halftone: a grid of dots, fatter toward the head as if lit from above, and fatter again just inside the edge (a rim).
        vec2 cell = fract(p * 9.5) - 0.5; float up = clamp((p.y + 4.2) / 6.6, 0.0, 1.0), rim = smoothstep(-0.30, -0.02, d);
        float size = 0.26 + 0.16 * up + 0.10 * rim, dots = smoothstep(size, size - 0.10, length(cell));
        float sheen = smoothstep(0.0, 0.08, sin((p.x + p.y) * 1.4 - uTime * 1.6) - 0.93);
        vec3 fill = uTint * (0.20 + 0.18 * up) + (uTint * (0.75 + 0.45 * up) + vec3(0.30) * (rim * 0.6 + sheen)) * dots;
        vec3 rgb = mix(uTint * 1.25 + vec3(0.18), fill, body) + vec3(1.0) * tips * 0.9 + uTint * tips * 0.5;
        float alpha = max(max(body * 0.96, line * 0.95), max(glow, min(1.0, tips)));
        gl_FragColor = vec4(gammaCorrectOutput(rgb), alpha);
      }`,
  });
  m.blendType = BLEND_NORMAL; m.cull = CULLFACE_NONE; m.depthWrite = false;
  m.setParameter('uTint', linear(hex)); m.setParameter('uTime', 0); m.setParameter('uTips', 0);
  m.setParameter('uJ[0]', new Float32Array(34)); m.setParameter('uSeen[0]', new Float32Array(17));
  m.update();
  timed.push(m);
  return own(m);
}

// Light itself: adds to whatever is behind it, brightest in the middle, gone at the rim. Halos, glass hands, sparks.
export function glowLook(hex: string, strength = 1) {
  const m = new ShaderMaterial({
    uniqueName: 'romp-glow',
    attributes: { vertex_position: SEMANTIC_POSITION },
    vertexGLSL: `attribute vec3 vertex_position; uniform mat4 matrix_model; uniform mat4 matrix_viewProjection; varying vec2 vAt;
      void main(void) { vAt = vertex_position.xy; gl_Position = matrix_viewProjection * matrix_model * vec4(vertex_position, 1.0); }`,
    fragmentGLSL: `#include "gammaPS"
      varying vec2 vAt; uniform vec3 uGlow; uniform float uPower;
      void main(void) { float d = length(vAt), core = smoothstep(0.3, 0.12, d), halo = pow(max(0.0, 1.0 - d), 2.0); gl_FragColor = vec4(gammaCorrectOutput(uGlow * halo + vec3(core)), (halo * 0.85 + core) * uPower); }`,
  });
  m.blendType = BLEND_ADDITIVEALPHA; m.depthWrite = false; m.cull = CULLFACE_NONE;
  m.setParameter('uGlow', linear(hex)); m.setParameter('uPower', strength);
  m.update();
  return own(m);
}
// One glow material, many colours and strengths: set on the entity, the material stays shared.
export const glowAs = (e: Entity, hex: string, power = 1) => { for (const mi of instancesOf(e)) { mi.setParameter('uGlow', linear(hex)); mi.setParameter('uPower', power); } };

// The light a fast hand leaves behind: white-hot at the hand, the player's colour along it, nothing at the tail.
export function trailLook(hex: string) {
  const m = new ShaderMaterial({
    uniqueName: 'romp-trail',
    attributes: { vertex_position: SEMANTIC_POSITION, vertex_texCoord0: SEMANTIC_TEXCOORD0 },
    vertexGLSL: `attribute vec3 vertex_position; attribute vec2 vertex_texCoord0; uniform mat4 matrix_model; uniform mat4 matrix_viewProjection; varying vec2 vAlong;
      void main(void) { vAlong = vertex_texCoord0; gl_Position = matrix_viewProjection * matrix_model * vec4(vertex_position, 1.0); }`,
    fragmentGLSL: `#include "gammaPS"
      varying vec2 vAlong; uniform vec3 uGlow;
      void main(void) { float t = vAlong.x, edge = 1.0 - abs(vAlong.y * 2.0 - 1.0), core = smoothstep(0.55, 1.0, edge) * (1.0 - t); gl_FragColor = vec4(gammaCorrectOutput(mix(uGlow * 1.4, vec3(1.0), core)), pow(1.0 - t, 1.2) * smoothstep(0.0, 0.6, edge)); }`,
  });
  m.blendType = BLEND_ADDITIVEALPHA; m.depthWrite = false; m.cull = CULLFACE_NONE;
  m.setParameter('uGlow', linear(hex));
  m.update();
  return own(m);
}

// ---- a world behind the game -------------------------------------------------------------------------------------------
// Each flat-stage game plays in front of a place, painted by one small fragment shader on one quad at the back:
// no textures to download, nothing to stream, and because it is opaque and furthest away the GPU only shades the
// pixels nothing else covered. Kept darker and calmer than anything you have to hit — it is a wall, not a target.
const PLACES = {
  // Slice: a dojo wall of warm planks, a pale sun disc painted on it, lantern light from the top corners.
  dojo: `float board = floor(uv.x * 9.0), seam = smoothstep(0.0, 0.035, abs(fract(uv.x * 9.0) - 0.5) * 2.0 - 0.93);
    float grain = noise(vec2(uv.x * 140.0 + board * 7.0, uv.y * 3.0 + board)) * 0.5 + noise(vec2(uv.x * 40.0, uv.y * 1.5 + board * 3.0)) * 0.5;
    vec3 c = mix(vec3(0.20, 0.10, 0.06), vec3(0.34, 0.19, 0.10), hash(vec2(board, 1.0)) * 0.6 + grain * 0.4) * (1.0 - seam * 0.55);
    float disc = smoothstep(0.30, 0.295, length(p - vec2(0.0, 0.02))); c = mix(c, c * 1.5 + vec3(0.10, 0.05, 0.03), disc * 0.55);
    c += vec3(1.0, 0.55, 0.2) * (0.16 / (0.3 + 6.0 * dot(p - vec2(-0.8, 0.5), p - vec2(-0.8, 0.5))) + 0.16 / (0.3 + 6.0 * dot(p - vec2(0.8, 0.5), p - vec2(0.8, 0.5)))) * (0.9 + 0.1 * sin(t * 3.0));`,
  // Keepy-Uppy: a late-afternoon sky, slow clouds, soft hills along the bottom.
  sky: `vec3 c = mix(vec3(0.98, 0.72, 0.55), vec3(0.22, 0.45, 0.80), smoothstep(-0.1, 0.9, uv.y));
    c += vec3(1.0, 0.85, 0.6) * 0.35 / (1.0 + 18.0 * dot(p - vec2(0.55, 0.22), p - vec2(0.55, 0.22)));
    float cloud = smoothstep(0.52, 0.8, fbm(vec2(p.x * 1.6 + t * 0.02, p.y * 3.2 + 4.0))) * smoothstep(0.0, 0.35, uv.y - 0.35);
    c = mix(c, vec3(1.0, 0.96, 0.93), cloud * 0.75);
    float far = smoothstep(0.0, 0.01, uv.y - (0.20 + 0.05 * sin(p.x * 3.0 + 1.0) + 0.03 * sin(p.x * 7.0))), near = smoothstep(0.0, 0.01, uv.y - (0.11 + 0.04 * sin(p.x * 2.2 + 4.0)));
    c = mix(vec3(0.30, 0.47, 0.50), c, far); c = mix(vec3(0.16, 0.33, 0.30), c, near); c *= 0.8;`,
  // Leaks: inside a tank in deep water — light shafts from above, caustics, bubbles, a riveted frame.
  deep: `vec3 c = mix(vec3(0.01, 0.06, 0.13), vec3(0.03, 0.30, 0.42), smoothstep(0.0, 1.0, uv.y));
    float shaft = pow(max(0.0, sin(p.x * 5.0 + uv.y * 1.5 + t * 0.25) * 0.5 + 0.5), 6.0) * uv.y; c += vec3(0.25, 0.55, 0.6) * shaft * 0.35;
    float ca = sin(p.x * 14.0 + t) + sin(p.y * 17.0 - t * 1.3) + sin((p.x + p.y) * 11.0 + t * 0.7); c += vec3(0.1, 0.3, 0.35) * smoothstep(1.6, 2.6, ca) * 0.35;
    for (int i = 0; i < 6; i++) { float k = float(i), bx = hash(vec2(k, 3.0)) * 3.2 - 1.6, by = fract(hash(vec2(k, 9.0)) + t * (0.04 + 0.03 * hash(vec2(k, 5.0)))) * 1.3 - 0.65; float r = 0.012 + 0.02 * hash(vec2(k, 7.0)); float d = length(p - vec2(bx + 0.03 * sin(t + k), by)); c += vec3(0.5, 0.8, 0.9) * smoothstep(r, r * 0.6, d) * 0.35; }
    float edge = max(abs(p.x) / 1.7778, abs(p.y) / 1.0); float frame = smoothstep(0.93, 0.945, edge); c = mix(c, vec3(0.10, 0.13, 0.17), frame);
    vec2 rv = vec2(fract(uv.x * 16.0) - 0.5, fract(uv.y * 9.0) - 0.5); c += vec3(0.25) * frame * smoothstep(0.16, 0.10, length(rv));`,
  // Jab: a boxing gym at night — a lit wall, diagonal neon, the ring rope lines, a pool of light on the floor.
  gym: `vec3 c = mix(vec3(0.05, 0.04, 0.10), vec3(0.13, 0.08, 0.20), uv.y);
    float stripe = smoothstep(0.47, 0.5, abs(fract((p.x + p.y * 0.6) * 1.4 + 0.2) - 0.5)); c += vec3(0.9, 0.15, 0.4) * stripe * 0.10;
    c += vec3(1.0, 0.85, 0.7) * 0.22 * smoothstep(0.9, 0.0, abs(p.x) * 0.9 + (1.0 - uv.y) * 0.5) * uv.y;
    for (int i = 0; i < 3; i++) { float y = 0.30 + float(i) * 0.085; c = mix(c, vec3(0.85, 0.2, 0.3), smoothstep(0.006, 0.002, abs(uv.y - y)) * 0.6); }
    float floor_ = smoothstep(0.2, 0.0, uv.y); c = mix(c, vec3(0.10, 0.07, 0.16) + vec3(0.5, 0.35, 0.6) * 0.25 / (1.0 + 9.0 * p.x * p.x), floor_);`,
  // Beat: the synthwave road — a striped sun on the horizon and a grid floor rushing toward you in time.
  synth: `float horizon = 0.42; vec3 c = mix(vec3(0.10, 0.02, 0.22), vec3(0.02, 0.01, 0.10), smoothstep(horizon, 1.0, uv.y));
    float sd = length(vec2(p.x, (uv.y - horizon - 0.16) * 2.0)); float sun = smoothstep(0.42, 0.41, sd) * step(0.04, fract(uv.y * 22.0 - t * 0.3) + (uv.y - horizon) * 3.0 - 0.35);
    c = mix(c, mix(vec3(1.0, 0.25, 0.55), vec3(1.0, 0.8, 0.3), (uv.y - horizon) * 3.0), sun * step(horizon, uv.y)); c += vec3(0.9, 0.2, 0.6) * 0.18 / (1.0 + 30.0 * abs(uv.y - horizon));
    if (uv.y < horizon) { float z = 0.12 / (horizon - uv.y + 0.02), gx = abs(fract(p.x * z * 1.2) - 0.5), gz = abs(fract(z * 1.5 + t * 1.2) - 0.5); float g = smoothstep(0.46, 0.5, max(gx, gz)); c = mix(vec3(0.03, 0.01, 0.09), vec3(0.2, 0.9, 1.0), g * smoothstep(0.0, 0.25, horizon - uv.y + 0.05) * 0.55); }`,
  // Freeze: a dance floor — slow coloured beams turning overhead, a glossy floor picking them up.
  disco: `vec3 c = vec3(0.03, 0.02, 0.08); float ang = atan(p.y - 0.9, p.x);
    for (int i = 0; i < 4; i++) { float k = float(i), beam = pow(max(0.0, cos((ang + t * (0.12 + 0.05 * k) + k * 1.7) * 3.0)), 14.0); c += (0.5 + 0.5 * cos(vec3(0.0, 2.1, 4.2) + k * 1.4 + t * 0.2)) * beam * 0.16; }
    float tile = step(0.5, fract(floor(p.x * 3.0 + 40.0) * 0.5 + floor((0.25 - uv.y) * 18.0 / (uv.y + 0.4)) * 0.5)); float floor_ = smoothstep(0.26, 0.2, uv.y);
    c = mix(c, c * 1.6 + vec3(0.05, 0.03, 0.10) * (0.6 + tile), floor_);`,
  // Shape Up: a photo studio sweep — one soft spot on a seamless wall.
  studio: `vec3 c = mix(vec3(0.07, 0.05, 0.16), vec3(0.20, 0.13, 0.36), smoothstep(1.3, 0.0, length(p - vec2(0.0, 0.15))));
    c = mix(c, c * 0.7, smoothstep(0.22, 0.18, uv.y)); c += vec3(0.6, 0.4, 0.9) * 0.05 * smoothstep(0.004, 0.0, abs(uv.y - 0.2));`,
  // Rocket: deep space — nebula clouds that the stars stream across.
  space: `vec3 c = vec3(0.01, 0.01, 0.04); float n1 = fbm(p * 1.3 + vec2(0.0, t * 0.01)), n2 = fbm(p * 2.1 + 7.0);
    c += vec3(0.30, 0.10, 0.45) * smoothstep(0.35, 0.9, n1) * 0.5 + vec3(0.05, 0.25, 0.40) * smoothstep(0.45, 0.95, n2) * 0.45;`,
  // Sprint: a stadium at dusk — floodlights, a crowd of lights, and the track rushing under you at whatever pace you set (uDrive = metres run).
  track: `float horizon = 0.46; vec3 c = mix(vec3(0.98, 0.55, 0.35), vec3(0.10, 0.10, 0.32), smoothstep(horizon, 1.0, uv.y));
    float stand = smoothstep(horizon + 0.17, horizon + 0.16, uv.y) * step(horizon, uv.y); c = mix(c, vec3(0.06, 0.05, 0.14), stand * 0.92);
    vec2 seat = vec2(uv.x * 170.0, (uv.y - horizon) * 110.0); c += stand * step(0.9, hash(floor(seat))) * smoothstep(0.5, 0.2, length(fract(seat) - 0.5)) * (0.5 + 0.5 * sin(t * 3.0 + hash(floor(seat)) * 40.0)) * vec3(1.0, 0.9, 0.7) * 0.5;
    for (int i = 0; i < 4; i++) { vec2 l = vec2(-1.35 + 0.9 * float(i), 0.62); c += vec3(1.0, 0.95, 0.85) * 0.011 / (0.006 + dot(p - l, p - l)); }
    if (uv.y < horizon) { float z = 0.16 / (horizon - uv.y + 0.015), x = p.x * z * 0.55; float lane = smoothstep(0.47, 0.5, abs(fract(x) - 0.5));
      float dash = step(0.5, fract(z * 0.8 + uDrive * 0.35)); vec3 tartan = mix(vec3(0.62, 0.20, 0.14), vec3(0.74, 0.27, 0.18), dash); tartan = mix(tartan, vec3(0.95), lane);
      c = mix(tartan * (0.55 + 0.45 * smoothstep(0.0, 0.3, horizon - uv.y)), vec3(0.98, 0.55, 0.35) * 0.6, smoothstep(0.06, 0.0, horizon - uv.y)); }`,
  // Forge: a smithy — dark stone, a furnace mouth that breathes with the heat you are building (uDrive = 0..1), sparks of light on the walls.
  forge: `float brick = step(0.06, fract(uv.y * 14.0)) * step(0.04, fract(uv.x * 9.0 + step(0.5, fract(uv.y * 7.0)) * 0.5));
    vec3 c = mix(vec3(0.035, 0.03, 0.04), vec3(0.10, 0.08, 0.09), brick * (0.6 + 0.4 * noise(uv * 40.0)));
    float heat = 0.35 + 0.65 * uDrive, mouth = smoothstep(0.34, 0.0, length((p - vec2(0.0, -0.25)) * vec2(0.75, 1.3)));
    c += vec3(1.0, 0.42, 0.08) * mouth * heat * (0.85 + 0.15 * sin(t * 9.0 + p.x * 5.0)) + vec3(1.0, 0.75, 0.3) * pow(mouth, 3.0) * heat;
    c += vec3(1.0, 0.35, 0.05) * 0.10 * heat / (0.25 + dot(p, p)); c = mix(c, vec3(0.02), smoothstep(0.17, 0.12, uv.y));`,
  // Jack Attack: low orbit — the curve of a planet below, a grid of distant stars, a slow aurora.
  orbit: `vec3 c = mix(vec3(0.02, 0.01, 0.07), vec3(0.05, 0.03, 0.16), uv.y); vec2 sky = uv * vec2(128.0, 72.0); c += step(0.985, hash(floor(sky))) * smoothstep(0.45, 0.05, length(fract(sky) - 0.5)) * (0.55 + 0.45 * sin(t * 2.0 + hash(floor(sky)) * 60.0)) * vec3(0.9, 0.95, 1.0);
    float aur = fbm(vec2(p.x * 1.5 + t * 0.03, p.y * 0.6)) * smoothstep(0.1, 0.8, uv.y); c += vec3(0.1, 0.8, 0.5) * aur * 0.16 + vec3(0.5, 0.2, 0.8) * aur * aur * 0.2;
    float d = length(p - vec2(0.0, -3.1)); c = mix(c, mix(vec3(0.05, 0.25, 0.45), vec3(0.02, 0.06, 0.15), smoothstep(2.0, 2.45, d)), smoothstep(2.47, 2.44, d)); c += vec3(0.3, 0.7, 1.0) * 0.5 * smoothstep(0.08, 0.0, abs(d - 2.47));`,
  // Lumberjack: a pine forest in morning light — trunks in three depths, shafts of sun, mist on the ground.
  forest: `vec3 c = mix(vec3(0.62, 0.74, 0.55), vec3(0.20, 0.38, 0.36), smoothstep(0.1, 1.0, uv.y));
    for (int i = 0; i < 3; i++) { float k = float(i), den = 5.0 + k * 4.0, x = uv.x * den + k * 1.7, id = floor(x), w = 0.16 + 0.12 * hash(vec2(id, k)), trunk = smoothstep(w, w - 0.04, abs(fract(x) - 0.5)) * step(0.35, hash(vec2(id, k + 5.0)));
      c = mix(c, mix(vec3(0.30, 0.42, 0.36), vec3(0.10, 0.12, 0.10), k * 0.5) * (0.8 + 0.2 * noise(vec2(x * 3.0, uv.y * 30.0))), trunk * (0.45 + 0.27 * k)); }
    c += vec3(1.0, 0.92, 0.65) * 0.22 * pow(max(0.0, sin(p.x * 3.0 - uv.y * 2.2 + 1.0)), 5.0) * uv.y; c = mix(c, vec3(0.80, 0.86, 0.78), smoothstep(0.22, 0.0, uv.y) * 0.55); c *= 0.78;`,
  // Pulse: a neon tunnel flying at you in time — rings pass on the beat (uDrive = beats into the song), spokes run down
  // the walls, the far end flares on every beat; uMood (0..1) turns it from cyan/magenta to gold: fever.
  tunnel: `vec2 q = p - vec2(0.0, 0.13); float r = pow(pow(abs(q.x) * 0.6, 4.0) + pow(abs(q.y), 4.0), 0.25), z = 0.42 / (r + 0.03), beat = exp(-fract(uDrive) * 4.5);
    // Thin, bright lines on near-black: neon is contrast. One bold ring every two beats, fine ones between, spokes down the walls.
    float ring = smoothstep(0.462, 0.5, abs(fract(z * 0.5 - uDrive * 0.5) - 0.5)), thin = smoothstep(0.47, 0.5, abs(fract(z * 2.0 - uDrive * 2.0) - 0.5));
    float ang = atan(q.y, q.x * 0.6) / 6.2832, spoke = smoothstep(0.474, 0.5, abs(fract(ang * 16.0) - 0.5)), near = smoothstep(0.04, 0.95, r);
    vec3 cool = mix(vec3(0.0, 0.85, 1.0), vec3(1.0, 0.08, 0.75), 0.5 + 0.5 * sin(z * 0.55 - t * 0.35 + ang * 6.2832)), hot = mix(vec3(1.0, 0.72, 0.1), vec3(1.0, 0.95, 0.75), 0.5 + 0.5 * sin(z * 0.8 - t));
    vec3 neon = mix(cool, hot, uMood), c = vec3(0.012, 0.006, 0.035) + neon * 0.018 * near;
    c += neon * (ring * (0.95 + 0.9 * beat) + thin * 0.10 + spoke * (0.10 + 0.5 * ring)) * (0.25 + 0.75 * near);
    c += neon * ring * 0.10 * near; // a little of each ring's light spills onto the wall around it
    c += neon * (0.05 + 0.40 * beat) / (1.0 + 90.0 * r * r) + vec3(1.0) * beat * 0.22 / (1.0 + 500.0 * r * r); // the far end breathes with the kick
    c *= 0.96 + 0.04 * sin(uv.y * 540.0);`,
  // Wipe: what is under the grime — clean white tiles with a slow glint crossing them.
  tiles: `vec2 g = fract(uv * vec2(16.0, 9.0)); float grout = smoothstep(0.0, 0.05, min(min(g.x, 1.0 - g.x), min(g.y, 1.0 - g.y)));
    vec3 c = mix(vec3(0.35, 0.45, 0.55), vec3(0.78, 0.88, 0.95), grout) * (0.75 + 0.1 * hash(floor(uv * vec2(16.0, 9.0))));
    c += vec3(0.25) * smoothstep(0.08, 0.0, abs(fract((p.x + p.y * 0.5) * 0.35 - t * 0.08) - 0.5)); c *= 0.62;`,
};
export type Place = keyof typeof PLACES;
// ---- the Mirror look: the room itself is the world ---------------------------------------------------------------------
// The whole camera picture, mirrored and fitted to the stage, pulled toward the game's two tones and darkened so that
// everything the game draws reads as the light in the room; each player stands in a pool of their own light, and a
// thick frame keeps the raw picture off the edge of the screen. No person mask needed: the cheapest look there is.
const TONES: Partial<Record<Place, [string, string]>> = { deep: ['#031a2e', '#38bdf8'], sky: ['#2a1140', '#fdba74'] };
export const mirrorOn = () => tuning.look === 'mirror' && !sim && !!feed.video?.videoWidth;
// Stage units per picture-height, and where a point of the picture (x in 0..aspect, y in 0..1, mirrored) lands on the stage.
export const feedUnit = (aspect: number) => (aspect >= W / H ? H : W / aspect);
function mirror(scene: Scene, place: Place) {
  const video = feed.video!, tex = own(new Texture(device, { name: 'feed', width: video.videoWidth, height: video.videoHeight, format: PIXELFORMAT_RGBA8, mipmaps: false, minFilter: FILTER_LINEAR, magFilter: FILTER_LINEAR, addressU: ADDRESS_CLAMP_TO_EDGE, addressV: ADDRESS_CLAMP_TO_EDGE }));
  const [low, high] = TONES[place] ?? ['#120a2e', '#a78bfa'], aspect = video.videoWidth / video.videoHeight, unit = feedUnit(aspect);
  const m = own(new ShaderMaterial({
    uniqueName: 'romp-mirror',
    attributes: { vertex_position: SEMANTIC_POSITION },
    vertexGLSL: `attribute vec3 vertex_position; uniform mat4 matrix_model; uniform mat4 matrix_viewProjection; varying vec2 vAt;
      void main(void) { vAt = vertex_position.xy; gl_Position = matrix_viewProjection * matrix_model * vec4(vertex_position, 1.0); }`,
    fragmentGLSL: `#include "gammaPS"
      varying vec2 vAt; uniform sampler2D uFeed; uniform vec3 uLow; uniform vec3 uHigh; uniform vec4 uFit; uniform vec4 uSpotA; uniform vec4 uSpotB; uniform vec3 uTintA; uniform vec3 uTintB;
      void main(void) {
        vec2 uv = vec2(0.5 - vAt.x / uFit.x, 0.5 - vAt.y / uFit.y); // mirrored; the picture's first row is its top
        vec3 seen = pow(texture2D(uFeed, uv).rgb, vec3(2.2)); float luma = dot(seen, vec3(0.3, 0.6, 0.1));
        vec3 c = mix(mix(uLow, uHigh, smoothstep(0.0, 0.9, luma)), seen, 0.45) * 0.42;
        float a = smoothstep(1.0, 0.25, length((vAt - uSpotA.xy) / uSpotA.zw)) * step(0.001, uSpotA.z), b = smoothstep(1.0, 0.25, length((vAt - uSpotB.xy) / uSpotB.zw)) * step(0.001, uSpotB.z);
        c += seen * (a + b) * 0.85 + (uTintA * a + uTintB * b) * 0.10; // where a player stands, the room comes up to full light
        vec2 q = abs(vAt) / vec2(${(W / 2).toFixed(1)}, ${(H / 2).toFixed(1)}); float edge = max(q.x, q.y), frame = smoothstep(0.945, 0.955, edge);
        c = mix(c, uLow * 1.6 + uHigh * 0.25 * smoothstep(0.955, 0.97, edge) * smoothstep(0.985, 0.97, edge), frame);
        gl_FragColor = vec4(gammaCorrectOutput(c), 1.0);
      }`,
  }));
  m.setParameter('uFeed', tex); m.setParameter('uLow', linear(low)); m.setParameter('uHigh', linear(high)); m.setParameter('uFit', [aspect * unit, unit, 0, 0]);
  m.setParameter('uTintA', linear('#818cf8')); m.setParameter('uTintB', linear('#34d399')); m.setParameter('uSpotA', [0, 0, 0, 0]); m.setParameter('uSpotB', [0, 0, 0, 0]);
  m.update();
  const spots = [new Float32Array(4), new Float32Array(4)];
  const refresh = () => {
    if (video.readyState >= 2) { tex.setSource(video as unknown as HTMLCanvasElement); tex.upload(); }
    players.forEach((pl, i) => {
      const f = pl.frame, s = spots[i];
      if (pl.present) { s[0] = (f.x - f.aspect / 2) * unit; s[1] = (0.5 - f.y - f.sw * 0.9) * unit; s[2] = f.sw * unit * 3.4; s[3] = f.sw * unit * 4.6; } else s[2] = 0;
      m.setParameter(i ? 'uSpotB' : 'uSpotA', s);
    });
  };
  everyFrame.push(refresh);
  scene.cleanup(() => void everyFrame.splice(everyFrame.indexOf(refresh), 1));
  return node(scene.root, shapes.quad(W, H), m, [0, 0, -20]);
}
const everyFrame: (() => void)[] = [];
const timed: ShaderMaterial[] = []; // materials that want the clock, once a frame
// `bodies: true` says the game shows its players' whole bodies, so under the Mirror look the room takes the place's place.
export function backdrop(scene: Scene, place: Place, bodies = false) {
  if (bodies && mirrorOn()) return Object.assign(mirror(scene, place), { drive: (_: number) => {}, mood: (_: number) => {} });
  const m = own(new ShaderMaterial({
    uniqueName: `romp-place-${place}`,
    attributes: { vertex_position: SEMANTIC_POSITION },
    vertexGLSL: `attribute vec3 vertex_position; uniform mat4 matrix_model; uniform mat4 matrix_viewProjection; varying vec2 vUv;
      void main(void) { vUv = vertex_position.xy / vec2(${W}.0, ${H}.0) + 0.5; gl_Position = matrix_viewProjection * matrix_model * vec4(vertex_position, 1.0); }`,
    fragmentGLSL: `#include "gammaPS"
      varying vec2 vUv; uniform float uTime; uniform float uDrive; uniform float uMood;
      float hash(vec2 q) { return fract(sin(dot(q, vec2(127.1, 311.7))) * 43758.5453); }
      float noise(vec2 q) { vec2 i = floor(q), f = fract(q); f = f * f * (3.0 - 2.0 * f); return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y); }
      float fbm(vec2 q) { return noise(q) * 0.5 + noise(q * 2.0 + 3.1) * 0.3 + noise(q * 4.0 + 1.7) * 0.2; }
      void main(void) {
        vec2 uv = vUv, p = (vUv - 0.5) * vec2(3.5556, 2.0); float t = uTime; // p: centred, y from -1 to 1, square units
        ${PLACES[place]}
        c *= 1.0 - 0.45 * dot(p * vec2(0.42, 0.62), p * vec2(0.42, 0.62)); // vignette: the eye stays in the middle
        gl_FragColor = vec4(gammaCorrectOutput(max(c, 0.0)), 1.0);
      }`,
  }));
  m.setParameter('uTime', 0); m.setParameter('uDrive', 0); m.setParameter('uMood', 0); m.update();
  timed.push(m);
  const e = node(scene.root, shapes.quad(W, H), m, [0, 0, -20]);
  return Object.assign(e, { drive: (v: number) => m.setParameter('uDrive', v), mood: (v: number) => m.setParameter('uMood', v) }); // what the game feeds its world: distance run, heat built, the beat…
}

// ---- a 3D world's big surfaces: the sky behind it, the ground under it, the shade beneath things ------------------------
// The sky is one quad fixed to the camera at the back of the view; `horizon` is where the ground meets it, as a
// fraction of the screen height. Day: sun, drifting clouds, two ranges of hills. Night: stars, a moon, a lit skyline.
// uDrive slides the far scenery sideways a touch as the world moves, so the distance is alive too.
export function sky(scene: Scene, night: boolean, horizon: number, view: View) {
  const m = own(new ShaderMaterial({
    uniqueName: `romp-sky-${night ? 'night' : 'day'}`,
    attributes: { vertex_position: SEMANTIC_POSITION },
    vertexGLSL: `attribute vec3 vertex_position; uniform mat4 matrix_model; uniform mat4 matrix_viewProjection; varying vec2 vUv;
      void main(void) { vUv = vertex_position.xy + 0.5; gl_Position = matrix_viewProjection * matrix_model * vec4(vertex_position, 1.0); }`,
    fragmentGLSL: `#include "gammaPS"
      varying vec2 vUv; uniform float uTime; uniform float uDrive;
      float hash(vec2 q) { return fract(sin(dot(q, vec2(127.1, 311.7))) * 43758.5453); }
      float noise(vec2 q) { vec2 i = floor(q), f = fract(q); f = f * f * (3.0 - 2.0 * f); return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y); }
      float fbm(vec2 q) { return noise(q) * 0.5 + noise(q * 2.0 + 3.1) * 0.3 + noise(q * 4.0 + 1.7) * 0.2; }
      void main(void) {
        float h = ${horizon.toFixed(3)}, up = max(0.0, (vUv.y - h) / (1.0 - h)), x = vUv.x * 1.78, t = uTime; vec3 c;
        ${night ? `c = mix(vec3(0.16, 0.10, 0.36), vec3(0.02, 0.02, 0.09), pow(up, 0.6));
        vec2 sg = vUv * vec2(220.0, 124.0); c += step(0.992, hash(floor(sg))) * smoothstep(0.5, 0.1, length(fract(sg) - 0.5)) * (0.6 + 0.4 * sin(t * 2.0 + hash(floor(sg)) * 50.0)) * smoothstep(0.05, 0.4, up);
        vec2 mo = vec2(x - 1.35, vUv.y - 0.86); c += vec3(1.0, 0.97, 0.85) * (smoothstep(0.052, 0.046, length(mo)) + 0.10 / (1.0 + 300.0 * dot(mo, mo)));
        for (int i = 0; i < 2; i++) { float k = float(i), sx = x * (7.0 + k * 5.0) + uDrive * (0.004 + k * 0.004) + k * 3.3, id = floor(sx), top = h + (0.05 + 0.13 * hash(vec2(id, k))) * (1.0 - k * 0.35);
          float body = step(vUv.y, top) * step(0.08, fract(sx)) * step(h - 0.02, vUv.y); vec2 wq = vec2(fract(sx) * 5.0, (vUv.y - h) * 90.0);
          float lit = step(0.55, hash(floor(wq) + id * 7.0)) * step(0.25, fract(wq.x)) * step(0.3, fract(wq.y));
          c = mix(c, mix(vec3(0.05, 0.04, 0.14), vec3(0.09, 0.07, 0.22), k) + vec3(1.0, 0.8, 0.4) * lit * 0.55, body); }
        c += vec3(0.85, 0.25, 0.6) * 0.22 * exp(-up * 9.0);` : `c = mix(vec3(0.80, 0.91, 0.98), vec3(0.20, 0.50, 0.90), pow(up, 0.7));
        vec2 sn = vec2(x - 0.42, vUv.y - 0.84); c += vec3(1.0, 0.95, 0.75) * (smoothstep(0.06, 0.052, length(sn)) + 0.18 / (1.0 + 60.0 * dot(sn, sn)));
        float cl = smoothstep(0.50, 0.78, fbm(vec2(x * 2.2 + t * 0.012 + uDrive * 0.0006, vUv.y * 7.0))) * smoothstep(0.08, 0.35, up) * (1.0 - smoothstep(0.75, 1.0, up)); c = mix(c, vec3(1.0), cl * 0.9);
        float far = h + 0.030 + 0.028 * sin(x * 4.0 + uDrive * 0.002 + 1.0) + 0.014 * sin(x * 11.0 + uDrive * 0.004), nearH = h + 0.008 + 0.022 * sin(x * 2.6 + uDrive * 0.004 + 4.0) + 0.008 * sin(x * 17.0);
        c = mix(c, vec3(0.55, 0.70, 0.80), smoothstep(far + 0.002, far - 0.002, vUv.y)); c = mix(c, vec3(0.36, 0.58, 0.50), smoothstep(nearH + 0.002, nearH - 0.002, vUv.y));`}
        gl_FragColor = vec4(gammaCorrectOutput(c), 1.0);
      }`,
  }));
  m.depthWrite = false; m.setParameter('uTime', 0); m.setParameter('uDrive', 0); m.update();
  timed.push(m);
  const far = view.far * 0.96, tall = 2 * far * Math.tan((view.fov * Math.PI) / 360), e = node(scene.camera, shapes.quad(1, 1), m, [0, 0, -far]);
  e.setLocalScale(tall * (W / H) * 1.1, tall * 1.1, 1);
  return { drive: (v: number) => m.setParameter('uDrive', v) };
}

// The ground of a 3D game in one shader: `tracks` are the x of each road's centre. Grass is mown in bands (or, in the
// city, paved in slabs), the road is asphalt with two dashed lane lines, solid edges and a kerb; everything scrolls with
// uDrive (distance travelled), lines stay crisp into the distance, and it fades into the fog colour like the rest.
export function ground(scene: Scene, o: { tracks: number[]; lane: number; city: boolean; fog: string; fogFrom: number; fogTo: number; size: [number, number]; z: number }) {
  const m = own(new ShaderMaterial({
    uniqueName: `romp-ground-${o.city ? 'city' : 'park'}`,
    attributes: { vertex_position: SEMANTIC_POSITION },
    vertexGLSL: `attribute vec3 vertex_position; uniform mat4 matrix_model; uniform mat4 matrix_view; uniform mat4 matrix_viewProjection; varying vec3 vW; varying float vDepth;
      void main(void) { vec4 w = matrix_model * vec4(vertex_position, 1.0); vW = w.xyz; vDepth = -(matrix_view * w).z; gl_Position = matrix_viewProjection * w; }`,
    fragmentGLSL: `#include "gammaPS"
      varying vec3 vW; varying float vDepth; uniform float uDrive; uniform vec3 uFog; uniform vec2 uFogRange; uniform vec2 uTracks; uniform float uLane;
      float hash(vec2 q) { return fract(sin(dot(q, vec2(127.1, 311.7))) * 43758.5453); }
      float noise(vec2 q) { vec2 i = floor(q), f = fract(q); f = f * f * (3.0 - 2.0 * f); return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y); }
      void main(void) {
        float z = vW.z - uDrive, soft = 0.012 + vDepth * 0.0035, dx = min(abs(vW.x - uTracks.x), abs(vW.x - uTracks.y)), half_ = uLane * 1.65;
        ${o.city ? `vec2 slab = vec2(vW.x, z) / 2.2; float joint = smoothstep(0.0, soft * 1.5, min(fract(slab.x), fract(slab.y))); vec3 c = mix(vec3(0.10, 0.10, 0.13), vec3(0.20, 0.20, 0.25) + 0.03 * hash(floor(slab)), joint);`
                 : `float band = step(0.5, fract(z / 9.0)); vec3 c = mix(vec3(0.20, 0.42, 0.10), vec3(0.26, 0.50, 0.13), band) * (0.86 + 0.28 * noise(vec2(vW.x, z) * 1.7)); c = mix(c, vec3(0.30, 0.56, 0.16), smoothstep(0.62, 0.9, noise(vec2(vW.x, z) * 0.35)) * 0.5);`}
        float onRoad = smoothstep(half_ + soft, half_ - soft, dx), kerb = smoothstep(half_ + 0.34 + soft, half_ + 0.34 - soft, dx) * (1.0 - onRoad);
        vec3 kerbC = mix(vec3(0.85, 0.16, 0.16), vec3(0.95), step(0.5, fract(z / 2.4))); c = mix(c, ${o.city ? 'kerbC' : 'vec3(0.62, 0.55, 0.42)'}, kerb);
        vec3 road = ${o.city ? 'vec3(0.13, 0.13, 0.16)' : 'vec3(0.50, 0.47, 0.44)'} * (0.88 + 0.2 * noise(vec2(vW.x * 6.0, z * 1.5))) ;
        float edge = smoothstep(0.07 + soft, 0.07 - soft, abs(dx - (half_ - 0.22))), dash = smoothstep(0.06 + soft, 0.06 - soft, abs(dx - uLane * 0.5)) * step(0.45, fract(z / 5.2));
        road = mix(road, vec3(0.96), max(edge, dash) * 0.92);
        c = mix(c, road, onRoad);
        c = mix(c, uFog, clamp((vDepth - uFogRange.x) / (uFogRange.y - uFogRange.x), 0.0, 1.0));
        gl_FragColor = vec4(gammaCorrectOutput(c), 1.0);
      }`,
  }));
  m.setParameter('uDrive', 0); m.setParameter('uFog', linear(o.fog)); m.setParameter('uFogRange', [o.fogFrom, o.fogTo]); m.setParameter('uTracks', [o.tracks[0], o.tracks[o.tracks.length - 1]]); m.setParameter('uLane', o.lane);
  m.update();
  node(scene.root, shapes.floor(o.size[0], o.size[1]), m, [0, 0, o.z]);
  return { drive: (v: number) => m.setParameter('uDrive', v) };
}

// Shade on the ground under a thing: a soft dark ellipse. Cheap, and the difference between floating and standing.
export function shade() {
  const m = new ShaderMaterial({
    uniqueName: 'romp-shade',
    attributes: { vertex_position: SEMANTIC_POSITION },
    vertexGLSL: `attribute vec3 vertex_position; uniform mat4 matrix_model; uniform mat4 matrix_viewProjection; varying vec2 vAt;
      void main(void) { vAt = vertex_position.xz; gl_Position = matrix_viewProjection * matrix_model * vec4(vertex_position, 1.0); }`,
    fragmentGLSL: `varying vec2 vAt; uniform float uShade; void main(void) { gl_FragColor = vec4(0.0, 0.0, 0.0, smoothstep(0.5, 0.1, length(vAt)) * uShade); }`,
  });
  m.blendType = BLEND_NORMAL; m.depthWrite = false; m.setParameter('uShade', 0.42); m.update();
  return { look: own(m), mesh: shapes.floor(1, 1) };
}

// A strip of triangles rewritten every frame (the hand ribbons). Each vertex knows how far along the strip it is (u)
// and which edge it is on (v), for materials that fade along and across it.
export function ribbon(parent: GraphNode, points: number, material: Material) {
  const mesh = own(new Mesh(device)), positions = new Float32Array(points * 6), indices: number[] = [];
  for (let k = 0; k < points - 1; k++) indices.push(2 * k, 2 * k + 1, 2 * k + 2, 2 * k + 1, 2 * k + 3, 2 * k + 2);
  mesh.setPositions(positions); mesh.setIndices(indices); mesh.setUvs(0, Array.from({ length: points * 2 }, (_, i) => [(i >> 1) / (points - 1), i & 1]).flat()); mesh.update();
  const e = node(parent, mesh, material);
  (e.render!.meshInstances[0]).cull = false; // rewritten every frame; cached bounds would be stale
  return { entity: e, positions, commit() { mesh.setPositions(positions); mesh.update(undefined, false); } };
}

// ---- a round --------------------------------------------------------------------------------------------------------
export type Scene = { root: Entity; camera: Entity; cleanup: (fn: () => void) => void; ambient: (hex: string, k?: number) => void; sky: (hex: string | null) => void; fog: (hex: string, start: number, end: number) => void };
type Tick = (dt: number) => void;
let live: { root: Entity; frame?: CameraFrame; tick?: Tick; t: number; warm: number; hidden: GraphNode[]; cleanups: (() => void)[] } | null = null;
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
  for (const m of timed) m.setParameter('uTime', live.t);
  for (const fn of everyFrame) fn();
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
  const cleanups: (() => void)[] = [];
  live = { root, t: 0, warm: 0, hidden: [], cleanups };
  quality.last = 0;
  return {
    root, camera, cleanup: (fn) => void cleanups.push(fn),
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
    if ((at.root.findComponent('camera') as unknown as { projection: number }).projection === PROJECTION_PERSPECTIVE) { frame.vignette.intensity = 0.42; frame.vignette.inner = 0.55; frame.vignette.outer = 1.35; } // 3D views: the eye is held in the middle
    frame.update();
  }
  canvas.style.visibility = 'hidden';
  at.warm = 3;
  at.tick = tick;
  app.autoRender = true;
}

export function end() {
  if (!live) return;
  for (const fn of live.cleanups) fn();
  timed.length = 0;
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
