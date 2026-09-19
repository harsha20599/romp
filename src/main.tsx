// Shell: start → home → briefing (stage, goals) → play → results (stars, XP, badges) → stats / badges.
// Driven by hand, touch or keyboard.
import { useEffect, useRef, useState, type FC } from 'react';
import { createRoot } from 'react-dom/client';
import { perf, players, setPlayers, startPose, tuning } from './pose.ts';
import { DAY_GOAL, load, save, summary, type Session } from './stats.ts';
import { BADGES, CHALLENGE_XP, STAGES, badgesOf, bestStars, dailyChallenges, levelOf, sessionXp, starGoals, starsFor, totalStars, unlockedStage, xpOf } from './meta.ts';
import { loadAudio } from './audio.ts';
import { audio, effects, jingle, say, sfx, type GameProps } from './stage.tsx';
import Slice from './Slice.tsx';
import Run from './Run.tsx';
import Jab from './Jab.tsx';
import Beat from './Beat.tsx';
import ShapeUp from './ShapeUp.tsx';
import Goalie from './Goalie.tsx';
import Smash from './Smash.tsx';
import Rocket from './Rocket.tsx';
import Freeze from './Freeze.tsx';
import Wipe from './Wipe.tsx';

type Game = { id: string; name: string; blurb: string; how: string; maxPlayers: 1 | 2; Play: FC<GameProps> };
// The library. A new game = one component + one row here (+ its star goals in meta.ts). maxPlayers 2 only for
// compact-footprint games (PLAN §3); a wide game is still playable by two through "Take turns".
const GAMES: Game[] = [
  { id: 'run', name: 'Run', blurb: 'Endless runner. Lean, jump, duck.', how: 'Lean left or right to change lane. Jump the barrels, duck the beams, never run into crates. Coins and power-ups are in the lanes.', maxPlayers: 2, Play: Run },
  { id: 'slice', name: 'Slice', blurb: 'Cut the fruit, dodge the bombs.', how: 'Swipe fast through the fruit. Stars are worth 5. Never touch a bomb. The last 10 seconds are a frenzy.', maxPlayers: 2, Play: Slice },
  { id: 'smash', name: 'Smash', blurb: 'Knock the crate tower down.', how: 'Swing your hands through the crates and knock every one off the platform. Clear it for a bonus and a taller tower.', maxPlayers: 2, Play: Smash },
  { id: 'goalie', name: 'Goalie', blurb: 'Get a hand to every shot.', how: 'Watch the ring: it shows where the shot will land. Get a glove there. Swat it and it flies. Gold balls are fast and worth 3.', maxPlayers: 2, Play: Goalie },
  { id: 'jab', name: 'Jab', blurb: 'Punch the pads, duck the bar.', how: 'Punch each pad with the hand on its side. Gold pads want the opposite hand. Punch hard for extra. Squat when the bar comes.', maxPlayers: 2, Play: Jab },
  { id: 'beat', name: 'Beat', blurb: 'Hit the moves on the beat.', how: 'Hold the move as its shape reaches the line: left hand up, right hand up, both up, squat, or jump. On the beat is Perfect.', maxPlayers: 2, Play: Beat },
  { id: 'rocket', name: 'Rocket', blurb: 'Every squat is a burn.', how: 'Squat to fire the engine. Deeper squats burn harder. Stop and gravity wins. Highest altitude is your score.', maxPlayers: 2, Play: Rocket },
  { id: 'freeze', name: 'Freeze', blurb: 'Dance, then hold dead still.', how: 'Move as much as you can while the music plays. When it stops, freeze. Any wobble costs points; a still freeze pays a bonus.', maxPlayers: 2, Play: Freeze },
  { id: 'wipe', name: 'Wipe', blurb: 'Scrub the screen clean.', how: 'Sweep both hands across the grime. It creeps back. Clear your whole side for a bonus and a tougher layer.', maxPlayers: 2, Play: Wipe },
  { id: 'shapeup', name: 'Shape Up', blurb: 'Match the pose in time.', how: 'A shape flies toward you. Make it with your whole body before it lands. Needs room for both arms: solo or take turns.', maxPlayers: 1, Play: ShapeUp },
];
const NAMES = Object.fromEntries(GAMES.map((g) => [g.id, g.name]));

const MODES = { solo: 'Solo', together: 'Together', turns: 'Take turns' } as const;
type Mode = keyof typeof MODES;
type Reward = { stars: number; xp: number; newBest: boolean; levelUp: number; badges: string[]; challenges: string[] };
type Round = { game: Game; stage: number; turn: number; scores: number[]; points: number[]; rewards: Reward[] };
type Screen = { at: 'start' | 'home' | 'stats' | 'badges' } | { at: 'brief'; game: Game; stage: number } | ({ at: 'play' | 'next' | 'results' } & Round);

const Stars = ({ n, of = 3 }: { n: number; of?: number }) => <span className="stars">{'★'.repeat(n)}<i>{'★'.repeat(of - n)}</i></span>;
function LevelChip({ sessions, who }: { sessions: Session[]; who: string }) {
  const lv = levelOf(xpOf(sessions, who));
  return (
    <span className="level">
      <b>Lv {lv.level}</b> {lv.title}
      <span className="bar"><span style={{ width: `${(100 * lv.into) / lv.span}%` }} /></span>
    </span>
  );
}

// The pointer is P1's higher hand; holding it over a button for DWELL ms clicks it. Three things keep it calm:
// it glides instead of jumping, it only switches hands when the other is clearly higher, and once it is
// dwelling on a button it stays "on" it until it leaves by a margin — so a wobble never resets the ring.
const DWELL = 1200, STICKY = 40;
function HandCursor() {
  const el = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let raf = 0, target: HTMLButtonElement | null = null, since = 0, last = 0, which = 1, x = NaN, y = NaN;
    const loop = (now: number) => {
      raf = requestAnimationFrame(loop);
      const dt = Math.min(0.05, (now - last) / 1000), hands = players[0].hands;
      last = now;
      const other = 1 - which;
      if (hands[other].seen && (!hands[which].seen || hands[other].y > hands[which].y + 0.3)) which = other;
      const hand = hands[which], on = players[0].present && hand.seen;
      el.current!.style.display = on ? '' : 'none';
      if (!on) return void (x = NaN);
      const tx = ((hand.x + 1) / 2) * innerWidth, ty = ((1 - hand.y) / 2) * innerHeight, k = Number.isNaN(x) ? 1 : 1 - Math.exp(-dt * 12);
      x = (Number.isNaN(x) ? tx : x) + (tx - (Number.isNaN(x) ? tx : x)) * k;
      y = (Number.isNaN(y) ? ty : y) + (ty - (Number.isNaN(y) ? ty : y)) * k;
      el.current!.style.transform = `translate(${x}px, ${y}px)`;

      const r = target?.isConnected ? target.getBoundingClientRect() : null;
      const held = r && x > r.left - STICKY && x < r.right + STICKY && y > r.top - STICKY && y < r.bottom + STICKY;
      const over = held ? target : (document.elementFromPoint(x, y)?.closest('button:not(:disabled)') as HTMLButtonElement | null);
      if (over !== target) {
        target?.classList.remove('hot');
        over?.classList.add('hot');
        if (over) sfx('tick', { vol: 0.35 });
        target = over;
        since = now;
      }
      const p = target ? Math.min(1, Math.max(0, (now - since) / DWELL)) : 0;
      el.current!.style.setProperty('--p', String(p));
      if (p === 1) { target!.click(); since = now + DWELL; } // pause before it can re-fire
    };
    raf = requestAnimationFrame(loop);
    return () => { cancelAnimationFrame(raf); target?.classList.remove('hot'); };
  }, []);
  return <div className="cursor" ref={el} />;
}

function Fps() {
  const [, tick] = useState(0);
  useEffect(() => { const id = setInterval(() => tick((v) => v + 1), 1000); return () => clearInterval(id); }, []);
  return <>tracker {perf.delegate} {perf.fps.toFixed(0)} fps</>;
}

function App() {
  const video = useRef<HTMLVideoElement>(null);
  const [screen, setScreen] = useState<Screen>({ at: 'start' });
  const [error, setError] = useState('');
  const [db, setDb] = useState(load);
  const [who, setWho] = useState([0, 1]); // profile index per player slot
  const [mode, setMode] = useState<Mode>('solo');
  const [fx, setFx] = useState(effects.on);
  const n = mode === 'together' ? 2 : 1; // bodies tracked at once; "turns" is two people, one at a time
  const energy0 = useRef([0, 0]);
  const name = (slot: number) => db.profiles[who[slot]];

  useEffect(() => { // every button press clicks, whoever pressed it: finger, mouse or hand
    const click = (e: MouseEvent) => (e.target as Element).closest?.('button') && sfx('click', { vol: 0.5 });
    addEventListener('click', click);
    return () => removeEventListener('click', click);
  }, []);

  const update = (next: typeof db) => { save(next); setDb(next); };
  const go = (s: Screen) => {
    if (s.at === 'play') energy0.current = players.map((p) => p.energy);
    setScreen(s);
  };
  const chooseMode = (m: Mode) => { setMode(m); setPlayers(m === 'together' ? 2 : 1); };
  const toggleFx = () => { effects.on = !fx; setFx(!fx); try { localStorage.setItem('romp.fx', fx ? 'off' : 'on'); } catch { /* private mode */ } };
  const start = async () => {
    // Fullscreen first: it needs the tap's user-activation, which is gone once the camera prompt and model load finish.
    try { void document.documentElement.requestFullscreen().catch(() => {}); } catch { /* not supported — play windowed */ }
    void audio().resume(); // same reason: games are later started by a hand-dwell, which is not a user gesture
    void loadAudio(); // samples decode in the background; until then sounds fall back to synth blips
    try { await startPose(video.current!); } catch (e) {
      return setError(`Camera or tracker failed: ${(e as Error).message}. Allow the camera — and if this is the http://192.168… address, add it under chrome://flags → “Insecure origins treated as secure” first.`);
    }
    go({ at: 'home' });
  };

  const finish = (run: Round, gameScores: number[]) => {
    const earned = gameScores.map((_, i) => Math.round((players[i].energy - energy0.current[i]) / tuning.energyPerPoint));
    const scores = [...run.scores, ...gameScores], points = [...run.points, ...earned];
    if (mode === 'turns' && run.turn === 0) return go({ ...run, at: 'next', turn: 1, scores, points });

    // Book the round one player at a time, comparing each player's progress before and after their own row lands.
    const t = Date.now(), id = run.game.id;
    let sessions = db.sessions;
    const rewards = scores.map((score, i): Reward => {
      const me = name(i), best = summary(sessions, me).best[id] ?? 0, level = levelOf(xpOf(sessions, me)).level;
      const hadBadges = badgesOf(sessions, me, t), hadDone = dailyChallenges(sessions, me, NAMES, t).filter((c) => c.done).map((c) => c.id);
      const stars = starsFor(id, run.stage, score), newBest = score > best;
      const xp = sessionXp({ points: points[i], stars, stage: run.stage, newBest });
      sessions = [...sessions, { t, game: id, who: me, score, points: points[i], stage: run.stage, stars, xp }];
      const challenges = dailyChallenges(sessions, me, NAMES, t).filter((c) => c.done && !hadDone.includes(c.id));
      sessions = [...sessions, ...challenges.map((c) => ({ t, game: `bonus:${c.id}`, who: me, score: 0, points: 0, xp: CHALLENGE_XP }))];
      const levelNow = levelOf(xpOf(sessions, me)).level;
      return { stars, xp: xp + challenges.length * CHALLENGE_XP, newBest, levelUp: levelNow > level ? levelNow : 0, badges: badgesOf(sessions, me, t).filter((b) => !hadBadges.includes(b)), challenges: challenges.map((c) => c.text) };
    });
    update({ ...db, sessions });
    go({ ...run, at: 'results', scores, points, rewards });

    if (rewards.some((r) => r.stars)) jingle('win');
    if (rewards.some((r) => r.levelUp)) say('level_up');
    else if (rewards.some((r) => r.challenges.length)) say('mission_completed');
    else if (rewards.some((r) => r.newBest)) say('new_highscore');
    else if (scores.length === 2 && scores[0] === scores[1]) say('its_a_tie');
    else if (rewards.some((r) => r.stars === 3)) say('congratulations');
  };
  const play = (game: Game, stage: number) => go({ at: 'play', game, stage, turn: 0, scores: [], points: [], rewards: [] });
  const cycle = (slot: number) => setWho((w) => w.map((v, i) => (i === slot ? (v + 1) % db.profiles.length : v)));
  const rename = (slot: number) => {
    const old = name(slot), next = prompt('Name', old)?.trim();
    if (!next || next === old || db.profiles.includes(next)) return;
    update({ profiles: db.profiles.map((p) => (p === old ? next : p)), sessions: db.sessions.map((s) => (s.who === old ? { ...s, who: next } : s)) });
  };

  const slots = mode === 'solo' ? [0] : [0, 1];
  const clash = slots.length === 2 && who[0] === who[1];
  // A stage is open if any of the people about to play has opened it.
  const open = (game: Game) => Math.max(...slots.map((i) => unlockedStage(db.sessions, name(i), game.id)));
  return (
    <>
      <video className="mirror" ref={video} muted playsInline />
      {screen.at === 'start' && (
        <div className="screen">
          <h1>Romp</h1>
          <p className="muted">Stand the tablet under the TV, press start, then step back until your whole body is in view.</p>
          <div className="row"><button className="primary" onClick={start}>Start</button></div>
          {error && <p className="error">{error}</p>}
        </div>
      )}
      {screen.at === 'home' && (
        <div className="screen">
          <div className="row">
            <h1>Romp</h1>
            <p className="muted num small grow">Hold a hand over a button to press it · <Fps /></p>
            <button className="small" onClick={toggleFx}>Glow {fx ? 'on' : 'off'}</button>
            <button className="small" onClick={() => go({ at: 'badges' })}>Badges</button>
            <button className="small" onClick={() => go({ at: 'stats' })}>Stats</button>
          </div>
          <div className="split">
            <div className="col">
              <div className="row">
                {(Object.keys(MODES) as Mode[]).map((m) => <button key={m} aria-pressed={mode === m} onClick={() => chooseMode(m)}>{MODES[m]}</button>)}
              </div>
              {slots.map((i) => (
                <div className="row" key={i}>
                  <span className="muted label">{mode === 'together' ? (i ? 'Right' : 'Left') : mode === 'turns' ? (i ? 'Second' : 'First') : 'Player'}</span>
                  <button onClick={() => cycle(i)}>{name(i)}</button>
                  <button className="small" onClick={() => rename(i)}>Rename</button>
                  <LevelChip sessions={db.sessions} who={name(i)} />
                </div>
              ))}
              {clash && <p className="error">Pick two different players.</p>}
            </div>
            <div className="panel">
              <h2>Today · {name(0)} <span className="muted num">{summary(db.sessions, name(0)).today} / {DAY_GOAL} points · {summary(db.sessions, name(0)).streak} day streak</span></h2>
              {dailyChallenges(db.sessions, name(0), NAMES).map((c) => (
                <p key={c.id} className={c.done ? 'done num' : 'num'}>{c.done ? '✓' : '○'} {c.text} <span className="muted">{c.have} / {c.goal} · +{CHALLENGE_XP} XP</span></p>
              ))}
            </div>
          </div>
          <div className="cards">
            {GAMES.filter((g) => g.maxPlayers >= n).map((g) => (
              <button className="card" key={g.id} disabled={clash} onClick={() => go({ at: 'brief', game: g, stage: open(g) })}>
                {g.name}<small>{g.blurb}</small>
                <small className="num">Stage {open(g)} · <Stars n={bestStars(db.sessions, name(0), g.id, open(g))} /></small>
              </button>
            ))}
          </div>
        </div>
      )}
      {screen.at === 'brief' && (
        <div className="screen">
          <div className="row"><h1 className="grow">{screen.game.name}</h1><button onClick={() => go({ at: 'home' })}>Back</button></div>
          <p className="how">{screen.game.how}</p>
          <h2>Stage</h2>
          <div className="row">
            {Array.from({ length: STAGES }, (_, k) => k + 1).map((st) => (
              <button key={st} className="stagebtn" aria-pressed={screen.stage === st} disabled={st > open(screen.game)} onClick={() => go({ ...screen, stage: st })}>
                {st}<small>{st > open(screen.game) ? 'Locked' : <Stars n={bestStars(db.sessions, name(0), screen.game.id, st)} />}</small>
              </button>
            ))}
          </div>
          <p className="muted num">
            Score {starGoals(screen.game.id, screen.stage).map((goal, k) => `${goal} for ${'★'.repeat(k + 1)}`).join(' · ')}. Two stars open the next stage.
            Best here: {Math.max(0, ...db.sessions.filter((s) => s.who === name(0) && s.game === screen.game.id && (s.stage ?? 1) === screen.stage).map((s) => s.score))}
          </p>
          <div className="row"><button className="primary big" onClick={() => play(screen.game, screen.stage)}>Play</button></div>
        </div>
      )}
      {screen.at === 'play' && <screen.game.Play key={screen.turn} n={n} stage={screen.stage} onEnd={(scores) => finish(screen, scores)} />}
      {screen.at === 'next' && (
        <div className="screen">
          <h1>{name(0)} scored {screen.scores[0]}</h1>
          <p className="muted">{name(1)}, step in. {name(0)}, step out of view.</p>
          <div className="row"><button className="primary" onClick={() => go({ ...screen, at: 'play' })}>Ready</button></div>
        </div>
      )}
      {screen.at === 'results' && (
        <div className="screen">
          <h1>{screen.game.name} · stage {screen.stage}</h1>
          <div className="split">
            {screen.scores.map((score, i) => {
              const r = screen.rewards[i], s = summary(db.sessions, name(i)), top = screen.scores.length === 2 && score > screen.scores[1 - i];
              return (
                <div className="panel result" key={i}>
                  <h2>{name(i)} {top && <span className="lead">wins</span>}</h2>
                  <p className="score num">{score} <Stars n={r.stars} /></p>
                  {r.newBest && <p className="lead">New best!</p>}
                  <p className="num">+{r.xp} XP <span className="muted">· +{screen.points[i]} activity points · today {s.today} / {DAY_GOAL} · {s.streak} day streak</span></p>
                  <LevelChip sessions={db.sessions} who={name(i)} />
                  {r.levelUp > 0 && <p className="lead">Level up! You are level {r.levelUp}.</p>}
                  {r.challenges.map((c) => <p key={c} className="done">✓ Challenge done: {c}</p>)}
                  {r.badges.map((b) => <p key={b} className="done">Badge unlocked: {BADGES.find((x) => x.id === b)!.name}</p>)}
                  {r.stars < 3 && <p className="muted num">Next star at {starGoals(screen.game.id, screen.stage)[r.stars]}</p>}
                </div>
              );
            })}
          </div>
          <div className="row">
            <button className="primary" onClick={() => play(screen.game, screen.stage)}>Play again</button>
            {screen.stage < open(screen.game) && <button onClick={() => play(screen.game, screen.stage + 1)}>Next stage</button>}
            <button onClick={() => go({ at: 'home' })}>Home</button>
          </div>
        </div>
      )}
      {screen.at === 'badges' && (
        <div className="screen">
          <div className="row"><h1 className="grow">Badges · {name(0)}</h1><button onClick={() => go({ at: 'home' })}>Back</button></div>
          <div className="badges">
            {BADGES.map((b) => {
              const has = badgesOf(db.sessions, name(0)).includes(b.id);
              return <div key={b.id} className={has ? 'badge has' : 'badge'}><b>{has ? '★ ' : ''}{b.name}</b><small>{b.how}</small></div>;
            })}
          </div>
        </div>
      )}
      {screen.at === 'stats' && (
        <div className="screen">
          <div className="row"><h1 className="grow">Stats</h1><button onClick={() => go({ at: 'home' })}>Back</button></div>
          <div className="split">
            <table className="num">
              <thead><tr><th>Player</th><th>Level</th><th>Stars</th><th>Today</th><th>7 days</th><th>Streak</th></tr></thead>
              <tbody>
                {db.profiles.map((p) => {
                  const s = summary(db.sessions, p);
                  return <tr key={p}><td>{p}</td><td>{levelOf(xpOf(db.sessions, p)).level}</td><td>{totalStars(db.sessions, p)}</td><td>{s.today} / {DAY_GOAL}</td><td>{s.week}</td><td>{s.streak}</td></tr>;
                })}
              </tbody>
            </table>
            <table className="num tight">
              <thead><tr><th>Best score</th>{db.profiles.map((p) => <th key={p}>{p}</th>)}</tr></thead>
              <tbody>
                {GAMES.map((g) => {
                  const best = db.profiles.map((p) => summary(db.sessions, p).best[g.id] ?? 0), top = Math.max(...best);
                  return <tr key={g.id}><td>{g.name}</td>{best.map((v, i) => <td key={i} className={v && v === top ? 'lead' : ''}>{v || '—'}</td>)}</tr>;
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
      {screen.at !== 'play' && screen.at !== 'start' && <HandCursor />}
    </>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
