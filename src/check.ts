// The one runnable check: `npm run check`. Fails if the input maths or the streak logic breaks.
import assert from 'node:assert/strict';
import { assignSlots, handInZone, tuning } from './pose.ts';
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

// Streak: consecutive goal-days, still alive if today hasn't been played yet.
const at = (daysAgo: number, points: number) =>
  ({ t: Date.now() - daysAgo * 864e5, game: 'slice', who: 'A', score: points, points });
assert.equal(summary([at(1, DAY_GOAL), at(2, DAY_GOAL), at(4, DAY_GOAL)], 'A').streak, 2);
assert.equal(summary([at(0, DAY_GOAL - 1), at(2, DAY_GOAL)], 'A').streak, 0);
assert.equal(summary([at(0, 30), at(0, 30)], 'A').today, 60);
assert.equal(summary([at(0, 30)], 'B').total, 0);

console.log('ok');
