// Shell: start → home (who plays, which game) → play → results → stats. Driven by hand, touch or keyboard.
import { useEffect, useRef, useState, type FC } from 'react';
import { createRoot } from 'react-dom/client';
import { perf, players, setPlayers, startPose, tuning } from './pose.ts';
import { DAY_GOAL, load, save, summary } from './stats.ts';
import Slice from './Slice.tsx';

type Game = { id: string; name: string; blurb: string; maxPlayers: 1 | 2; Play: FC<{ n: number; onEnd: (scores: number[]) => void }> };
// The library. A new game = one component + one row here. maxPlayers 2 only for compact-footprint games (PLAN §3).
const GAMES: Game[] = [{ id: 'slice', name: 'Slice', blurb: 'Cut the fruit, dodge the bombs. 60 seconds.', maxPlayers: 2, Play: Slice }];

type Screen =
  | { at: 'start' | 'home' | 'stats' }
  | { at: 'play'; game: Game }
  | { at: 'results'; game: Game; scores: number[]; points: number[] };

// The pointer is P1's higher visible hand; holding it over a button for DWELL ms clicks it.
const DWELL = 1200;
function HandCursor() {
  const el = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let raf = 0, target: Element | null = null, since = 0;
    const loop = (now: number) => {
      raf = requestAnimationFrame(loop);
      const hand = players[0].hands.filter((h) => h.seen).sort((a, b) => b.y - a.y)[0];
      const on = players[0].present && !!hand;
      el.current!.style.display = on ? '' : 'none';
      if (!on) return;
      const x = ((hand.x + 1) / 2) * innerWidth, y = ((1 - hand.y) / 2) * innerHeight;
      el.current!.style.transform = `translate(${x}px, ${y}px)`;
      const over = document.elementFromPoint(x, y)?.closest('button') ?? null;
      if (over !== target) {
        target?.classList.remove('hot');
        over?.classList.add('hot');
        target = over;
        since = now;
      }
      const p = target ? Math.min(1, Math.max(0, (now - since) / DWELL)) : 0;
      el.current!.style.setProperty('--p', String(p));
      if (p === 1) { (target as HTMLButtonElement).click(); since = now + DWELL; } // pause before it can re-fire
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
  const [n, setN] = useState(1);
  const energy0 = useRef([0, 0]);

  const update = (next: typeof db) => { save(next); setDb(next); };
  const go = (s: Screen) => {
    if (s.at === 'play') energy0.current = players.map((p) => p.energy);
    setScreen(s);
  };
  const choosePlayers = (count: number) => { setN(count); setPlayers(count); };
  const start = async () => {
    // Fullscreen first: it needs the tap's user-activation, which is gone once the camera prompt and model load finish.
    try { void document.documentElement.requestFullscreen().catch(() => {}); } catch { /* not supported — play windowed */ }
    try { await startPose(video.current!); } catch (e) {
      return setError(`Camera or tracker failed: ${(e as Error).message}. Open this page as http://localhost (adb reverse) and allow the camera.`);
    }
    go({ at: 'home' });
  };
  const finish = (game: Game, scores: number[]) => {
    const points = scores.map((_, i) => Math.round((players[i].energy - energy0.current[i]) / tuning.energyPerPoint));
    const t = Date.now();
    update({ ...db, sessions: [...db.sessions, ...scores.map((score, i) => ({ t, game: game.id, who: db.profiles[who[i]], score, points: points[i] }))] });
    go({ at: 'results', game, scores, points });
  };
  const cycle = (slot: number) => setWho((w) => w.map((v, i) => (i === slot ? (v + 1) % db.profiles.length : v)));
  const rename = (slot: number) => {
    const old = db.profiles[who[slot]], name = prompt('Name', old)?.trim();
    if (!name || name === old || db.profiles.includes(name)) return;
    update({ profiles: db.profiles.map((p) => (p === old ? name : p)), sessions: db.sessions.map((s) => (s.who === old ? { ...s, who: name } : s)) });
  };

  const slots = Array.from({ length: n }, (_, i) => i);
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
            {[1, 2].map((c) => <button key={c} aria-pressed={n === c} onClick={() => choosePlayers(c)}>{c === 1 ? 'Solo' : 'Together'}</button>)}
          </div>
          {slots.map((i) => (
            <div className="row" key={i}>
              <span className="muted">{n === 2 ? (i ? 'Right' : 'Left') : 'Player'}</span>
              <button onClick={() => cycle(i)}>{db.profiles[who[i]]}</button>
              <button onClick={() => rename(i)}>Rename</button>
            </div>
          ))}
          {n === 2 && who[0] === who[1] && <p className="error">Pick two different players.</p>}
          <h2>Games</h2>
          <div className="row">
            {GAMES.filter((g) => g.maxPlayers >= n).map((g) => (
              <button className="card" key={g.id} disabled={n === 2 && who[0] === who[1]} onClick={() => go({ at: 'play', game: g })}>
                {g.name}<small>{g.blurb}</small>
              </button>
            ))}
          </div>
          <div className="grow" />
          <p className="muted num">Hold a hand over a button to press it · <Fps /></p>
        </div>
      )}
      {screen.at === 'play' && <screen.game.Play n={n} onEnd={(scores) => finish(screen.game, scores)} />}
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
            <button className="primary" onClick={() => go({ at: 'play', game: screen.game })}>Play again</button>
            <button onClick={() => go({ at: 'home' })}>Home</button>
          </div>
        </div>
      )}
      {screen.at === 'stats' && (
        <div className="screen">
          <div className="row"><h1 className="grow">Stats</h1><button onClick={() => go({ at: 'home' })}>Back</button></div>
          <table className="num">
            <thead><tr><th>Player</th><th>Today</th><th>Streak</th><th>All-time points</th>{GAMES.map((g) => <th key={g.id}>Best {g.name}</th>)}</tr></thead>
            <tbody>
              {db.profiles.map((p) => {
                const s = summary(db.sessions, p);
                return <tr key={p}><td>{p}</td><td>{s.today} / {DAY_GOAL}</td><td>{s.streak}</td><td>{s.total}</td>{GAMES.map((g) => <td key={g.id}>{s.best[g.id] ?? '—'}</td>)}</tr>;
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
