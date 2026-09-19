// Shell: start → home (who plays, which game) → play → results → stats. Driven by hand, touch or keyboard.
import { useEffect, useRef, useState, type FC } from 'react';
import { createRoot } from 'react-dom/client';
import { perf, players, setPlayers, startPose, tuning } from './pose.ts';
import { DAY_GOAL, load, save, summary } from './stats.ts';
import { audio, type GameProps } from './stage.tsx';
import Slice from './Slice.tsx';
import Dodge from './Dodge.tsx';
import Jab from './Jab.tsx';
import Beat from './Beat.tsx';
import ShapeUp from './ShapeUp.tsx';

type Game = { id: string; name: string; blurb: string; maxPlayers: 1 | 2; Play: FC<GameProps> };
// The library. A new game = one component + one row here. maxPlayers 2 only for compact-footprint games (PLAN §3);
// a wide game is still playable by two through "Take turns".
const GAMES: Game[] = [
  { id: 'slice', name: 'Slice', blurb: 'Cut the fruit, dodge the bombs.', maxPlayers: 2, Play: Slice },
  { id: 'dodge', name: 'Dodge', blurb: 'Jump, duck and lean past what is coming.', maxPlayers: 2, Play: Dodge },
  { id: 'jab', name: 'Jab', blurb: 'Punch the pads, duck the bar.', maxPlayers: 2, Play: Jab },
  { id: 'beat', name: 'Beat', blurb: 'Hit the moves in time with the drums.', maxPlayers: 2, Play: Beat },
  { id: 'shapeup', name: 'Shape Up', blurb: 'Match the pose before it lands.', maxPlayers: 1, Play: ShapeUp },
];

const MODES = { solo: 'Solo', together: 'Together', turns: 'Take turns' } as const;
type Mode = keyof typeof MODES;
type Run = { game: Game; turn: number; scores: number[]; points: number[] };
type Screen = { at: 'start' | 'home' | 'stats' } | ({ at: 'play' | 'next' | 'results' } & Run);

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
  const n = mode === 'together' ? 2 : 1; // bodies tracked at once; "turns" is two people, one at a time
  const energy0 = useRef([0, 0]);

  const update = (next: typeof db) => { save(next); setDb(next); };
  const go = (s: Screen) => {
    if (s.at === 'play') energy0.current = players.map((p) => p.energy);
    setScreen(s);
  };
  const chooseMode = (m: Mode) => { setMode(m); setPlayers(m === 'together' ? 2 : 1); };
  const start = async () => {
    // Fullscreen first: it needs the tap's user-activation, which is gone once the camera prompt and model load finish.
    try { void document.documentElement.requestFullscreen().catch(() => {}); } catch { /* not supported — play windowed */ }
    void audio().resume(); // same reason: games are later started by a hand-dwell, which is not a user gesture
    try { await startPose(video.current!); } catch (e) {
      return setError(`Camera or tracker failed: ${(e as Error).message}. Allow the camera — and if this is the http://192.168… address, add it under chrome://flags → “Insecure origins treated as secure” first.`);
    }
    go({ at: 'home' });
  };
  const finish = (run: Run, gameScores: number[]) => {
    const earned = gameScores.map((_, i) => Math.round((players[i].energy - energy0.current[i]) / tuning.energyPerPoint));
    const scores = [...run.scores, ...gameScores], points = [...run.points, ...earned];
    if (mode === 'turns' && run.turn === 0) return go({ ...run, at: 'next', turn: 1, scores, points });
    const t = Date.now();
    update({ ...db, sessions: [...db.sessions, ...scores.map((score, i) => ({ t, game: run.game.id, who: db.profiles[who[i]], score, points: points[i] }))] });
    go({ ...run, at: 'results', scores, points });
  };
  const play = (game: Game) => go({ at: 'play', game, turn: 0, scores: [], points: [] });
  const cycle = (slot: number) => setWho((w) => w.map((v, i) => (i === slot ? (v + 1) % db.profiles.length : v)));
  const rename = (slot: number) => {
    const old = db.profiles[who[slot]], name = prompt('Name', old)?.trim();
    if (!name || name === old || db.profiles.includes(name)) return;
    update({ profiles: db.profiles.map((p) => (p === old ? name : p)), sessions: db.sessions.map((s) => (s.who === old ? { ...s, who: name } : s)) });
  };

  const slots = mode === 'solo' ? [0] : [0, 1];
  const clash = slots.length === 2 && who[0] === who[1];
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
          <div className="row"><h1 className="grow">Romp</h1><button onClick={() => go({ at: 'stats' })}>Stats</button></div>
          <h2>Who is playing</h2>
          <div className="row">
            {(Object.keys(MODES) as Mode[]).map((m) => <button key={m} aria-pressed={mode === m} onClick={() => chooseMode(m)}>{MODES[m]}</button>)}
          </div>
          <div className="row">
            {slots.map((i) => (
              <span className="row" key={i}>
                <span className="muted">{mode === 'together' ? (i ? 'Right' : 'Left') : mode === 'turns' ? (i ? 'Second' : 'First') : 'Player'}</span>
                <button onClick={() => cycle(i)}>{db.profiles[who[i]]}</button>
                <button className="small" onClick={() => rename(i)}>Rename</button>
              </span>
            ))}
          </div>
          {clash && <p className="error">Pick two different players.</p>}
          <h2>Games</h2>
          <div className="cards">
            {GAMES.filter((g) => g.maxPlayers >= n).map((g) => (
              <button className="card" key={g.id} disabled={clash} onClick={() => play(g)}>
                {g.name}<small>{g.blurb}</small>
              </button>
            ))}
          </div>
          <div className="grow" />
          <p className="muted num">Hold a hand over a button to press it · <Fps /></p>
        </div>
      )}
      {screen.at === 'play' && <screen.game.Play key={screen.turn} n={n} onEnd={(scores) => finish(screen, scores)} />}
      {screen.at === 'next' && (
        <div className="screen">
          <h1>{db.profiles[who[0]]} scored {screen.scores[0]}</h1>
          <p className="muted">{db.profiles[who[1]]}, step in. {db.profiles[who[0]]}, step out of view.</p>
          <div className="row"><button className="primary" onClick={() => go({ ...screen, at: 'play' })}>Ready</button></div>
        </div>
      )}
      {screen.at === 'results' && (
        <div className="screen">
          <h1>{screen.game.name} — done</h1>
          <table className="num">
            <thead><tr><th>Player</th><th>Score</th><th>Activity points</th><th>Today</th><th>Streak</th></tr></thead>
            <tbody>
              {screen.scores.map((score, i) => {
                const s = summary(db.sessions, db.profiles[who[i]]);
                return (
                  <tr key={i}>
                    <td>{db.profiles[who[i]]}</td><td>{score}</td><td>+{screen.points[i]}</td>
                    <td>{s.today} / {DAY_GOAL}</td><td>{s.streak} {s.streak === 1 ? 'day' : 'days'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div className="row">
            <button className="primary" onClick={() => play(screen.game)}>Play again</button>
            <button onClick={() => go({ at: 'home' })}>Home</button>
          </div>
        </div>
      )}
      {screen.at === 'stats' && (
        <div className="screen">
          <div className="row"><h1 className="grow">Stats</h1><button onClick={() => go({ at: 'home' })}>Back</button></div>
          <table className="num">
            <thead><tr><th>Player</th><th>Today</th><th>7 days</th><th>Streak</th><th>All time</th>{GAMES.map((g) => <th key={g.id}>Best {g.name}</th>)}</tr></thead>
            <tbody>
              {db.profiles.map((p) => {
                const s = summary(db.sessions, p);
                return <tr key={p}><td>{p}</td><td>{s.today} / {DAY_GOAL}</td><td>{s.week}</td><td>{s.streak}</td><td>{s.total}</td>{GAMES.map((g) => <td key={g.id}>{s.best[g.id] ?? '—'}</td>)}</tr>;
              })}
            </tbody>
          </table>
        </div>
      )}
      {screen.at !== 'play' && screen.at !== 'start' && <HandCursor />}
    </>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
