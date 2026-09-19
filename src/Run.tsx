// Run — a three-lane endless runner you steer with your body: lean to change lane, jump the barrels,
// duck the beams, dodge the crate stacks, sweep up coins, grab power-ups. Forest on the early stages, city later.
// Two runners side by side share one obstacle sequence, so together-play is a fair race. Lean + vertical only: compact.
import { useLayoutEffect, useMemo, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { useGLTF } from '@react-three/drei';
import * as THREE from 'three';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { players, tuning } from './pose.ts';
import { hardness } from './meta.ts';
import { PLAYER_COLORS, Stage, hitSound, music, say, scoreHud, sfx, useBursts, useFitted, useRound, type GameProps, type Hud } from './stage.tsx';

const ROUND = 75, FAR = -70, LANE = 1.7, WINDOW = 1.1, POWER_TIME = 8;
const A = '/assets/kit/', C = '/assets/city/';
const FOREST = { sky: '#7dd3fc', ground: '#3f6212', road: '#a8a29e', props: [A + 'tree.glb', A + 'tree-pine.glb', A + 'rocks.glb', A + 'tree.glb', A + 'mushrooms.glb', A + 'tree-pine.glb'], size: [4.5, 5.5, 1.6, 5, 1.2, 6] };
const CITY = { sky: '#1e1b4b', ground: '#27272a', road: '#3f3f46', props: ['a', 'c', 'e', 'skyscraper-a', 'g', 'skyscraper-b'].map((b) => `${C}building-${b}.glb`), size: [7, 8, 7, 14, 8, 16] };

type Kind = 'barrels' | 'beam' | 'crates' | 'coins' | 'magnet' | 'shield' | 'double';
type Thing = { live: boolean; kind: Kind; lanes: number[]; z: number; cleared: boolean; taken: boolean[]; obj: THREE.Object3D };
const HINT: Partial<Record<Kind, string>> = { barrels: 'Jump!', beam: 'Duck!', crates: 'Change lane!' };

function Scene({ n, stage, onEnd, hud }: GameProps & { hud: Hud }) {
  const camera = useThree((s) => s.camera);
  useLayoutEffect(() => camera.lookAt(0, 1.6, -12), [camera]);
  const hard = hardness(stage), theme = stage >= 3 ? CITY : FOREST;
  const trackX = (p: number) => (n === 1 ? 0 : (p - 0.5) * 8.4);

  // Models: every instance is a clone of one fitted original.
  const barrel = useFitted(A + 'barrel.glb', 1.35, true), crate = useFitted(A + 'crate-strong.glb', 1.6, true), coin = useFitted(A + 'coin-gold.glb', 0.8);
  const star = useFitted(A + 'star.glb', 1.2), heart = useFitted(A + 'heart.glb', 1.2);
  const p0 = useFitted(theme.props[0], theme.size[0], true), p1 = useFitted(theme.props[1], theme.size[1], true), p2 = useFitted(theme.props[2], theme.size[2], true);
  const p3 = useFitted(theme.props[3], theme.size[3], true), p4 = useFitted(theme.props[4], theme.size[4], true), p5 = useFitted(theme.props[5], theme.size[5], true);
  const robot = useGLTF('/assets/robot.glb');

  const world = useMemo(() => {
    const root = new THREE.Group(), glow = (color: string) => new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 1.5 });
    // Built once and shared by every beam and magnet that ever spawns — nothing is allocated on the GPU mid-run.
    const barGeo = new THREE.BoxGeometry(LANE * 3.4, 0.5, 0.5), postGeo = new THREE.BoxGeometry(0.3, 2.7, 0.3), ringGeo = new THREE.TorusGeometry(0.5, 0.16, 8, 20, Math.PI);
    const barMat = glow('#22d3ee'), postMat = new THREE.MeshLambertMaterial({ color: '#52525b' }), ringMat = glow('#ef4444');
    const build: Record<Kind, (lanes: number[]) => THREE.Object3D> = {
      barrels: () => { const g = new THREE.Group(); [-1, 0, 1].forEach((l) => { const b = barrel.clone(); b.position.x = l * LANE; g.add(b); }); return g; },
      beam: () => {
        const g = new THREE.Group(), bar = new THREE.Mesh(barGeo, barMat);
        bar.position.y = 2.45;
        g.add(bar);
        [-1, 1].forEach((s) => { const post = new THREE.Mesh(postGeo, postMat); post.position.set(s * LANE * 1.7, 1.35, 0); g.add(post); });
        return g;
      },
      crates: (lanes) => { const g = new THREE.Group(); lanes.forEach((l) => [0, 1.6].forEach((y) => { const c = crate.clone(); c.position.set(l * LANE, y, 0); g.add(c); })); return g; },
      coins: (lanes) => { const g = new THREE.Group(); for (let k = 0; k < 5; k++) { const c = coin.clone(); c.position.set(lanes[0] * LANE, 1.1, -k * 1.7); g.add(c); } return g; },
      magnet: (lanes) => { const m = new THREE.Mesh(ringGeo, ringMat); m.position.set(lanes[0] * LANE, 1.3, 0); return m; },
      shield: (lanes) => { const h = heart.clone(); h.position.set(lanes[0] * LANE, 1.3, 0); return h; },
      double: (lanes) => { const s = star.clone(); s.position.set(lanes[0] * LANE, 1.3, 0); return s; },
    };
    // Scenery: a conveyor of props down both sides, recycled to the far end as they pass the camera.
    const originals = [p0, p1, p2, p3, p4, p5], scenery = Array.from({ length: 28 }, (_, i) => {
      const o = originals[i % 6].clone(), side = i % 2 ? 1 : -1;
      o.position.set(side * ((n === 1 ? 0 : 4.2) + LANE * 1.5 + 2.2 + theme.size[i % 6] * 0.45 + Math.random() * 3), 0, FAR + (i / 28) * (-FAR + 12));
      o.rotation.y = Math.random() * Math.PI * 2;
      root.add(o);
      return o;
    });
    return { root, build, scenery, things: Array.from({ length: n }, () => [] as Thing[]) };
  }, [barrel, crate, coin, star, heart, p0, p1, p2, p3, p4, p5, n, theme]);

  // Runners: a skinned clone each, with its own mixer. Running loops; Jump and Sitting are held poses we blend into.
  const runners = useMemo(() => Array.from({ length: n }, (_, p) => {
    const model = cloneSkinned(robot.scene), mixer = new THREE.AnimationMixer(model), holder = new THREE.Group();
    model.updateMatrixWorld(true); // a skinned mesh measures itself through its bones, so they must be current first
    const box = new THREE.Box3().setFromObject(model), k = 2.1 / (box.max.y - box.min.y);
    model.scale.setScalar(k);
    model.rotation.y = Math.PI; // face up the track, away from the camera
    model.traverse((o) => { if ((o as THREE.Mesh).isMesh && ((o as THREE.Mesh).material as THREE.MeshStandardMaterial).name === 'Main') ((o as THREE.Mesh).material = ((o as THREE.Mesh).material as THREE.MeshStandardMaterial).clone()).color.set(PLAYER_COLORS[p]); });
    holder.add(model);
    const act = Object.fromEntries(['Running', 'Jump', 'Sitting'].map((name) => [name, mixer.clipAction(THREE.AnimationClip.findByName(robot.animations, name)!)]));
    act.Jump.setLoop(THREE.LoopOnce, 1).clampWhenFinished = true;
    act.Sitting.setLoop(THREE.LoopOnce, 1).clampWhenFinished = true;
    act.Running.play();
    const bubble = new THREE.Mesh(new THREE.SphereGeometry(1.5, 20, 14), new THREE.MeshBasicMaterial({ color: '#f472b6', transparent: true, opacity: 0.25 }));
    bubble.position.y = 1.1;
    holder.add(bubble);
    return { holder, mixer, act, bubble, now: 'Running', x: 0 };
  }), [robot, n]);

  const stripes = useRef<(THREE.Mesh | null)[]>([]);
  const bursts = useBursts();
  const g = useRef({ dist: 0, nextRow: 30, row: 0, step: 0, scores: [0, 0], combo: [0, 0], hurt: [0, 0], magnet: [0, 0], double: [0, 0], shield: [false, false], said: [{ text: '', until: 0 }, { text: '', until: 0 }] }).current;
  const tick = useRound(hud, ROUND, () => { music.stop(); onEnd(g.scores.slice(0, n).map(Math.round)); });
  useLayoutEffect(() => { music.start('run'); return () => music.stop(); }, []);

  const spawn = (t: number) => {
    // A rhythm of obstacle, coins, obstacle, coins… with a power-up now and then. Same row for every runner.
    const r = g.row++, lane = () => Math.floor(Math.random() * 3) - 1;
    let kind: Kind, lanes: number[];
    if (r % 9 === 8) { kind = (['magnet', 'shield', 'double'] as Kind[])[Math.floor(Math.random() * 3)]; lanes = [lane()]; }
    else if (r % 2) { kind = 'coins'; lanes = [lane()]; }
    else {
      kind = (['barrels', 'beam', 'crates'] as Kind[])[t < 8 ? (r / 2) % 3 : Math.floor(Math.random() * 3)];
      const open = lane();
      lanes = kind === 'crates' ? [-1, 0, 1].filter((l) => l !== open && (hard > 1.3 || Math.random() < 0.6 || l === -open)) : [-1, 0, 1];
      if (kind === 'crates' && !lanes.length) lanes = [open === 0 ? 1 : 0];
    }
    world.things.forEach((list, p) => {
      const obj = world.build[kind](lanes);
      obj.position.x += trackX(p);
      world.root.add(obj);
      list.push({ live: true, kind, lanes, z: FAR, cleared: false, taken: [], obj });
    });
  };

  useFrame((_, rawDt) => {
    const dt = Math.min(rawDt, 0.05), t = tick(rawDt);
    if (t === null) return;
    const speed = (13 + 9 * Math.max(0, t / ROUND)) * hard, move = speed * dt;
    g.dist += move;
    if (t >= 0 && g.dist > g.nextRow) { g.nextRow = g.dist + Math.max(11, 24 - 8 * (t / ROUND)) / Math.sqrt(hard) + 4; spawn(t); }
    if ((g.step -= dt) < 0) { g.step = 3.4 / speed; sfx('footstep_concrete', { vol: 0.25 }); }

    for (let p = 0; p < n; p++) {
      const pl = players[p], R = runners[p], list = world.things[p];
      const air = pl.lift > tuning.jump, low = pl.lift < tuning.crouch;
      // Analog steering: the runner is wherever your body puts it, continuously — with a gentle pull toward the
      // nearest lane centre so you settle into lanes instead of hovering on the lines.
      const free = pl.steer * LANE * 1.1, target = free + (Math.round(free / LANE) * LANE - free) * 0.35;
      R.x += (Math.max(-LANE * 1.1, Math.min(LANE * 1.1, target)) - R.x) * Math.min(1, dt * 18);
      const inLane = Math.round(R.x / LANE);
      R.holder.visible = pl.present;
      R.holder.position.set(trackX(p) + R.x, Math.max(0, pl.lift) * 2.4, 0);
      R.holder.rotation.z = -pl.steer * 0.3 + (g.hurt[p] > 0 ? Math.sin(t * 40) * 0.15 : 0); // the robot leans as you lean
      R.holder.rotation.y = (target - R.x) * -0.25;
      R.bubble.visible = g.shield[p];
      const want = air ? 'Jump' : low ? 'Sitting' : 'Running';
      if (want !== R.now) { R.act[R.now].fadeOut(0.12); R.act[want].reset().fadeIn(0.12).play(); R.now = want; }
      R.act.Running.timeScale = speed / 11;
      R.mixer.update(dt);

      let next: Thing | undefined;
      for (const th of list) {
        if (!th.live) continue;
        th.z += move;
        th.obj.position.z = th.z;
        const near = Math.abs(th.z) < WINDOW;
        if (th.kind === 'coins') {
          th.obj.children.forEach((c, k) => {
            c.rotation.y += dt * 5;
            const cz = th.z - k * 1.7, magnet = g.magnet[p] > t && Math.abs(cz) < 6;
            if (magnet && c.visible) c.position.x += (R.x - c.position.x) * Math.min(1, dt * 10); // coins swing toward you
            if (c.visible && pl.present && Math.abs(cz) < 0.9 && (magnet || th.lanes[0] === inLane) && !air) {
              c.visible = false;
              g.scores[p] += 10 * (g.double[p] > t ? 2 : 1);
              hitSound('pepSound', th.taken.push(true), 0.5);
              bursts.burst(trackX(p) + R.x, 1.1, 0, '#fde047', 6, 4);
            }
          });
        } else if (th.kind === 'magnet' || th.kind === 'shield' || th.kind === 'double') {
          th.obj.rotation.y += dt * 3;
          if (near && pl.present && th.lanes[0] === inLane && !th.cleared) {
            th.cleared = true; th.obj.visible = false;
            if (th.kind === 'shield') g.shield[p] = true; else g[th.kind][p] = t + POWER_TIME;
            sfx('powerUp', { vol: 0.9 }); say('power_up');
            g.said[p] = { text: { magnet: 'Magnet!', shield: 'Shield!', double: 'Double coins!' }[th.kind], until: t + 1.5 };
            bursts.burst(trackX(p) + R.x, 1.3, 0, '#f472b6', 30, 8);
          }
        } else {
          if (near && (th.kind === 'barrels' ? air : th.kind === 'beam' ? low : !th.lanes.includes(inLane))) th.cleared = true; // any moment in the window counts
          if (near && th.kind === 'crates' && th.lanes.includes(inLane)) th.cleared = false; // …except being inside a crate
          if (th.z < -WINDOW && (!next || th.z > next.z)) next = th;
          if (th.z >= WINDOW && !th.taken.length) {
            th.taken.push(true);
            if (!pl.present) { /* nobody running on this track */ }
            else if (th.cleared) { g.scores[p] += 15 * (1 + Math.min(20, ++g.combo[p]) / 10); hitSound('phaseJump', g.combo[p], 0.35); }
            else if (g.shield[p]) { g.shield[p] = false; sfx('impactGlass_heavy'); bursts.burst(trackX(p) + R.x, 1.2, 0, '#f472b6', 40, 10); g.said[p] = { text: 'Shield saved you', until: t + 1.2 }; }
            else {
              g.combo[p] = 0; g.hurt[p] = 0.5;
              sfx(th.kind === 'beam' ? 'impactMetal_heavy' : 'impactWood_heavy'); hud.shake(); hud.flash('#ef4444');
              bursts.burst(trackX(p) + R.x, 1.2, 0, th.kind === 'beam' ? '#22d3ee' : '#b45309', 40, 11); // the obstacle goes to splinters
              th.obj.visible = false;
            }
          }
        }
        if (th.z > 12) { th.live = false; world.root.remove(th.obj); }
      }
      world.things[p] = list.filter((th) => th.live);
      g.hurt[p] = Math.max(0, g.hurt[p] - dt);
      const power = g.magnet[p] > t ? `Magnet ${Math.ceil(g.magnet[p] - t)}s` : g.double[p] > t ? `Double ${Math.ceil(g.double[p] - t)}s` : '';
      hud.p('h', p, g.said[p].until > t ? g.said[p].text : t < 25 && next && next.z > -30 ? HINT[next.kind]! : power || (g.combo[p] >= 3 ? `×${(1 + Math.min(20, g.combo[p]) / 10).toFixed(1)}` : ''));
    }
    music.intensity(0.3 + Math.max(g.combo[0], g.combo[1]) / 14);

    world.scenery.forEach((o) => { if ((o.position.z += move) > 12) o.position.z += FAR - 12; });
    stripes.current.forEach((s) => s && (s.position.z = ((s.position.z - FAR + move) % -FAR) + FAR));
    bursts.update(dt);
    scoreHud(hud, n, g.scores);
  });

  return (
    <>
      <color attach="background" args={[theme.sky]} />
      <fog attach="fog" args={[theme.sky, 30, 72]} />
      <hemisphereLight args={['#ffffff', theme.ground, 1.2]} />
      <mesh position={[0, -0.05, FAR / 2]} rotation-x={-Math.PI / 2}><planeGeometry args={[160, -FAR + 40]} /><meshLambertMaterial color={theme.ground} /></mesh>
      {Array.from({ length: n }, (_, p) => (
        <group key={p}>
          <mesh position={[trackX(p), 0, FAR / 2 + 5]} rotation-x={-Math.PI / 2}><planeGeometry args={[LANE * 3.3, -FAR + 12]} /><meshLambertMaterial color={theme.road} /></mesh>
          {[-0.5, 0.5].map((l) => Array.from({ length: 10 }, (_, k) => (
            <mesh key={`${l}.${k}`} ref={(m) => void (stripes.current[p * 20 + (l > 0 ? 10 : 0) + k] = m)} position={[trackX(p) + l * LANE, 0.01, FAR + (k * -FAR) / 10]} rotation-x={-Math.PI / 2}>
              <planeGeometry args={[0.12, 2.4]} /><meshBasicMaterial color="#fafafa" transparent opacity={0.6} />
            </mesh>
          )))}
          <primitive object={runners[p].holder} />
        </group>
      ))}
      <primitive object={world.root} />
      {bursts.node}
    </>
  );
}

export default (props: GameProps) => (
  <Stage n={props.n} camera={{ position: [0, 4.4, 8.5], fov: 55, near: 0.1, far: 140 }}>{(hud) => <Scene {...props} hud={hud} />}</Stage>
);
