// Freeze — dance while the music plays: the more you move, the more you score. When it cuts out, freeze.
// Any wobble costs points; a perfectly still freeze pays a bonus. Works wherever you stand, so it is compact.
import { useLayoutEffect, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { players, tuning } from './pose.ts';
import { hardness } from './meta.ts';
import { COUNTDOWN, H, PLAYER_COLORS, Stage, audio, music, say, sfx, scoreHud, useBursts, zoneX, type GameProps, type Hud } from './stage.tsx';

const ROUND = 60, GRACE = 0.6; // seconds after the music stops before movement counts against you
const orbGeo = new THREE.IcosahedronGeometry(1.1, 1);

function Scene({ n, stage, onEnd, hud }: GameProps & { hud: Hud }) {
  const hard = hardness(stage);
  const orbs = useRef<(THREE.Mesh<THREE.BufferGeometry, THREE.MeshLambertMaterial> | null)[]>([]);
  const bursts = useBursts();
  const g = useRef({
    start: audio().currentTime + COUNTDOWN, last: 0, done: false, dancing: true, phaseEnd: 7, phaseAt: 0,
    scores: [0, 0], rate: [0, 0], energy: players.map((p) => p.energy), moved: [false, false], nagged: [0, 0],
  }).current;
  useLayoutEffect(() => { music.start('dance', g.start, 0.9); return () => music.stop(); }, [g]);

  useFrame(() => {
    if (g.done) return;
    const t = audio().currentTime - g.start, dt = Math.max(1e-3, Math.min(0.05, t - g.last));
    g.last = t;
    hud('clock', String(Math.ceil(t < 0 ? -t : ROUND - t)));
    if (t >= ROUND) { g.done = true; music.stop(); say('time_over'); return onEnd(g.scores.slice(0, n).map(Math.round)); }

    if (t >= g.phaseEnd) {
      if (!g.dancing)
        for (let p = 0; p < n; p++) if (players[p].present && !g.moved[p]) { g.scores[p] += 15; bursts.burst(zoneX(n, p), 0, 0.5, '#7dd3fc', 40, 9); }
      g.dancing = !g.dancing;
      g.phaseAt = t;
      g.phaseEnd = t + (g.dancing ? 4 + Math.random() * 5 : (2.5 + Math.random() * 2) * Math.sqrt(hard));
      g.moved = [false, false];
      sfx(g.dancing ? 'zapThreeToneUp' : 'zapThreeToneDown', { vol: 0.8, jitter: 0 });
      hud.flash(g.dancing ? '#a78bfa' : '#38bdf8');
    }
    music.gate(g.dancing && t >= 0);
    hud('big', t < 0 ? String(Math.ceil(-t)) : t - g.phaseAt < 1 ? (g.dancing ? 'Dance!' : 'Freeze!') : '');

    for (let p = 0; p < n; p++) {
      const pl = players[p], orb = orbs.current[p], x = zoneX(n, p);
      // Movement rate, in shoulder-widths of limb travel per second. A flat-out dance is around 10–15.
      g.rate[p] += ((pl.energy - g.energy[p]) / dt - g.rate[p]) * Math.min(1, dt * 6);
      g.energy[p] = pl.energy;
      const rate = g.rate[p], judging = !g.dancing && t - g.phaseAt > GRACE, wobble = judging && rate > tuning.freezeStill / hard; // higher stages forgive less
      if (t >= 0 && g.dancing) {
        g.scores[p] += Math.min(rate, 15) * dt;
        if (rate > 4 && Math.random() < rate / 30) bursts.burst(x + (Math.random() - 0.5) * 3, (Math.random() - 0.5) * 4, 0.5, PLAYER_COLORS[p], 3, 4);
      } else if (wobble) {
        g.scores[p] = Math.max(0, g.scores[p] - 10 * dt);
        g.moved[p] = true;
        if (t - g.nagged[p] > 0.5) { g.nagged[p] = t; sfx('error', { vol: 0.6 }); hud.shake(0.4); }
      }
      hud.p('h', p, t < 0 ? 'Dance, then freeze' : g.dancing ? (rate > 8 ? 'On fire!' : rate < 2 ? 'Move!' : '') : wobble ? 'You moved!' : g.moved[p] ? '' : 'Hold it…');
      if (!orb) continue;
      orb.visible = pl.present;
      orb.position.set(x, 0, 0);
      orb.scale.setScalar(1 + Math.min(rate, 15) / 10);
      orb.rotation.y += dt * (0.3 + rate * 0.4); orb.rotation.x += dt * rate * 0.2;
      orb.material.color.set(g.dancing ? PLAYER_COLORS[p] : wobble ? '#ef4444' : '#7dd3fc');
      orb.material.emissive.set(g.dancing ? '#000000' : wobble ? '#7f1d1d' : '#0c4a6e');
    }
    bursts.update(dt);
    scoreHud(hud, n, g.scores);
  });

  return (
    <>
      {Array.from({ length: n }, (_, p) => (
        <mesh key={p} ref={(m) => void (orbs.current[p] = m as never)} geometry={orbGeo} visible={false}><meshLambertMaterial flatShading /></mesh>
      ))}
      {bursts.node}
      {n === 2 && <mesh><planeGeometry args={[0.04, H]} /><meshBasicMaterial color="#3f3f46" /></mesh>}
    </>
  );
}

export default (props: GameProps) => <Stage n={props.n}>{(hud) => <Scene {...props} hud={hud} />}</Stage>;
