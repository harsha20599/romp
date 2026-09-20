// Goalie — real ballistics (Rapier). Shots are rigid bodies fired on an arc at a spot in your goal; your gloves are
// kinematic colliders, so a save is a real deflection — swat it and it flies, just get there and it drops.
// A shot that crosses the line is a goal. Hands are body-relative across your own goal: together-play is compact.
import { hardness } from '../meta.ts';
import { sim } from '../pose.ts';
import { physics } from '../physics.ts';
import { fade, flat, lit, node, shapes, show, tint, type View } from '../engine.ts';
import { PLAYER_COLORS, bursts as makeBursts, comboText, hands as makeHands, hitSound, music, round, scoreHud, sfx, type Game } from '../kit.ts';

const ROUND = 60, FAR = -32, GRAV = 9.8, BALL_R = 0.5, GLOVE_R = 0.85, PER_ZONE = 5, FLOOR = -3.2;

type Shot = { state: 'off' | 'in' | 'saved' | 'goal'; zone: number; tx: number; ty: number; left: number; dur: number; gold: boolean; age: number };

export const view: View = { position: [0, 0.4, 9.5], fov: 50, near: 0.1, far: 120 };

export default async function goalie({ n, stage, onEnd, hud, scene, cleanup }: Game) {
  const hard = hardness(stage);
  const { RAPIER, world, step } = await physics(-GRAV);
  cleanup(() => world.free());
  scene.fog('#09090b', 18, 46);
  const goal = { cx: (p: number) => (n === 1 ? 0 : (p - 0.5) * 6.8), hw: n === 1 ? 5.6 : 3, hh: 3, cy: 0.2 };
  const shots: Shot[] = Array.from({ length: PER_ZONE * n }, (_, i) => ({ state: 'off', zone: i % n, tx: 0, ty: 0, left: 0, dur: 1, gold: false, age: 0 }));

  // The pitch, and a frame for each goal: what you see, and the same boxes again for the ball to hit.
  node(scene.root, shapes.floor(44, 60), lit('#166534'), [0, FLOOR, -20]);
  const fixed = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
  world.createCollider(RAPIER.ColliderDesc.cuboid(30, 0.5, 40).setTranslation(0, FLOOR - 0.5, -20).setRestitution(0.6).setFriction(0.8), fixed);
  const unit = shapes.box(1, 1, 1), postLook = lit('#e4e4e7', { emissive: '#e4e4e7', glow: 0.25 });
  for (let p = 0; p < n; p++) {
    for (const side of [-1, 1]) world.createCollider(RAPIER.ColliderDesc.cuboid(0.15, goal.hh + 0.3, 0.15).setTranslation(goal.cx(p) + side * (goal.hw + 0.3), goal.cy, 0).setRestitution(0.5), fixed);
    world.createCollider(RAPIER.ColliderDesc.cuboid(goal.hw + 0.4, 0.15, 0.15).setTranslation(goal.cx(p), goal.cy + goal.hh + 0.4, 0).setRestitution(0.5), fixed);
    for (const [x, y, w, h] of [[-goal.hw - 0.3, goal.cy, 0.3, goal.hh * 2 + 0.6], [goal.hw + 0.3, goal.cy, 0.3, goal.hh * 2 + 0.6], [0, goal.cy + goal.hh + 0.4, goal.hw * 2 + 0.9, 0.3]])
      node(scene.root, unit, postLook, [goal.cx(p) + x, y, 0]).setLocalScale(w, h, 0.3);
  }
  const ballMesh = shapes.facets(BALL_R, 1), ballLook = lit('#fafafa', { emissive: '#000000' }), ringMesh = shapes.ring(0.9, 1, 40), ringLook = flat('#fafafa', { opacity: 1 });
  const balls = shots.map((_, i) => {
    const body = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(0, -30 - i, 0).setCcdEnabled(true).setLinearDamping(0.05));
    world.createCollider(RAPIER.ColliderDesc.ball(BALL_R).setRestitution(0.75).setFriction(0.4).setDensity(0.6), body);
    body.setEnabled(false);
    const mesh = node(scene.root, ballMesh, ballLook), ring = node(scene.root, ringMesh, ringLook);
    mesh.enabled = ring.enabled = false;
    return { body, mesh, ring };
  });
  const gloves = Array.from({ length: n * 2 }, () => {
    const body = world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(0, -40, 0.2));
    world.createCollider(RAPIER.ColliderDesc.ball(GLOVE_R).setRestitution(0.4), body);
    return body;
  });

  const g = { spawnIn: [1, 1.5], scores: [0, 0], combo: [0, 0] };
  const hands = makeHands(scene, n, goal), bursts = makeBursts(scene.root);
  if (sim) Object.assign(window, { __goalie: { shots, goal, g } }); // test hook: lets a headless run aim the glove at the ring
  const tick = round(hud, ROUND, () => { music.stop(); onEnd(g.scores.slice(0, n)); });
  music.start('arcade');

  return (rawDt: number) => {
    const dt = Math.min(rawDt, 0.05), t = tick(rawDt);
    if (t === null) return;
    const ease = Math.max(0, t) / ROUND;

    hands.update(dt).forEach((h, i) => {
      // A keeper's hands close on the ball by themselves in the last instant. So does the glove: if it is already near
      // where a shot is about to land, it is drawn onto the spot — which also swallows the tracker's last few cm of noise.
      let x = h.x, y = h.y;
      for (const s of shots) {
        const d = Math.hypot(s.tx - x, s.ty - y);
        if (s.state !== 'in' || s.zone !== h.p || s.left > 0.45 || d > GLOVE_R * 2) continue;
        const pull = 0.65 * (1 - s.left / 0.45);
        x += (s.tx - x) * pull; y += (s.ty - y) * pull;
      }
      gloves[i].setNextKinematicTranslation({ x: h.on ? x : 0, y: h.on ? y : -40, z: 0.2 });
    });

    if (t >= 0)
      for (let z = 0; z < n; z++) {
        if ((g.spawnIn[z] -= dt) > 0) continue;
        g.spawnIn[z] = (1.8 - 0.8 * ease + Math.random() * 0.3) / Math.sqrt(hard);
        const i = shots.findIndex((s) => s.zone === z && s.state === 'off');
        if (i < 0) continue;
        const s = shots[i], { body } = balls[i], x0 = goal.cx(z) + (Math.random() * 2 - 1) * 7, y0 = FLOOR + BALL_R;
        Object.assign(s, { state: 'in', gold: Math.random() < 0.15, age: 0, tx: goal.cx(z) + (Math.random() * 2 - 1) * goal.hw * 0.82, ty: goal.cy + (Math.random() * 2 - 1) * goal.hh * 0.8 });
        s.dur = s.left = (s.gold ? 1.25 : 1.7 - 0.5 * ease) / Math.sqrt(hard);
        // Solve the launch velocity that lands the ball on (tx, ty, 0) after `dur` seconds under gravity.
        body.setEnabled(true);
        body.setTranslation({ x: x0, y: y0, z: FAR }, true);
        body.setLinvel({ x: (s.tx - x0) / s.dur, y: (s.ty - y0) / s.dur + 0.5 * GRAV * s.dur, z: -FAR / s.dur }, true);
        body.setAngvel({ x: -8, y: 0, z: Math.random() * 6 - 3 }, true);
        sfx('impactPunch_medium', { vol: 0.35, rate: 0.7 }); // the kick, far away
      }
    step(dt);

    shots.forEach((s, i) => {
      const { body, mesh, ring } = balls[i];
      if (s.state === 'off' && body.isEnabled()) body.setEnabled(false); // parked bodies must not fall forever
      if (s.state !== 'off') {
        const pos = body.translation(), vel = body.linvel(), p = s.zone;
        s.left -= dt; s.age += dt;
        if (s.state === 'in' && pos.z > 1.4) { // over the line
          s.state = 'goal'; g.combo[p] = 0;
          sfx('error', { vol: 0.7 }); hud.flash('#ef4444'); hud.shake(0.7);
        } else if (s.state === 'in' && pos.z > -6 && vel.z < 1) { // turned back, or killed dead, this side of the box
          s.state = 'saved';
          g.scores[p] += (s.gold ? 3 : 1) + Math.floor(++g.combo[p] / 5);
          hitSound('impactPunch_heavy', g.combo[p]);
          bursts.burst(pos.x, pos.y, pos.z + 0.5, s.gold ? '#fde047' : PLAYER_COLORS[p], s.gold ? 30 : 16, 8);
        }
        if (s.age > s.dur + 2.2 || pos.y < -12) { s.state = 'off'; body.setEnabled(false); }
        const r = body.rotation();
        mesh.setLocalPosition(pos.x, pos.y, pos.z);
        mesh.setLocalRotation(r.x, r.y, r.z, r.w);
      }
      if (show(mesh, s.state !== 'off')) { tint(mesh, s.gold ? '#fde047' : '#fafafa', 'diffuse'); tint(mesh, s.gold ? '#a16207' : '#000000', 'emissive'); }
      if (!show(ring, s.state === 'in')) return;
      const k = GLOVE_R * (1 + 2.2 * Math.max(0, s.left / s.dur)); // closes to glove size as the ball arrives
      ring.setLocalPosition(s.tx, s.ty, 0);
      ring.setLocalScale(k, k, 1);
      fade(ring, 0.25 + 0.75 * (1 - Math.max(0, s.left / s.dur)));
      tint(ring, s.gold ? '#fde047' : '#fafafa');
    });
    bursts.update(dt);
    music.intensity(0.3 + Math.max(g.combo[0], g.combo[1]) / 12);
    scoreHud(hud, n, g.scores);
    for (let p = 0; p < n; p++) hud.p('h', p, comboText(g.combo[p]));
  };
}
