// Shape Up — hole-in-the-wall. A wall rushes at you with a shape cut for a body; be that shape when it lands.
// The target is drawn as thick neon limbs and YOU as a thin bright skeleton on top of it, so neither hides the
// other: you can see yourself sitting inside the shape. Every limb lights green on its own the moment it matches.
// Poses use the full wingspan, so this one is solo or take-turns only (PLAN §3: "wide" footprint).
import type { GraphNode } from 'playcanvas';
import { hardness } from '../meta.ts';
import { players, poseMatch as match, sim } from '../pose.ts';
import { backdrop, fade, flat, node, shapes, show, tint } from '../engine.ts';
import { bursts as makeBursts, hitSound, music, round, sfx, type Game } from '../kit.ts';

const D = Math.PI / 180, SHOW = 1.1, POSES_PER_ROUND = 8; // SHOW = seconds the verdict stays up
const LEGS = [-95, -90, -85, -90];
// Limb angles in degrees, screen space (0 = pointing right, 90 = up), in pose.ts LIMBS order:
// screen-left upper arm, forearm, screen-right upper arm, forearm, then thigh, shin for each leg.
const POSES: [string, number[]][] = ([
  ['T', [180, 180, 0, 0, ...LEGS]], ['Y', [135, 135, 45, 45, ...LEGS]], ['Reach up', [100, 95, 80, 85, ...LEGS]],
  ['Goalposts', [180, 90, 0, 90, ...LEGS]], ['One up, one out', [100, 95, 0, 0, ...LEGS]], ['One out, one up', [180, 180, 80, 85, ...LEGS]],
  ['Star', [150, 150, 30, 30, -120, -115, -60, -65]], ['Hands on hips', [-135, -45, -45, -135, ...LEGS]], ['Wide squat', [180, 180, 0, 0, -150, -90, -30, -90]],
  ['Diagonal', [135, 135, -45, -45, ...LEGS]], ['Leg out', [100, 95, 80, 85, -135, -130, -85, -90]], ['T with a kick', [180, 180, 0, 0, -95, -90, -45, -50]],
  ['Crossed up high', [45, 45, 135, 135, ...LEGS]], ['Teapot', [180, 90, -45, -135, ...LEGS]], ['Y squat', [135, 135, 45, 45, -150, -90, -30, -90]],
  ['Knee up', [-100, -95, 80, 85, -95, -90, -40, -120]],
] as [string, number[]][]).map(([name, pose]) => [name, pose.map((deg) => deg * D)]);
const STAND = [-100, -95, -80, -85, ...LEGS].map((deg) => deg * D);

// A figure built from 8 limb angles. Same skeleton for target and player, so they are directly comparable.
const JOINTS = [[-0.75, 2], [0, 0], [0.75, 2], [0, 0], [-0.4, 0], [0, 0], [0.4, 0], [0, 0]]; // even slots; odd ones chain on
const LENGTHS = [1.1, 1, 1.1, 1, 1.5, 1.4, 1.5, 1.4];
function makeFigure(parent: GraphNode, width: number, hex: string, opacity: number, z: number) {
  const group = node(parent, undefined, undefined, [0, 0, z]), look = flat(hex, { opacity });
  const limbMesh = shapes.limb(width / 2); // rounded, pivots at its near end
  const limbs = LENGTHS.map((len) => { const e = node(group, limbMesh, look); e.setLocalScale(len, 1, 1); return e; });
  const body = [node(group, shapes.capsule(width * 0.9, 1.5 + width * 0.8), look, [0, 1, 0]), node(group, shapes.circle(0.34 + width * 0.35, 28), look, [0, 2.8, 0])];
  const pose = (angles: number[]) => {
    let x = 0, y = 0;
    angles.forEach((a, i) => {
      if (i % 2 === 0) [x, y] = JOINTS[i];
      limbs[i].setLocalPosition(x, y, 0);
      limbs[i].setLocalEulerAngles(0, 0, a / D);
      x += Math.cos(a) * LENGTHS[i];
      y += Math.sin(a) * LENGTHS[i];
    });
  };
  return { group, limbs, body, pose };
}
const COLD = '#ff4d8d', WARM = '#ffe14d', HOT = '#7dff7a';
const limbError = (a: number, b: number) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b))) / D;

export default function shapeUp({ stage, onEnd, hud, scene }: Game) {
  const PER_POSE = Math.max(3.2, 5.2 / hardness(stage)); // less time to find the shape on higher stages
  backdrop(scene, 'studio');
  const world = node(scene.root, undefined, undefined, [0, -0.9, 0]);
  world.setLocalScale(0.95, 0.95, 0.95);
  const wall = node(world, undefined, undefined, [0, 1.35, -1]);
  const fill = node(wall, shapes.quad(8.6, 7.4), flat('#a78bfa', { opacity: 0.2 })), frame = node(wall, shapes.ring(5.2, 5.5, 4, Math.PI / 4), flat('#ffe14d', { opacity: 1 }));
  frame.setLocalScale(1.17, 1, 1);
  const target = makeFigure(world, 0.62, COLD, 0.8, 0), me = makeFigure(world, 0.16, '#3de1ff', 1, 1);
  const bursts = makeBursts(world);
  const g = { order: [...POSES].sort(() => Math.random() - 0.5), score: 0, best: 0, last: 0, judged: -1, streak: 0 };
  const tick = round(hud, POSES_PER_ROUND * PER_POSE, () => { music.stop(); onEnd([g.score]); });
  music.start('dance', undefined, 0.5);

  return (rawDt: number) => {
    const dt = Math.min(rawDt, 0.05), t = tick(rawDt);
    if (t === null) return;
    const i = Math.floor(Math.max(0, t) / PER_POSE), into = Math.max(0, t) - i * PER_POSE, [name, pose] = g.order[i % g.order.length];
    const flying = into < PER_POSE - SHOW, near = Math.min(1, into / (PER_POSE - SHOW));
    // ponytail: ?sim has no skeleton, so the sim player simply copies the target while the right hand is raised.
    const mine = players[0].angles ?? (sim && players[0].hands[1].y > 0.5 ? pose : STAND);
    const now = match(mine, pose);

    target.pose(pose);
    me.pose(mine);
    show(me.group, players[0].present);
    // Each limb of the shape answers for itself: pink = not yet, yellow = close, green = that limb is in.
    target.limbs.forEach((limb, k) => {
      const err = limbError(mine[k], pose[k]);
      tint(limb, err < 18 ? HOT : err < 40 ? WARM : COLD);
    });
    for (const part of target.body) tint(part, now >= 80 ? HOT : now >= 50 ? WARM : COLD);

    // The wall: a glowing frame that rushes up to meet the shape. When it arrives, you are judged.
    if (show(wall, t >= 0)) {
      const k = flying ? 0.12 + 0.88 * near ** 2.2 : into < PER_POSE - SHOW + 0.25 && g.last >= 60 ? 1 + (into - (PER_POSE - SHOW)) * 3 : 1;
      wall.setLocalScale(k, k, k);
      fade(frame, flying ? 0.35 + 0.65 * near : Math.max(0, 1 - (into - (PER_POSE - SHOW)) * 2));
      fade(fill, flying ? 0.1 + 0.25 * near : 0);
      tint(frame, flying ? WARM : g.last >= 60 ? HOT : COLD);
    }
    show(target.group, t >= 0 && (flying || into < PER_POSE - SHOW + 0.5));

    if (t < 0) { hud('h0', 'Match the shape'); hud('s0', players[0].present ? '0' : 'Step into view'); return; }
    if (flying) {
      if (into > PER_POSE - SHOW - 0.6) g.best = Math.max(g.best, now); // the best moment of the last 0.6s counts
      hud('h0', `${name} · ${now}%`);
      music.intensity(0.4 + near * 0.5);
    } else if (g.judged !== i) {
      g.judged = i;
      const good = g.best >= 60;
      g.streak = good ? g.streak + 1 : 0;
      g.score += g.best + (good ? Math.min(g.streak - 1, 5) * 10 : 0); // a run of good shapes pays a growing bonus
      hud('h0', g.best >= 90 ? `Perfect! ${g.best}%` : good ? `Nice! ${g.best}%${g.streak > 1 ? ` · streak ×${g.streak}` : ''}` : `Missed it · ${g.best}%`);
      if (good) { hitSound(g.best >= 90 ? 'powerUp' : 'confirmation', g.streak * 2, 0.8); for (const limb of target.limbs) { const at = limb.getLocalPosition(); bursts.burst(at.x, at.y, 1.5, g.best >= 90 ? '#ffe14d' : '#7dff7a', 8, 7); } }
      else { sfx('impactWood_heavy'); hud.flash('#ef4444'); hud.shake(); }
      g.last = g.best; // the wall's exit animation still needs the verdict after `best` resets for the next shape
      g.best = 0;
    }
    bursts.update(dt);
    hud('s0', players[0].present ? String(g.score) : 'Step into view');
  };
}
