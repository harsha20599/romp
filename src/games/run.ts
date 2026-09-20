// Run — a three-lane endless runner you steer with your body: lean to change lane, jump the barrels,
// duck the beams, dodge the crate stacks, sweep up coins, grab power-ups. Forest on the early stages, city later.
// Two runners side by side share one obstacle sequence, so together-play is a fair race. Lean + vertical only: compact.
import type { AnimTrack, Asset, ContainerResource, Entity, MeshInstance, StandardMaterial } from 'playcanvas';
import { isAir, isLow, players } from '../pose.ts';
import { hardness } from '../meta.ts';
import { boundsOf, color, fitted, flat, glowLook, ground, instanced, instantiate, lit, node, own, shade, shapes, show, sky, type View } from '../engine.ts';
import { PLAYER_COLORS, bursts as makeBursts, hitSound, hitStop, music, round, say, scoreHud, sfx, type Game } from '../kit.ts';

const ROUND = 75, FAR = -70, LANE = 1.7, WINDOW = 1.1, POWER_TIME = 8, DEG = 180 / Math.PI;
const A = '/assets/kit/', C = '/assets/city/';
const FOREST = { sky: '#7dd3fc', ground: '#3f6212', road: '#a8a29e', props: [A + 'tree.glb', A + 'tree-pine.glb', A + 'rocks.glb', A + 'tree.glb', A + 'mushrooms.glb', A + 'tree-pine.glb'], size: [4.5, 5.5, 1.6, 5, 1.2, 6] };
const CITY = { sky: '#1e1b4b', ground: '#27272a', road: '#3f3f46', props: ['a', 'c', 'e', 'skyscraper-a', 'g', 'skyscraper-b'].map((b) => `${C}building-${b}.glb`), size: [7, 8, 7, 14, 8, 16] };

type Kind = 'barrels' | 'beam' | 'crates' | 'coins' | 'magnet' | 'shield' | 'double';
// `obj` moves down the track; `parts` are what is inside it (the five coins of a row, or the one power-up that spins).
type Thing = { live: boolean; kind: Kind; lanes: number[]; z: number; cleared: boolean; taken: boolean[]; obj: Entity; parts: Entity[] };
const HINT: Partial<Record<Kind, string>> = { barrels: 'Jump!', beam: 'Duck!', crates: 'Change lane!' };

export const view: View = { position: [0, 4.4, 8.5], fov: 55, near: 0.1, far: 140, lookAt: [0, 1.6, -12] };

export default async function runGame({ n, stage, onEnd, hud, scene }: Game) {
  const hard = hardness(stage), theme = stage >= 3 ? CITY : FOREST;
  const trackX = (p: number) => (n === 1 ? 0 : (p - 0.5) * 8.4);
  // The world: a real sky behind (sun, clouds and hills — or stars, a moon and a lit skyline for the city stages), a
  // ground drawn in one shader (mown grass or paving, asphalt, lane lines, kerbs), and haze the colour of the horizon.
  const night = theme === CITY, haze = night ? '#2b1a5c' : '#cfe8f5', tracks = Array.from({ length: n }, (_, p) => trackX(p));
  scene.sky(haze); scene.fog(haze, 34, 80); scene.ambient(night ? '#aab4ff' : '#fff6e5', night ? 0.6 : 0.85);
  const heaven = sky(scene, night, 0.63, view), earth = ground(scene, { tracks, lane: LANE, city: night, fog: haze, fogFrom: 34, fogTo: 80, size: [220, -FAR + 60], z: FAR / 2 - 5 });

  // Models: every instance is a clone of one fitted original.
  const N = '/assets/nature/', small = night ? [C + 'detail-parasol-a.glb', C + 'detail-parasol-b.glb', A + 'flag.glb', A + 'crate.glb', A + 'barrel.glb', A + 'fence-straight.glb'] : [N + 'plant_bush.glb', N + 'flower_redA.glb', N + 'grass_large.glb', N + 'plant_bushLarge.glb', N + 'flower_yellowA.glb', N + 'stump_round.glb', N + 'rock_largeA.glb', N + 'flower_purpleA.glb', N + 'log_stack.glb', N + 'mushroom_redGroup.glb', N + 'fence_simple.glb', N + 'sign.glb'];
  const smallSize = night ? [2.2, 2.2, 2.4, 1.2, 1.2, 1.8] : [1.5, 0.8, 0.9, 2.2, 0.8, 1.0, 1.6, 0.8, 1.8, 0.9, 1.6, 1.4];
  const distant = night ? [C + 'low-detail-building-a.glb', C + 'low-detail-building-c.glb', C + 'low-detail-building-e.glb', C + 'low-detail-building-wide-a.glb'] : [N + 'tree_oak.glb', N + 'tree_fat.glb', N + 'tree_detailed.glb', N + 'tree_pineTallA.glb'];
  const [barrel, crate, coin, star, heart, props, robots, nearProps, farProps] = await Promise.all([
    fitted(A + 'barrel.glb', 1.35, true), fitted(A + 'crate-strong.glb', 1.6, true), fitted(A + 'coin-gold.glb', 0.8), fitted(A + 'star.glb', 1.2), fitted(A + 'heart.glb', 1.2),
    Promise.all(theme.props.map((url, i) => fitted(url, theme.size[i], true))), Promise.all(Array.from({ length: n }, () => instantiate('/assets/robot.glb'))),
    Promise.all(small.map((url, i) => fitted(url, smallSize[i], true))), Promise.all(distant.map((url, i) => fitted(url, night ? 15 + i * 3 : 9 + i * 1.5, true))),
  ]);

  const root = node(scene.root);
  const dark = shade(), gold = glowLook('#fde047', 0.75), glowQuad = shapes.quad(2, 2);
  const glow = (hex: string) => lit(hex, { emissive: hex, glow: 1.5 });
  // Built once and shared by every beam and magnet that ever spawns — nothing is allocated on the GPU mid-run.
  const barMesh = shapes.box(LANE * 3.4, 0.5, 0.5), postMesh = shapes.box(0.3, 2.7, 0.3), ringMesh = shapes.arch(0.5, 0.16);
  const barLook = glow('#22d3ee'), postLook = lit('#52525b'), ringLook = glow('#ef4444');
  const put = (group: Entity, template: Entity, x: number, y: number, z: number) => { const e = template.clone() as Entity; e.setLocalPosition(x, y, z); group.addChild(e); return e; };
  const build: Record<Kind, (group: Entity, lanes: number[]) => Entity[]> = {
    barrels: (g) => { node(g, dark.mesh, dark.look, [0, 0.03, 0]).setLocalScale(LANE * 3.4, 1, 1.9); return [-1, 0, 1].map((l) => put(g, barrel, l * LANE, 0, 0)); },
    beam: (g) => [node(g, barMesh, barLook, [0, 2.45, 0]), ...[-1, 1].map((s) => node(g, postMesh, postLook, [s * LANE * 1.7, 1.35, 0]))],
    crates: (g, lanes) => lanes.flatMap((l) => { node(g, dark.mesh, dark.look, [l * LANE, 0.03, 0]).setLocalScale(2.3, 1, 2.3); return [0, 1.6].map((y) => put(g, crate, l * LANE, y, 0)); }),
    coins: (g, lanes) => Array.from({ length: 5 }, (_, k) => { const c = put(g, coin, lanes[0] * LANE, 1.1, -k * 1.7); node(c, glowQuad, gold, [0, 0, -0.1]).setLocalScale(0.9, 0.9, 1); return c; }),
    magnet: (g, lanes) => [node(g, ringMesh, ringLook, [lanes[0] * LANE, 1.3, 0])],
    shield: (g, lanes) => { node(g, glowQuad, gold, [lanes[0] * LANE, 1.3, -0.2]).setLocalScale(1.7, 1.7, 1); return [put(g, heart, lanes[0] * LANE, 1.3, 0)]; },
    double: (g, lanes) => { node(g, glowQuad, gold, [lanes[0] * LANE, 1.3, -0.2]).setLocalScale(1.7, 1.7, 1); return [put(g, star, lanes[0] * LANE, 1.3, 0)]; },
  };
  // One of each, hidden: the stage warms up whatever is in the scene before "Go", so the first barrel costs nothing.
  (Object.keys(build) as Kind[]).forEach((kind) => { const g = node(root); build[kind](g, [0]); g.enabled = false; });
  // Scenery: a conveyor of props down both sides, recycled to the far end as they pass the camera.
  const edge = (n === 1 ? 0 : 4.2) + LANE * 1.65 + 0.6, span = -FAR + 12;
  const row = (count: number, pick: (i: number) => Entity, x: (i: number, side: number) => number) => Array.from({ length: count }, (_, i) => {
    const side = i % 2 ? 1 : -1, px = side * x(i, side), z = FAR + ((i + Math.random() * 0.6) / count) * span, e = put(root, pick(i), px, 0, z);
    e.setLocalEulerAngles(0, Math.random() * 360, 0);
    return { e, x: px, z };
  });
  // Three depths of scenery, so the world has a front, a middle and a back: small things right by the kerb (they
  // whip past — that is where speed is felt), the trees or buildings behind them, and big far ones that barely move.
  const scenery = [
    ...row(44, (i) => nearProps[i % nearProps.length], () => edge + 0.4 + Math.random() * 2.2),
    ...row(28, (i) => props[i % 6], (i) => edge + 3.2 + theme.size[i % 6] * 0.45 + Math.random() * 3),
    ...row(16, (i) => farProps[i % farProps.length], () => edge + (night ? 24 : 12) + Math.random() * 10),
  ];
  // Air rushing past: faint streaks, out at the sides only (never across the road you are reading), once you are really moving.
  const STREAKS = 26, air = instanced(scene.root, shapes.quad(0.02, 1), STREAKS, 0.5), wind = Array.from({ length: STREAKS }, (_, i) => { air.paint(i, '#ffffff'); return { x: (i % 2 ? -1 : 1) * (4 + Math.random() * 8), y: 0.6 + Math.random() * 6, z: FAR * Math.random() }; });

  // Runners: a skinned model each, with its own animation state. Running loops; Jump and Sitting are held poses we blend into.
  const bubbleMesh = shapes.sphere(1.5, 16), bubbleLook = flat('#f472b6', { opacity: 0.25 });
  const runners = robots.map(({ entity: model, asset }, p) => {
    const holder = node(scene.root), meshes = (model.findComponents('render') as unknown as { meshInstances: MeshInstance[] }[]).flatMap((r) => r.meshInstances);
    const k = 2.1 / (boundsOf(model).halfExtents.y * 2); // every robot is 2.1 tall
    model.setLocalScale(k, k, k);
    model.setLocalEulerAngles(0, 180, 0); // face up the track, away from the camera
    const paints = new Map<StandardMaterial, StandardMaterial>();
    for (const mi of meshes) {
      const was = mi.material as StandardMaterial;
      if (was.name !== 'Main') continue;
      if (!paints.has(was)) { const m = own(was.clone()); m.diffuse = color(PLAYER_COLORS[p]); m.update(); paints.set(was, m); }
      mi.material = paints.get(was)!;
    }
    holder.addChild(model);
    model.addComponent('anim', { activate: true });
    const anim = model.anim!;
    anim.loadStateGraph({
      layers: [{ name: 'base', states: [{ name: 'START' }, { name: 'Running', speed: 1, loop: true }, { name: 'Jump', speed: 1, loop: false }, { name: 'Sitting', speed: 1, loop: false }], transitions: [{ from: 'START', to: 'Running', time: 0, priority: 0 }] }],
      parameters: {},
    });
    for (const name of ['Running', 'Jump', 'Sitting']) anim.assignAnimation(name, (asset.resource as ContainerResource & { animations: Asset[] }).animations.map((a) => a.resource as AnimTrack).find((track) => track.name === name)!);
    const bubble = node(holder, bubbleMesh, bubbleLook, [0, 1.1, 0]), shadow = node(scene.root, dark.mesh, dark.look, [0, 0.04, 0]);
    return { holder, anim, bubble, shadow, paints, now: 'Running', x: 0 };
  });
  const things: Thing[][] = Array.from({ length: n }, () => []), look = { x: 0, y: 0 };

  const bursts = makeBursts(scene.root);
  const g = { dist: 0, nextRow: 30, row: 0, step: 0, scores: [0, 0], combo: [0, 0], hurt: [0, 0], magnet: [0, 0], double: [0, 0], shield: [false, false], said: [{ text: '', until: 0 }, { text: '', until: 0 }] };
  const tick = round(hud, ROUND, () => { music.stop(); onEnd(g.scores.slice(0, n).map(Math.round)); });
  music.start('run');

  const spawn = (t: number) => {
    // A rhythm of obstacle, coins, obstacle, coins… with a power-up now and then. Same row for every runner.
    const r = g.row++, lane = () => Math.floor(Math.random() * 3) - 1;
    let kind: Kind, lanes: number[];
    if (r % 9 === 8) { kind = (['magnet', 'shield', 'double'] as Kind[])[Math.floor(Math.random() * 3)]; lanes = [lane()]; }
    else if (r % 2) { kind = 'coins'; lanes = [lane()]; }
    else {
      kind = (['barrels', 'beam', 'crates'] as Kind[])[t < 8 ? (r / 2) % 3 : Math.floor(Math.random() * 3)];
      const open = lane();
      lanes = kind === 'crates' ? [-1, 0, 1].filter((l) => l !== open && (hard > 1.3 || Math.random() < 0.6 || l === -open)) : [-1, 0, 1];
      if (kind === 'crates' && !lanes.length) lanes = [open === 0 ? 1 : 0];
    }
    things.forEach((list, p) => {
      const obj = node(root, undefined, undefined, [trackX(p), 0, FAR]);
      list.push({ live: true, kind, lanes, z: FAR, cleared: false, taken: [], obj, parts: build[kind](obj, lanes) });
    });
  };

  return (rawDt: number) => {
    const dt = Math.min(rawDt, 0.05), t = tick(rawDt);
    if (t === null) return;
    const speed = (13 + 9 * Math.max(0, t / ROUND)) * hard, move = speed * dt;
    g.dist += move;
    if (t >= 0 && g.dist > g.nextRow) { g.nextRow = g.dist + Math.max(11, 24 - 8 * (t / ROUND)) / Math.sqrt(hard) + 4; spawn(t); }
    if ((g.step -= dt) < 0) { g.step = 3.4 / speed; sfx('footstep_concrete', { vol: 0.25 }); }

    for (let p = 0; p < n; p++) {
      const pl = players[p], R = runners[p], list = things[p];
      const air = isAir(pl), low = isLow(pl); // from the moment the move is clearly under way, not when it completes
      // Analog steering: the runner is wherever your body puts it, continuously — with a gentle pull toward the
      // nearest lane centre so you settle into lanes instead of hovering on the lines.
      const free = pl.steer * LANE * 1.1, target = free + (Math.round(free / LANE) * LANE - free) * 0.35;
      R.x += (Math.max(-LANE * 1.1, Math.min(LANE * 1.1, target)) - R.x) * Math.min(1, dt * 18);
      const inLane = Math.round(R.x / LANE);
      show(R.holder, pl.present);
      R.holder.setLocalPosition(trackX(p) + R.x, Math.max(0, pl.lift) * 2.4, 0);
      // The robot leans as you lean, and turns a little into a lane change.
      R.holder.setLocalEulerAngles(0, (target - R.x) * -0.25 * DEG, (-pl.steer * 0.3 + (g.hurt[p] > 0 ? Math.sin(t * 40) * 0.15 : 0)) * DEG);
      show(R.bubble, g.shield[p]);
      if (show(R.shadow, pl.present)) { const up = Math.max(0, pl.lift) * 2.4, k = 1.7 / (1 + up * 0.5); R.shadow.setLocalPosition(trackX(p) + R.x, 0.04, 0.1); R.shadow.setLocalScale(k, 1, k * 0.8); } // the shadow stays on the road and shrinks as you leave it
      // The runner is your body, continuously: it sinks as you start to bend and stretches as you rise, before any
      // jump or duck has "triggered" — so the screen answers the first centimetre of every move.
      const bend = Math.max(-0.3, Math.min(0.12, pl.lift * 0.4));
      R.holder.setLocalScale(1 - bend * 0.5, 1 + bend, 1);
      const want = air ? 'Jump' : low ? 'Sitting' : 'Running';
      if (want !== R.now) {
        R.anim.baseLayer?.transition(want, 0.08);
        // Every move is answered the instant it is seen: a whoosh and dust at take-off, a thud on landing, a scrape into the slide.
        if (t >= 0 && pl.present) {
          sfx(want === 'Jump' ? 'maximize' : want === 'Sitting' ? 'minimize' : 'impactSoft_heavy', { vol: want === 'Running' ? 0.3 : 0.45 });
          if (want !== 'Sitting') bursts.burst(trackX(p) + R.x, 0.15, 0.3, '#e7e5e4', 10, 3);
        }
        R.now = want;
      }
      R.anim.speed = R.now === 'Running' ? speed / 11 : 1;

      let next: Thing | undefined;
      for (const th of list) {
        if (!th.live) continue;
        th.z += move;
        th.obj.setLocalPosition(trackX(p), 0, th.z);
        const near = Math.abs(th.z) < WINDOW;
        if (th.kind === 'coins') {
          th.parts.forEach((c, k) => {
            if (!c.enabled) return;
            c.rotateLocal(0, dt * 5 * DEG, 0);
            const cz = th.z - k * 1.7, magnet = g.magnet[p] > t && Math.abs(cz) < 6, at = c.getLocalPosition();
            if (magnet) c.setLocalPosition(at.x + (R.x - at.x) * Math.min(1, dt * 10), at.y, at.z); // coins swing toward you
            if (pl.present && Math.abs(cz) < 0.9 && (magnet || th.lanes[0] === inLane) && !air) {
              c.enabled = false;
              g.scores[p] += 10 * (g.double[p] > t ? 2 : 1);
              hitSound('pepSound', th.taken.push(true), 0.5);
              bursts.burst(trackX(p) + R.x, 1.1, 0, '#fde047', 6, 4);
            }
          });
        } else if (th.kind === 'magnet' || th.kind === 'shield' || th.kind === 'double') {
          th.parts[0].rotateLocal(0, dt * 3 * DEG, 0);
          if (near && pl.present && th.lanes[0] === inLane && !th.cleared) {
            th.cleared = true; th.obj.enabled = false;
            if (th.kind === 'shield') g.shield[p] = true; else g[th.kind][p] = t + POWER_TIME;
            sfx('powerUp', { vol: 0.9 }); say('power_up');
            g.said[p] = { text: { magnet: 'Magnet!', shield: 'Shield!', double: 'Double coins!' }[th.kind], until: t + 1.5 };
            bursts.burst(trackX(p) + R.x, 1.3, 0, '#f472b6', 30, 8);
          }
        } else {
          if (near && (th.kind === 'barrels' ? air : th.kind === 'beam' ? low : !th.lanes.includes(inLane))) th.cleared = true; // any moment in the window counts
          if (near && th.kind === 'crates' && th.lanes.includes(inLane)) th.cleared = false; // …except being inside a crate
          if (th.z < -WINDOW && (!next || th.z > next.z)) next = th;
          if (th.z >= WINDOW && !th.taken.length) {
            th.taken.push(true);
            if (!pl.present) { /* nobody running on this track */ }
            else if (th.cleared) { g.scores[p] += 15 * (1 + Math.min(20, ++g.combo[p]) / 10); hitSound('phaseJump', g.combo[p], 0.35); }
            else if (g.shield[p]) { g.shield[p] = false; sfx('impactGlass_heavy'); bursts.burst(trackX(p) + R.x, 1.2, 0, '#f472b6', 40, 10); g.said[p] = { text: 'Shield saved you', until: t + 1.2 }; }
            else {
              g.combo[p] = 0; g.hurt[p] = 0.5;
              sfx(th.kind === 'beam' ? 'impactMetal_heavy' : 'impactWood_heavy'); hud.shake(); hud.flash('#ef4444'); hitStop(110);
              bursts.burst(trackX(p) + R.x, 1.2, 0, th.kind === 'beam' ? '#22d3ee' : '#b45309', 40, 11); // the obstacle goes to splinters
              th.obj.enabled = false;
            }
          }
        }
        if (th.z > 12) { th.live = false; th.obj.destroy(); }
      }
      things[p] = list.filter((th) => th.live);
      g.hurt[p] = Math.max(0, g.hurt[p] - dt);
      const power = g.magnet[p] > t ? `Magnet ${Math.ceil(g.magnet[p] - t)}s` : g.double[p] > t ? `Double ${Math.ceil(g.double[p] - t)}s` : '';
      hud.p('h', p, g.said[p].until > t ? g.said[p].text : t < 25 && next && next.z > -30 ? HINT[next.kind]! : power || (g.combo[p] >= 3 ? `×${(1 + Math.min(20, g.combo[p]) / 10).toFixed(1)}` : ''));
    }
    music.intensity(0.3 + Math.max(g.combo[0], g.combo[1]) / 14);

    for (const s of scenery) { if ((s.z += move) > 12) s.z += FAR - 12; s.e.setLocalPosition(s.x, 0, s.z); }
    heaven.drive(g.dist); earth.drive(g.dist);
    const rush = Math.min(1, Math.max(0, t / ROUND) * 0.9 + (hard - 1) * 0.15); // how far into its top speed this run is
    wind.forEach((w, i) => { if ((w.z += move * 2.2) > 9) { w.z = FAR * (0.4 + 0.6 * Math.random()); w.x = (Math.random() < 0.5 ? -1 : 1) * (4 + Math.random() * 8); w.y = 0.6 + Math.random() * 6; } air.place(i, w.x, w.y, w.z, 1 + rush * 3); air.fade(i, Math.max(0, rush - 0.25) * 0.3); });
    air.commit();
    // The camera runs with you: it leans into your lean, sinks a little in a slide, and the view widens as the pace picks up.
    const lead = players[0], sway = n === 1 ? lead.steer * 0.9 : 0, cam = scene.camera;
    look.x += (sway - look.x) * Math.min(1, dt * 5); look.y += ((isLow(lead) && n === 1 ? -0.5 : 0) - look.y) * Math.min(1, dt * 6);
    cam.setPosition(look.x * 0.8, 4.4 + look.y + Math.sin(g.dist * 0.9) * 0.035, 8.5); cam.lookAt(look.x * 1.6, 1.6 + look.y * 0.5, -12); cam.rotateLocal(0, 0, -look.x * 2.2);
    cam.camera!.fov = 55 + Math.min(9, rush * 9);
    bursts.update(dt);
    scoreHud(hud, n, g.scores);
  };
}
