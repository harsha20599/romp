// Profiles, sessions, activity points, streaks — localStorage on the tablet, nothing leaves it.
export type Session = { t: number; game: string; who: string; score: number; points: number };
type Db = { profiles: string[]; sessions: Session[] };

const KEY = 'romp.v1';
export const DAY_GOAL = 50; // activity points that make a day count toward the streak

export const load = (): Db =>
  JSON.parse(localStorage.getItem(KEY) ?? 'null') ?? { profiles: ['Player 1', 'Player 2', 'Guest'], sessions: [] };
export const save = (db: Db) => localStorage.setItem(KEY, JSON.stringify(db));

const day = (t: number) => new Date(t).toLocaleDateString('en-CA'); // local YYYY-MM-DD

export function summary(sessions: Session[], who: string, now = Date.now()) {
  const mine = sessions.filter((s) => s.who === who);
  const byDay = new Map<string, number>();
  for (const s of mine) byDay.set(day(s.t), (byDay.get(day(s.t)) ?? 0) + s.points);
  const best: Record<string, number> = {};
  for (const s of mine) best[s.game] = Math.max(best[s.game] ?? 0, s.score);

  // Consecutive goal-days ending today — or yesterday, so the streak survives until tonight.
  const hit = (d: Date) => (byDay.get(day(+d)) ?? 0) >= DAY_GOAL;
  const d = new Date(now);
  if (!hit(d)) d.setDate(d.getDate() - 1);
  let streak = 0;
  for (; hit(d); d.setDate(d.getDate() - 1)) streak++;

  const week = mine.reduce((sum, x) => sum + (now - x.t < 7 * 864e5 ? x.points : 0), 0); // rolling, not calendar
  return { today: byDay.get(day(now)) ?? 0, week, total: mine.reduce((a, s) => a + s.points, 0), streak, best };
}
