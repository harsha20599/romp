// Smash — a tower of crates on a platform; knock every one of them off with your hands. Pure physics (Rapier):
// the crates are rigid bodies, your hands are kinematic colliders, and a fast swing adds a real shove.
// Clear the platform for a bonus and a taller tower. Hands are body-relative over your own tower: compact.
import type { Entity } from 'playcanvas';
import { hardness } from '../meta.ts';
import { physics } from '../physics.ts';
import { fitted, lit, node, shapes, show, type View } from '../engine.ts';
import { bursts as makeBursts, hands as makeHands, hitSound, music, round, scoreHud, segDist, sfx, type Game } from '../kit.ts';

const ROUND = 60, CRATES = 21, SIZE = 0.9, DECK = 0, SWING = 4; // SWING = hand speed (units/s) that counts as a hit rather than a nudge

export const view: View = { position: [0, 3, 8.2], fov: 50, near: 0.1, far: 100, lookAt: [0, 2, 0] };

export default async function smash({ n, stage, onEnd, hud, scene, cleanup }: Game) {
  const hard = hardness(stage);
  const [{ RAPIER, world, step }, crate] = await Promise.all([physics(-14), fitted('/assets/kit/crate.glb', SIZE)]);
  cleanup(() => world.free());
  const area = { cx: (p: number) => (n === 1 ? 0 : (p - 0.5) * 7.4), hw: 3, hh: 2.8, cy: 2.4 };

  const deckMesh = shapes.box(6.6, 0.5, 2.2), deckLook = lit('#52525b', { emissive: '#4f46e5', glow: 0.15 }), fixed = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
  for (let p = 0; p < n; p++) {
    node(scene.root, deckMesh, deckLook, [area.cx(p), DECK - 0.25, 0]);
    world.createCollider(RAPIER.ColliderDesc.cuboid(3.3, 0.25, 1.1).setTranslation(area.cx(p), DECK - 0.25, 0).setFriction(0.9), fixed);
  }
  const crates = Array.from({ length: CRATES * n }, (_, j) => {
    const body = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(0, -30 - j * 2, 0).setAngularDamping(0.3));
    world.createCollider(RAPIER.ColliderDesc.cuboid(SIZE / 2, SIZE / 2, SIZE / 2).setFriction(0.7).setRestitution(0.15).setDensity(hard), body);
    body.setEnabled(false);
    const e = crate.clone() as Entity;
    scene.root.addChild(e);
    e.enabled = false;
    return { body, e, live: false };
  });
  const fists = Array.from({ length: n * 2 }, () => {
    const body = world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(0, -40, 0));
    world.createCollider(RAPIER.ColliderDesc.ball(0.5), body);
    return body;
  });
  const g = { scores: [0, 0], combo: [0, 0], wave: [0, 0], rebuildAt: [0.5, 0.5], said: [0, 0] };
  const hands = makeHands(scene, n, area), bursts = makeBursts(scene.root);
  const tick = round(hud, ROUND, () => { music.stop(); onEnd(g.scores.slice(0, n)); });
  music.start('arcade');

  // A pyramid that grows a row with every wave: 3-2-1, then 4-3-2-1, up to 6 wide.
  const build = (p: number) => {
    const rows = Math.min(6, 3 + g.wave[p]);
    let k = 0;
    for (let row = 0; row < rows; row++)
      for (let col = 0; col < rows - row && k < CRATES; col++, k++) {
        const c = crates[p * CRATES + k];
        c.live = true;
        c.body.setEnabled(true);
        c.body.setTranslation({ x: area.cx(p) + (col - (rows - row - 1) / 2) * (SIZE + 0.04), y: DECK + SIZE / 2 + row * SIZE + 0.02, z: 0 }, true);
        c.body.setRotation({ x: 0, y: 0, z: 0, w: 1 }, true);
        c.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
        c.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
      }
    sfx('impactWood_medium', { vol: 0.6 });
  };

  return (rawDt: number) => {
    const dt = Math.min(rawDt, 0.05), t = tick(rawDt);
    if (t === null) return;

    hands.update(dt).forEach((h, i) => {
      fists[i].setNextKinematicTranslation({ x: h.on ? h.x : 0, y: h.on ? h.y : -40, z: 0 });
      if (!h.on || h.speed < SWING || t < 0) return;
      // A kinematic fist only pushes sideways. A real swing also drives the crate it touches back and up.
      for (let k = 0; k < CRATES; k++) {
        const crate = crates[h.p * CRATES + k];
        if (!crate.live) continue;
        const c = crate.body.translation();
        // Test the whole swing since last frame, not just where the hand is now — a fast arm covers a crate-width per frame.
        if (segDist(c.x, c.y, h.px, h.py, h.x, h.y) > SIZE * 0.9 || Math.abs(c.z) > 1) continue;
        const kick = (Math.min(h.speed, 16) * 0.2) / hard, len = Math.hypot(h.x - h.px, h.y - h.py) || 1;
        crate.body.applyImpulse({ x: ((h.x - h.px) / len) * kick * 0.8, y: ((h.y - h.py) / len) * kick * 0.8 + kick * 0.3, z: -kick * 0.6 }, true);
        if (Math.random() < 0.3) sfx('impactWood_heavy', { vol: Math.min(1, h.speed / 12) });
      }
    });
    step(dt);

    for (let p = 0; p < n; p++) {
      let standing = 0;
      for (let k = 0; k < CRATES; k++) {
        const crate = crates[p * CRATES + k], { body } = crate;
        if (!crate.live && body.isEnabled()) body.setEnabled(false); // parked bodies must not fall forever
        if (!show(crate.e, crate.live)) continue;
        const c = body.translation(), r = body.rotation();
        crate.e.setLocalPosition(c.x, c.y, c.z);
        crate.e.setLocalRotation(r.x, r.y, r.z, r.w);
        if (c.y > DECK - 2.5) { standing++; continue; }
        crate.live = false; body.setEnabled(false); // off the platform: that is a point
        g.scores[p] += 1 + Math.floor(++g.combo[p] / 8);
        hitSound('impactWood_medium', g.combo[p], 0.6);
        bursts.burst(c.x, DECK - 1.5, c.z, '#b45309', 10, 6);
      }
      if (t >= 0 && standing === 0 && g.rebuildAt[p] === 0) { // cleared
        if (g.wave[p]++ || t > 1) { g.scores[p] += 10; g.said[p] = t + 1.3; sfx('confirmation'); hud.flash('#fde047'); }
        g.rebuildAt[p] = t + 0.8;
      }
      if (g.rebuildAt[p] && t >= g.rebuildAt[p]) { g.rebuildAt[p] = 0; g.combo[p] = 0; build(p); }
      hud.p('h', p, t < 0 ? 'Knock them all off' : g.said[p] > t ? 'Cleared! +10' : `Tower ${g.wave[p] + 1} · ${standing} left`);
    }
    bursts.update(dt);
    music.intensity(0.3 + Math.max(g.combo[0], g.combo[1]) / 14);
    scoreHud(hud, n, g.scores);
  };
}
