// The one runnable check: `npm run check`. Fails if the input maths or the streak logic breaks.
import assert from 'node:assert/strict';
import { assignSlots, handInZone, leanOf, limbAngles, poseMatch, tuning } from './pose.ts';
import { summary, DAY_GOAL } from './stats.ts';

// A body: shoulders 0.1 apart (camera frame, aspect 1) centred at cx, wrists wherever we put them.
const body = (cx: number, sw = 0.1, wrist = { x: cx, y: 0.5 }) => {
  const lm = Array.from({ length: 33 }, () => ({ x: cx, y: 0.5, z: 0, visibility: 1 }));
  lm[11] = { ...lm[11], x: cx + sw / 2 };
  lm[12] = { ...lm[12], x: cx - sw / 2 };
  lm[15] = { ...lm[15], ...wrist };
  return lm;
};

// Body-relative: the same reach reads the same wherever the player stands, however far back.
const reach = (cx: number, sw: number) => handInZone(body(cx, sw, { x: cx - sw, y: 0.5 }), 15, 1, 2).x;
assert.ok(Math.abs(reach(0.3, 0.1) - reach(0.7, 0.05)) < 1e-9);
assert.ok(Math.abs(reach(0.3, 0.1) - 1 / tuning.reachX[1]) < 1e-9); // camera-left = screen-right (mirror)
assert.equal(handInZone(body(0.5, 0.1, { x: 0, y: 0.5 }), 15, 1, 1).x, 1); // clamped to the zone

// Slots: biggest bodies play, screen-left is P1. Camera x is mirrored, so camera-right = screen-left.
const [p1, p2] = assignSlots([body(0.2), body(0.8), body(0.5, 0.02)], 1, 2);
assert.equal(p1[0].x, 0.8);
assert.equal(p2[0].x, 0.2);
assert.equal(assignSlots([body(0.2), body(0.8, 0.2)], 1, 1)[0][0].x, 0.8); // solo: the nearer person

// Lean: shoulders shifted toward camera-left = screen-right = positive. Standing straight = 0.
const leaning = body(0.5);
leaning[23] = { ...leaning[23], x: 0.55 };
leaning[24] = { ...leaning[24], x: 0.55 };
assert.ok(leanOf(leaning, 1) > 0.4 && leanOf(body(0.5), 1) === 0);

// Limb angles are screen-space, y up: an arm raised straight overhead reads +90°.
const armUp = body(0.5);
armUp[13] = { ...armUp[13], x: armUp[11].x, y: 0.3 };
assert.ok(Math.abs(limbAngles(armUp, 1)[0] - Math.PI / 2) < 1e-9);

// Pose match: identical = 100, wraps around ±180°, arms flung the wrong way = 0.
const tPose = [Math.PI, Math.PI, 0, 0, -1.6, -1.6, -1.5, -1.5];
assert.equal(poseMatch(tPose, tPose), 100);
assert.equal(poseMatch(tPose, tPose.map((a, i) => (i < 2 ? -Math.PI + 0.01 : a))), 100);
assert.equal(poseMatch(tPose, tPose.map((a, i) => (i < 4 ? a + Math.PI / 2 : a))), 0);

// Streak: consecutive goal-days, still alive if today hasn't been played yet.
const at = (daysAgo: number, points: number) =>
  ({ t: Date.now() - daysAgo * 864e5, game: 'slice', who: 'A', score: points, points });
assert.equal(summary([at(1, DAY_GOAL), at(2, DAY_GOAL), at(4, DAY_GOAL)], 'A').streak, 2);
assert.equal(summary([at(0, DAY_GOAL - 1), at(2, DAY_GOAL)], 'A').streak, 0);
assert.equal(summary([at(0, 30), at(0, 30)], 'A').today, 60);
assert.equal(summary([at(0, 30)], 'B').total, 0);
assert.equal(summary([at(0, 30), at(6, 30), at(8, 30)], 'A').week, 60);

console.log('ok');
