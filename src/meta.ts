// Progression: stars, stages, XP and levels, achievements, daily challenges.
// Everything is *derived* from the list of sessions — there is no second copy of progress to fall out of sync.
import { DAY_GOAL, summary, type Session } from './stats.ts';

// Score needed for 1, 2 and 3 stars at stage 1. Guesses until real scores come in — this table is the tuning knob.
export const STARS: Record<string, [number, number, number]> = {
  slice: [25, 50, 80], run: [400, 900, 1500], jab: [20, 40, 65], beat: [25, 50, 80], goalie: [8, 16, 26],
  smash: [15, 30, 45], rocket: [40, 80, 130], freeze: [120, 220, 330], wipe: [120, 220, 320], shapeup: [300, 480, 640],
};
export const STAGES = 5;
export const hardness = (stage: number) => 1 + (stage - 1) * 0.22; // games multiply speeds and spawn rates by this
// A game's other modes have their own goals; a team of two is asked for a bit less than twice what one player is.
export const MODE_STARS: Record<string, [number, number, number]> = { 'slice:classic': [30, 70, 120], 'slice:zen': [40, 70, 100] };
export const variantOf = (mode: string, team: boolean) => [mode, team ? 'team' : ''].filter(Boolean).join('+');
export const starGoals = (game: string, stage: number, variant = '') => {
  const team = variant.endsWith('team'), mode = variant.replace(/\+?team$/, '');
  return ((mode && MODE_STARS[`${game}:${mode}`]) || STARS[game] || [10, 20, 30]).map((v) => Math.round(v * (1 + (stage - 1) * 0.3) * (team ? 1.8 : 1)));
};
export const starsFor = (game: string, stage: number, score: number, variant = '') => starGoals(game, stage, variant).filter((goal) => score >= goal).length;

const mine = (sessions: Session[], who: string) => sessions.filter((s) => s.who === who);
const rounds = (sessions: Session[], who: string, game: string, stage: number, variant: string) =>
  mine(sessions, who).filter((s) => s.game === game && (s.stage ?? 1) === stage && (s.variant ?? '') === variant);
export const bestStars = (sessions: Session[], who: string, game: string, stage: number, variant = '') => Math.max(0, ...rounds(sessions, who, game, stage, variant).map((s) => s.stars ?? 0));
export const bestScore = (sessions: Session[], who: string, game: string, stage: number, variant = '') => Math.max(0, ...rounds(sessions, who, game, stage, variant).map((s) => s.score));
// Stage n opens once stage n-1 has two stars — counted per variant, so an easy mode cannot open a hard one's stages.
export function unlockedStage(sessions: Session[], who: string, game: string, variant = '') {
  let stage = 1;
  while (stage < STAGES && bestStars(sessions, who, game, stage, variant) >= 2) stage++;
  return stage;
}
export const totalStars = (sessions: Session[], who: string) =>
  Object.keys(STARS).reduce((sum, game) => sum + Array.from({ length: STAGES }, (_, i) => bestStars(sessions, who, game, i + 1)).reduce((a, b) => a + b, 0), 0);

// XP: moving pays, stars pay, harder stages pay, beating yourself pays.
export const sessionXp = (s: { points: number; stars: number; stage: number; newBest: boolean }) =>
  s.points + s.stars * 20 + (s.stage - 1) * 10 + (s.newBest ? 25 : 0);
export const xpOf = (sessions: Session[], who: string) => mine(sessions, who).reduce((sum, s) => sum + (s.xp ?? s.points), 0);
const TITLES: [number, string][] = [[20, 'Legend'], [15, 'Champion'], [10, 'Pro'], [6, 'Athlete'], [3, 'Mover'], [1, 'Rookie']];
export function levelOf(xp: number) {
  const level = Math.floor(Math.sqrt(xp / 60)) + 1, floor = 60 * (level - 1) ** 2, next = 60 * level ** 2;
  return { level, title: TITLES.find(([min]) => level >= min)![1], into: xp - floor, span: next - floor };
}

// ---- Achievements --------------------------------------------------------------------------------------
const dayOf = (t: number) => new Date(t).toLocaleDateString('en-CA');
type Ctx = { all: Session[]; who: string; games: Session[]; now: number };
export const BADGES: { id: string; name: string; how: string; test: (c: Ctx) => boolean }[] = [
  { id: 'first', name: 'First steps', how: 'Finish your first game', test: (c) => c.games.length >= 1 },
  { id: 'explorer', name: 'Explorer', how: 'Play every game once', test: (c) => Object.keys(STARS).every((g) => c.games.some((s) => s.game === g)) },
  { id: 'century', name: 'Century', how: 'Earn 100 activity points in a day', test: (c) => summary(c.all, c.who, c.now).today >= 100 },
  { id: 'double', name: 'Double century', how: 'Earn 200 activity points in a day', test: (c) => summary(c.all, c.who, c.now).today >= 200 },
  { id: 'streak3', name: 'Habit forming', how: `Hit ${DAY_GOAL} points 3 days running`, test: (c) => summary(c.all, c.who, c.now).streak >= 3 },
  { id: 'streak7', name: 'Full week', how: `Hit ${DAY_GOAL} points 7 days running`, test: (c) => summary(c.all, c.who, c.now).streak >= 7 },
  { id: 'streak30', name: 'Unstoppable', how: `Hit ${DAY_GOAL} points 30 days running`, test: (c) => summary(c.all, c.who, c.now).streak >= 30 },
  { id: 'stars10', name: 'Star collector', how: 'Collect 10 stars', test: (c) => totalStars(c.all, c.who) >= 10 },
  { id: 'stars40', name: 'Constellation', how: 'Collect 40 stars', test: (c) => totalStars(c.all, c.who) >= 40 },
  { id: 'stars100', name: 'Galaxy', how: 'Collect 100 stars', test: (c) => totalStars(c.all, c.who) >= 100 },
  { id: 'flawless', name: 'Flawless', how: 'Three stars on stage 3 or higher', test: (c) => c.games.some((s) => (s.stars ?? 0) === 3 && (s.stage ?? 1) >= 3) },
  { id: 'summit', name: 'Summit', how: 'Reach stage 5 in any game', test: (c) => Object.keys(STARS).some((g) => unlockedStage(c.all, c.who, g) >= STAGES) },
  { id: 'five', name: 'Five a day', how: 'Play 5 games in one day', test: (c) => c.games.filter((s) => dayOf(s.t) === dayOf(c.now)).length >= 5 },
  { id: 'level5', name: 'Warmed up', how: 'Reach level 5', test: (c) => levelOf(xpOf(c.all, c.who)).level >= 5 },
  { id: 'level10', name: 'In shape', how: 'Reach level 10', test: (c) => levelOf(xpOf(c.all, c.who)).level >= 10 },
  { id: 'early', name: 'Early bird', how: 'Play before 8 in the morning', test: (c) => c.games.some((s) => new Date(s.t).getHours() < 8) },
  { id: 'squats', name: 'Leg day', how: 'Reach 150 m in Rocket', test: (c) => c.games.some((s) => s.game === 'rocket' && s.score >= 150) },
  { id: 'runner', name: 'Road runner', how: 'Score 2000 in Run', test: (c) => c.games.some((s) => s.game === 'run' && s.score >= 2000) },
];
export function badgesOf(all: Session[], who: string, now = Date.now()) {
  const c = { all, who, now, games: mine(all, who).filter((s) => !s.game.startsWith('bonus:')) };
  return BADGES.filter((b) => b.test(c)).map((b) => b.id);
}

// ---- Daily challenges ------------------------------------------------------------------------------------
// Three a day, the same three for everyone in the house, picked by the date. Each pays bonus XP once.
export const CHALLENGE_XP = 40;
export type Challenge = { id: string; text: string; goal: number; have: number; done: boolean };
export function dailyChallenges(all: Session[], who: string, names: Record<string, string>, now = Date.now()): Challenge[] {
  const day = dayOf(now), today = mine(all, who).filter((s) => dayOf(s.t) === day && !s.game.startsWith('bonus:'));
  let seed = [...day].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) >>> 0, 7);
  const roll = (n: number) => (seed = (seed * 1664525 + 1013904223) >>> 0) % n;
  const ids = Object.keys(STARS), gameA = ids[roll(ids.length)], gameB = ids[roll(ids.length)], pts = [60, 90, 120][roll(3)];
  const list: [string, string, number, number][] = [
    [`pts${pts}`, `Earn ${pts} activity points`, pts, today.reduce((a, s) => a + s.points, 0)],
    [`stars:${gameA}`, `Get 2 stars in ${names[gameA] ?? gameA}`, 2, Math.max(0, ...today.filter((s) => s.game === gameA).map((s) => s.stars ?? 0))],
    gameB === gameA
      ? ['variety', 'Play 3 different games', 3, new Set(today.map((s) => s.game)).size]
      : [`play:${gameB}`, `Play ${names[gameB] ?? gameB} twice`, 2, today.filter((s) => s.game === gameB).length],
  ];
  return list.map(([id, text, goal, have]) => ({ id: `${day}:${id}`, text, goal, have: Math.min(goal, have), done: have >= goal }));
}
