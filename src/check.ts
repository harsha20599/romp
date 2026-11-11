// The one runnable check: `npm run check`. Fails if the input maths or the streak logic breaks.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { assignSlots, frameClock, handInZone, isAir, isLow, palm, leanOf, limbAngles, OneEuro, poseMatch, tuning } from './pose.ts';
import { summary, DAY_GOAL } from './stats.ts';
import { STARS, STAGES, BADGES, badgesOf, bestStars, dailyChallenges, levelOf, sessionXp, starGoals, starsFor, unlockedStage, variantOf, xpOf } from './meta.ts';

// A body: shoulders 0.1 apart (camera frame, aspect 1) centred at cx, wrists wherever we put them.
const body = (cx: number, sw = 0.1, wrist = { x: cx, y: 0.5 }) => {
  const lm = Array.from({ length: 33 }, () => ({ x: cx, y: 0.5, z: 0, visibility: 1 }));
  lm[11] = { ...lm[11], x: cx + sw / 2 };
  lm[12] = { ...lm[12], x: cx - sw / 2 };
  for (const k of [15, 17, 19]) lm[k] = { ...lm[k], ...wrist }; // the whole hand: wrist and both knuckles
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

// One-Euro: a jittering still hand is calmed at least 3x; a fast move is followed with little lag.
const still = new OneEuro(() => 1.2, () => 3), fast = new OneEuro(() => 1.2, () => 3);
let spread = 0, out = 0;
for (let k = 0; k < 120; k++) { out = still.next(0.5 + (k % 2 ? 0.02 : -0.02), 1 / 30); if (k > 30) spread = Math.max(spread, Math.abs(out - 0.5)); }
assert.ok(spread < 0.02 / 3, `jitter only reduced to ${spread}`);
for (let k = 0; k < 30; k++) out = fast.next(k / 10, 1 / 30); // 3 zone-units per second
assert.ok(2.9 - out < 0.25, `lagging ${2.9 - out} behind a fast hand`);

// The palm: a blend of wrist and knuckles, so one noisy point moves it by only its share; hidden points drop out.
const hand = body(0.5);
hand[19] = { ...hand[19], x: 0.6 };
assert.ok(Math.abs(palm(hand, 15).x - 0.53) < 1e-9);
hand[19] = { ...hand[19], visibility: 0 };
assert.ok(Math.abs(palm(hand, 15).x - 0.5) < 1e-9);

// Streak: consecutive goal-days, still alive if today hasn't been played yet.
const at = (daysAgo: number, points: number) =>
  ({ t: Date.now() - daysAgo * 864e5, game: 'slice', who: 'A', score: points, points });
assert.equal(summary([at(1, DAY_GOAL), at(2, DAY_GOAL), at(4, DAY_GOAL)], 'A').streak, 2);
assert.equal(summary([at(0, DAY_GOAL - 1), at(2, DAY_GOAL)], 'A').streak, 0);
assert.equal(summary([at(0, 30), at(0, 30)], 'A').today, 60);
assert.equal(summary([at(0, 30)], 'B').total, 0);
assert.equal(summary([at(0, 30), at(6, 30), at(8, 30)], 'A').week, 60);

// Progression: stars come from score vs stage goals; two stars open the next stage; XP and levels follow.
assert.deepEqual(starGoals('slice', 1), [40, 80, 130]);
assert.equal(starsFor('slice', 1, 100), 2);
assert.ok(starGoals('slice', 3)[0] > 40);
// Variants: a mode has its own goals, a team is asked for 1.8x, and neither opens the standard mode's stages.
assert.deepEqual(starGoals('slice', 1, 'classic'), [30, 70, 120]);
assert.deepEqual(starGoals('slice', 1, 'team'), starGoals('slice', 1).map((v) => Math.round(v * 1.8)));
assert.deepEqual(starGoals('slice', 1, 'classic+team'), [54, 126, 216]);
assert.equal(variantOf('classic', true), 'classic+team');
assert.equal(variantOf('', false), '');
const played = (game: string, stage: number, score: number, points = 40, daysAgo = 0) => {
  const stars = starsFor(game, stage, score);
  return { t: Date.now() - daysAgo * 864e5, game, who: 'A', score, points, stage, stars, xp: sessionXp({ points, stars, stage, newBest: false }) };
};
const log = [played('slice', 1, 100), played('slice', 2, 10), played('run', 1, 5)];
assert.equal(bestStars(log, 'A', 'slice', 1), 2);
assert.equal(unlockedStage(log, 'A', 'slice'), 2); // 2 stars on stage 1 opens stage 2, but stage 2 has none yet
assert.equal(unlockedStage(log, 'A', 'run'), 1);
assert.equal(unlockedStage([...log, { ...played('run', 1, 1000), variant: 'team' }], 'A', 'run'), 1); // a team round's stars are the team variant's
assert.equal(unlockedStage([...log, { ...played('run', 1, 1000), variant: 'team' }], 'A', 'run', 'team'), 2);
assert.equal(summary([{ ...played('run', 1, 1000), variant: 'team' }], 'A').best.run, undefined); // and its score is not your solo best
assert.equal(xpOf(log, 'A'), 40 + 40 + 40 + 40 + 10); // three sessions' points, two stars, one stage-2 bonus
assert.deepEqual([levelOf(0).level, levelOf(59).level, levelOf(60).level, levelOf(240).level], [1, 1, 2, 3]);
assert.ok(badgesOf(log, 'A').includes('first') && badgesOf(log, 'A').includes('century') && badgesOf(log, 'A').includes('explorer'));
assert.ok(!badgesOf([played('slice', 1, 100, 99)], 'A').includes('century'));
assert.ok(badgesOf([played('slice', 1, 100, 100)], 'A').includes('century'));
assert.ok(!badgesOf(log.filter((s) => s.game === 'slice'), 'A').includes('explorer'));
const daily = dailyChallenges(log, 'A', {});
assert.equal(daily.length, 3);
assert.deepEqual(daily.map((c) => c.id), dailyChallenges([], 'B', {}).map((c) => c.id)); // same three for everyone, all day
assert.ok(daily[0].have === Math.min(daily[0].goal, 120));

// Streamed frames are stamped on the capture pipeline's clock. frameClock must recover each frame's capture time on
// the page clock: roughly from arrivals alone, exactly once the page's video callback has named a frame.
{
  const OFFSET = 1_559_908_897.8, clock = frameClock(), cap = (k: number) => 1000 + k * 33.3;
  // Frames 0–4: no callback yet. Delivery takes 3–8ms; frame 2 sat behind a 40ms model run.
  const rough = [5, 3, 48, 8, 4].map((delay, k) => clock.time(cap(k) + OFFSET, cap(k) + delay));
  rough.forEach((t, k) => assert.ok(k === 0 || (t >= cap(k) && t - cap(k) <= 3.01), `arrival-only estimate is late by at most the quickest delivery (${t - cap(k)})`));
  // The callback reports frames 5 and 6 (and an older one): from then on the answer is exact, even for a frame it never saw.
  [3, 5, 6].forEach((k) => clock.saw(cap(k)));
  assert.ok(Math.abs(clock.time(cap(6) + OFFSET, cap(6) + 30) - cap(6)) < 1e-6);
  assert.ok(Math.abs(clock.time(cap(9) + OFFSET, cap(9) + 6) - cap(9)) < 1e-6);
  assert.equal(frameClock().time(0, 5000), 5000); // first frame: no history, so its age reads zero
  const odd = frameClock(); odd.time(1e6, 100);
  assert.equal(odd.time(1e6 - 900, 200), 200); // a timestamp that implies a 1s-old frame is nonsense: fall back to arrival
}

// Intent: a squat that is clearly under way already counts; a slow sag, or standing up fast out of one, does not.
{
  const at = (lift: number, liftV: number) => ({ lift, liftV }) as Parameters<typeof isLow>[0];
  assert.ok(isLow(at(-0.3, -2.5)) && !isLow(at(-0.3, -0.3)) && !isLow(at(-0.1, -2.5)) && isLow(at(-0.7, 0)));
  assert.ok(isAir(at(0.15, 2.5)) && !isAir(at(0.15, 0.4)) && !isAir(at(0.05, 3)) && isAir(at(0.4, -1)));
  assert.ok(!isAir(at(-0.4, 3))); // driving up out of a squat is not a jump
}

// The public demo must offer only playable games, goals, and attainable badges.
assert.deepEqual(Object.keys(STARS).sort(), ['run', 'slice']);
assert.deepEqual(readdirSync(new URL('./games/', import.meta.url)).sort(), ['run.ts', 'slice.ts']);
const shell = readFileSync(new URL('./main.tsx', import.meta.url), 'utf8');
assert.deepEqual([...shell.matchAll(/import\('\.\/games\/([^']+)\.ts'\)/g)].map((m) => m[1]).sort(), ['run', 'slice']);
const maxStars = Object.keys(STARS).length * STAGES * 3;
const completed = Object.keys(STARS).flatMap((game) => Array.from({ length: STAGES }, (_, i) => played(game, i + 1, 100000)));
assert.ok(badgesOf(completed, 'A').includes('explorer'));
for (const badge of BADGES.filter((b) => b.id.startsWith('stars'))) {
  assert.ok(Number(badge.id.slice(5)) <= maxStars);
  assert.ok(badgesOf(completed, 'A').includes(badge.id));
}
// Every day must be completable using only the two demo games, even with old game history.
for (let day = 1; day <= 366; day++) {
  const now = new Date(2026, 0, day, 12).getTime();
  const games = Object.keys(STARS).flatMap((game) => [0, 1].map(() => ({ ...played(game, 1, 100000, 100), t: now })));
  const quests = dailyChallenges([], 'A', {}, now);
  assert.equal(quests.length, 3);
  assert.ok(quests.every((q) => !q.id.includes('stars:') || Object.keys(STARS).some((g) => q.id.endsWith(`stars:${g}`))));
  assert.ok(dailyChallenges(games, 'A', {}, now).every((q) => q.done), `unreachable quest on day ${day}`);
  const legacy = [{ ...played('removed-game', 1, 100000), t: now }];
  assert.ok(dailyChallenges(legacy, 'A', {}, now).filter((q) => q.id.endsWith(':variety')).every((q) => q.have === 0));
}

console.log('ok');
