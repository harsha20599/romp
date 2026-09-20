// The 16:9 stage: a HUD of DOM text written via refs (nothing per-frame goes through React state), and under it the
// one PlayCanvas canvas. The engine and the game are fetched when the first round starts — the menus never pay for them.
import { createContext, useContext, useEffect, useMemo, useRef, type FC } from 'react';
import { music } from './audio.ts';
import type { GameModule, GameProps, Hud } from './kit.ts';
export { audio, jingle, say, sfx } from './audio.ts';
export { PLAYER_COLORS, effects, paceSummary } from './pace.ts';
export type { GameProps } from './kit.ts';

// The shell's hook into a running game: a tap or click anywhere on the stage asks to pause, and while paused the
// frame loop stops (so every game's clock stops with it). Context, so no game has to know any of this exists.
export const Shell = createContext({ paused: false, pause: () => {} });

// The shell mounts a game as a component; its code and models are only fetched when it is first played.
// `warm()` starts fetching both ahead of time (the shell calls it on the briefing screen), so "Play" never waits on the network.
export type Playable = FC<GameProps> & { warm: () => void };
export const play = (load: () => Promise<GameModule>): Playable =>
  Object.assign((props: GameProps) => <Stage {...props} load={load} />, { warm: () => { void import('./engine.ts'); void load(); } });

function Stage({ n, stage, mode, team, best, onEnd, load }: GameProps & { load: () => Promise<GameModule> }) {
  const engine = useRef<typeof import('./engine.ts') | null>(null), paused = useRef(false);
  const els = useRef<Record<string, HTMLElement | null>>({}), shown = useRef<Record<string, string>>({});
  const hud = useMemo<Hud>(() => {
    const set = (key: string, text: string) => {
      if (shown.current[key] === text || !els.current[key]) return;
      els.current[key]!.textContent = shown.current[key] = text;
      // New words pop. `scale` (not `transform`) so the centring transforms on these elements are left alone.
      if (text && key !== 'clock' && !key.startsWith('s')) els.current[key]!.animate([{ scale: key === 'big' ? 1.7 : 1.35 }, { scale: 1 }], { duration: 320, easing: 'cubic-bezier(0.34, 1.56, 0.64, 1)' });
    };
    // Web Animations API: a full-stage colour wash that fades itself out.
    const flash = (color: string) => els.current.flash?.animate([{ background: color, opacity: 0.45 }, { background: color, opacity: 0 }], 350);
    const shake = (amount = 1) => els.current.stage?.animate(
      Array.from({ length: 7 }, (_, k) => ({ transform: k === 6 ? 'none' : `translate(${(Math.random() - 0.5) * 24 * amount}px, ${(Math.random() - 0.5) * 24 * amount}px)` })), 260);
    let clear = 0;
    const banner = (text: string, ms = 1400) => { set('banner', text); clearTimeout(clear); clear = window.setTimeout(() => set('banner', ''), ms); };
    // Words that rise from where something happened. A small pool of DOM nodes, moved and animated — never created mid-round.
    let next = 0;
    const pop = (x: number, y: number, text: string, color = '#ffffff', z = 0) => {
      const layer = els.current.pops, at = engine.current?.toScreen(x, y, z);
      if (!layer || !at) return;
      const el = layer.children[(next = (next + 1) % layer.children.length)] as HTMLElement;
      el.textContent = text;
      el.style.cssText = `left:${at[0] * 100}%;top:${at[1] * 100}%;color:${color}`;
      el.animate([{ opacity: 0, transform: 'translate(-50%, -30%) scale(0.6)' }, { opacity: 1, transform: 'translate(-50%, -90%) scale(1.15)', offset: 0.2 }, { opacity: 1, transform: 'translate(-50%, -130%) scale(1)', offset: 0.7 }, { opacity: 0, transform: 'translate(-50%, -170%) scale(1)' }], { duration: 850, easing: 'ease-out' });
    };
    return Object.assign(set, { flash, shake, banner, pop, p: (kind: 's' | 'h', p: number, text: string) => set(kind + p, text) });
  }, []);
  const shell = useContext(Shell), finish = useRef(onEnd);
  finish.current = onEnd;
  useEffect(() => { paused.current = shell.paused; engine.current?.pause(shell.paused); }, [shell.paused]);
  useEffect(() => {
    let gone = false;
    const cleanups: (() => void)[] = [];
    void (async () => {
      const [pc, game] = await Promise.all([import('./engine.ts'), load()]);
      if (gone) return;
      engine.current = pc;
      pc.mount(els.current.stage!);
      const tick = await game.default({ n, stage, mode, team, best, hud, scene: pc.begin(game.view), onEnd: (scores, notes) => { if (!gone) finish.current(scores, notes); }, cleanup: (fn) => cleanups.push(fn) });
      if (gone) return;
      pc.run(tick);
      pc.pause(paused.current);
    })().catch((err) => console.error('game failed to start', err));
    return () => { gone = true; music.stop(); cleanups.forEach((fn) => fn()); engine.current?.end(); engine.current?.unmount(); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps -- a round is mounted once; the shell remounts (key) for the next one
  const el = (key: string, className: string) => <div className={`hud ${className}`} ref={(e) => void (els.current[key] = e)} />;
  return (
    <div className="stage" ref={(e) => void (els.current.stage = e)} onClick={shell.pause}>
      {el('flash', 'flash')}{el('clock', 'clock')}{el('big', 'big')}{el('banner', 'banner')}
      <div className="pops" ref={(e) => void (els.current.pops = e)}>{Array.from({ length: 14 }, (_, k) => <span key={k} />)}</div>
      {/* A team has one score, in the middle; each player keeps their own hint. */}
      {el('s0', team ? 'score team' : n === 1 ? 'score solo' : 'score p1')}{el('h0', n === 1 ? 'hint solo' : 'hint p1')}
      {n === 2 && !team && el('s1', 'score p2')}{n === 2 && el('h1', 'hint p2')}
    </div>
  );
}

