// Slice — fruit-slicer with real fruit. A cut is a real cut: the model is split along the line of your swipe
// (two clipped copies of the same mesh), the halves tumble apart and the flesh-coloured cut faces turn to the camera.
// Stars are worth 5, bombs cost 5, the last 10 seconds are a frenzy. Solo owns the stage; together, a half each.
import { Quat, Vec3, type Entity } from 'playcanvas';
import { hardness } from '../meta.ts';
import { clippable, fitted, flat, node, setClip, shapes, show, tint } from '../engine.ts';
import { H, bursts as makeBursts, comboText, divider, hands as makeHands, hitSound, hitStop, music, round, scoreHud, segDist, sfx, swept, zoneHalf, zoneX, type Game } from '../kit.ts';

const R = 0.75, GRAVITY = -9, ROUND = 60, POOL = 18, FRENZY = 10, DEG = 180 / Math.PI;
const SLICE_SPEED = 5; // stage units/s a hand must move to cut — tune on device
const FRUIT = [
  { url: 'apple', flesh: '#fef9c3', cap: 0.62, size: 2 }, { url: 'orange', flesh: '#fdba74', cap: 0.66, size: 2 }, { url: 'watermelon', flesh: '#fb7185', cap: 0.5, size: 2.6 },
  { url: 'pear', flesh: '#fef08a', cap: 0.5, size: 2.2 }, { url: 'lemon', flesh: '#fef9c3', cap: 0.52, size: 1.8 }, { url: 'coconut', flesh: '#fafafa', cap: 0.62, size: 2 },
  { url: 'pineapple', flesh: '#fde047', cap: 0.4, size: 2.8 }, { url: 'strawberry', flesh: '#fda4af', cap: 0.45, size: 1.7 }, { url: 'banana', flesh: '#fef9c3', cap: 0.2, size: 2.6 },
];
const v = new Vec3(), q = new Quat(), turn = new Quat();

type Kind = 'fruit' | 'star' | 'bomb';
type Half = { obj: Entity; cap: Entity; nx: number; ny: number; x: number; y: number; vx: number; vy: number };
type Piece = {
  state: 'off' | 'whole' | 'cut'; kind: Kind; flesh: string; zone: number; x: number; y: number; vx: number; vy: number; spin: number; age: number; rx: number; ry: number;
  whole: Entity; halves: Half[]; along: Vec3; base: Quat;
};

export default async function slice({ n, stage, onEnd, hud, scene }: Game) {
  const hard = hardness(stage);
  const [fruit, bomb, star] = await Promise.all([
    Promise.all(FRUIT.map((f) => fitted(`/assets/food/${f.url}.glb`, R * f.size))), fitted('/assets/kit/bomb.glb', R * 2.1), fitted('/assets/kit/star.glb', R * 1.8),
  ]);
  const capMesh = shapes.circle(1, 24), capLook = flat('#ffffff', { twoSided: true });
  const add = (e: Entity) => { scene.root.addChild(e); e.enabled = false; return e; };

  const pieces: Piece[] = Array.from({ length: POOL }, (_, i) => {
    const kind: Kind = i % 6 === 4 ? 'bomb' : i % 6 === 5 ? 'star' : 'fruit', type = i % FRUIT.length;
    const whole = add((kind === 'bomb' ? bomb : kind === 'star' ? star : fruit[type]).clone());
    // Each half is the whole model again, with its own material clipped by its own plane.
    const halves = kind !== 'fruit' ? [] : [0, 1].map(() => {
      const obj = add(fruit[type].clone()), cap = node(scene.root, capMesh, capLook);
      clippable(obj);
      tint(cap, FRUIT[type].flesh);
      cap.setLocalScale(R * 2 * FRUIT[type].cap, R * 2 * FRUIT[type].cap, 1);
      cap.enabled = false;
      return { obj, cap, nx: 0, ny: 0, x: 0, y: 0, vx: 0, vy: 0 };
    });
    return { state: 'off', kind, flesh: FRUIT[type].flesh, zone: 0, x: 0, y: 0, vx: 0, vy: 0, spin: 0, age: 0, rx: 0, ry: 0, whole, halves, along: new Vec3(), base: new Quat() };
  });
  divider(scene, n);

  const g = { spawnIn: [0, 0], scores: [0, 0], combo: [0, 0] };
  const hands = makeHands(scene, n), bursts = makeBursts(scene.root);
  const tick = round(hud, ROUND, () => { music.stop(); onEnd(g.scores.slice(0, n)); });
  music.start('arcade');

  return (rawDt: number) => {
    const dt = Math.min(rawDt, 0.05), t = tick(rawDt);
    if (t === null) return;
    const frenzy = t > ROUND - FRENZY;

    if (t >= 0)
      for (let z = 0; z < n; z++) {
        if ((g.spawnIn[z] -= dt) > 0) continue;
        g.spawnIn[z] = (frenzy ? 0.32 : 1 - 0.5 * (t / ROUND) + Math.random() * 0.3) / hard;
        const free = pieces.filter((p) => p.state === 'off' && !(frenzy && p.kind === 'bomb') && !(p.kind === 'bomb' && t < 6));
        const piece = free[Math.floor(Math.random() * free.length)];
        if (!piece) continue;
        const side = Math.random() * 2 - 1;
        Object.assign(piece, {
          state: 'whole', zone: z, spin: Math.random() * 4 - 2, x: zoneX(n, z) + side * zoneHalf(n) * 0.7, y: -H / 2 - R,
          vx: -side * (0.5 + Math.random()), vy: (piece.kind === 'star' ? 11.5 : 10) + Math.random() * 2, rx: Math.random() * 360, ry: Math.random() * 360,
        });
      }

    for (const h of hands.update(dt)) {
      if (t < 0 || !h.on || h.speed < SLICE_SPEED) continue;
      for (const pc of pieces) {
        // Fruit is judged kindly (anywhere along the last ~100ms of the swing); a bomb only if this very step went through its core.
        if (pc.state !== 'whole' || pc.zone !== h.p || !(pc.kind === 'bomb' ? segDist(pc.x, pc.y, h.px, h.py, h.x, h.y) < R * 0.9 : swept(h, pc.x, pc.y, R * 1.25))) continue;
        if (pc.kind === 'bomb') {
          hitStop(130);
          pc.state = 'off';
          g.scores[h.p] = Math.max(0, g.scores[h.p] - 5); g.combo[h.p] = 0;
          sfx('impactPlate_heavy'); sfx('lowDown', { vol: 0.6 }); hud.flash('#ef4444'); hud.shake(1.5); bursts.burst(pc.x, pc.y, 0.5, '#ef4444', 50, 12);
          continue;
        }
        g.scores[h.p] += (pc.kind === 'star' ? 5 : 1) + Math.floor(++g.combo[h.p] / 5);
        hitSound(pc.kind === 'star' ? 'powerUp' : 'impactSoft_heavy', g.combo[h.p], 0.7);
        if (pc.kind === 'star' || g.combo[h.p] % 5 === 0) hitStop(pc.kind === 'star' ? 80 : 50); // the blade bites
        if (pc.kind === 'star') { pc.state = 'off'; bursts.burst(pc.x, pc.y, 0.5, '#fde047', 36, 9); continue; }
        // The cut: `along` is the swipe direction; each half keeps one side of the plane through the fruit's centre.
        const len = Math.hypot(h.x - h.px, h.y - h.py) || 1;
        pc.along.set((h.x - h.px) / len, (h.y - h.py) / len, 0);
        pc.base.copy(pc.whole.getLocalRotation());
        pc.state = 'cut'; pc.age = 0;
        pc.halves.forEach((half, k) => {
          const s = k ? -1 : 1;
          half.nx = -pc.along.y * s; half.ny = pc.along.x * s;
          Object.assign(half, { x: pc.x, y: pc.y, vx: pc.vx + half.nx * 2.6, vy: pc.vy * 0.4 + half.ny * 2.6 + 2 });
        });
        bursts.burst(pc.x, pc.y, 0.5, pc.flesh, 14, 6);
      }
    }

    for (const pc of pieces) {
      if (show(pc.whole, pc.state === 'whole')) {
        pc.vy += GRAVITY * dt; pc.x += pc.vx * dt; pc.y += pc.vy * dt;
        pc.rx += pc.spin * dt * DEG; pc.ry += pc.spin * dt * 0.7 * DEG;
        pc.whole.setLocalPosition(pc.x, pc.y, 0);
        pc.whole.setLocalEulerAngles(pc.rx, pc.ry, 0);
        if (pc.y < -H / 2 - 2 * R) { pc.state = 'off'; if (pc.kind !== 'bomb') g.combo[pc.zone] = 0; }
      }
      if (pc.state === 'cut' && (pc.age += dt) > 1.2) pc.state = 'off';
      // Each half swings open about the line of the cut, so its cut face rolls round to face the camera.
      const open = Math.min(1.25, pc.age * 3.2), cos = Math.cos(open), sin = Math.sin(open);
      pc.halves.forEach((half, k) => {
        const on = pc.state === 'cut';
        show(half.obj, on); show(half.cap, on);
        if (!on) return;
        half.vy += GRAVITY * dt; half.x += half.vx * dt; half.y += half.vy * dt;
        half.obj.setLocalPosition(half.x, half.y, 0);
        half.obj.setLocalRotation(q.copy(turn.setFromAxisAngle(pc.along, (k ? open : -open) * DEG)).mul(pc.base));
        v.set(half.nx * cos, half.ny * cos, -sin); // the plane's normal, swung with the half
        setClip(half.obj, v.x, v.y, v.z, -(v.x * half.x + v.y * half.y));
        half.cap.setLocalPosition(half.x + v.x * 0.01, half.y + v.y * 0.01, v.z * 0.01);
        // Turn the cap (which faces +z) to face back along the normal: the shortest rotation from +z to -v.
        const w = 1 - v.z;
        half.cap.setLocalRotation(w < 1e-6 ? q.set(1, 0, 0, 0) : q.set(v.y, -v.x, 0, w).normalize());
      });
    }
    bursts.update(dt);
    music.intensity(frenzy ? 1 : 0.3 + Math.max(g.combo[0], g.combo[1]) / 16);
    scoreHud(hud, n, g.scores);
    for (let p = 0; p < n; p++) hud.p('h', p, frenzy && g.combo[p] < 5 ? 'Frenzy!' : comboText(g.combo[p]));
  };
}
