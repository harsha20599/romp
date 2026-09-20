// Exercise, recognised. Small detectors over a player's rig (pose.ts: every landmark in shoulder-widths from the middle
// of the shoulders, y up) or hands. Each is a closure with a little memory, fed once a frame, and is checked against
// synthetic movement in check.ts — a rep that does not count is the most annoying bug an exercise game can have,
// so every detector is forgiving about form and strict only about the thing that makes the rep a rep.
type Rig = number[][];
const seen = (rig: Rig, ...joints: number[]) => joints.every((j) => rig[j] && rig[j][2] > 0.4);

// Running on the spot. A step is a knee coming up: the drop from hip to knee shrinks well below that leg's standing
// value (learned as it goes, so tall, short, near and far all work). Returns steps taken this frame and the cadence.
export function stepper() {
  const stand = [0, 0], up = [false, false];
  let last = -1, cadence = 0;
  return (rig: Rig, t: number) => {
    let steps = 0;
    for (const h of [0, 1]) {
      if (!seen(rig, 23 + h, 25 + h)) continue;
      const drop = rig[23 + h][1] - rig[25 + h][1];
      stand[h] = Math.max(drop, stand[h] * 0.9995); // the longest it has been lately = standing on it
      if (!up[h] && drop < stand[h] * 0.8) { up[h] = true; steps++; } else if (up[h] && drop > stand[h] * 0.9) up[h] = false;
    }
    if (steps) { if (last >= 0) cadence += (Math.min(6, 1 / Math.max(0.12, t - last)) - cadence) * 0.35; last = t; }
    else if (last >= 0 && t - last > 0.7) cadence *= 0.9; // stopped: the pace bleeds away
    return { steps, cadence };
  };
}

// Jumping jacks. The rep is the arms: both wrists from below the shoulders to above the head and back. Feet apart at
// the top makes it a full jack (`wide`); arms alone still counts, so stepping jacks — no jumping — are a fair way to play.
export function jacker() {
  let open = false;
  return (rig: Rig) => {
    if (!seen(rig, 15, 16)) return { rep: false, wide: false, open };
    const high = rig[15][1] > 0.75 && rig[16][1] > 0.75, low = rig[15][1] < 0.1 && rig[16][1] < 0.1;
    const wide = seen(rig, 27, 28, 23, 24) && Math.abs(rig[27][0] - rig[28][0]) > Math.abs(rig[23][0] - rig[24][0]) * 2.1;
    if (!open && high) { open = true; return { rep: true, wide, open }; }
    if (open && low) open = false;
    return { rep: false, wide, open };
  };
}

// A woodchop: the leading hand comes from high on one side to low on the other, fast. Works on zone hands
// (pose.ts: -1..1 across the player's reach). dir: +1 = chopped down toward screen-right.
export function chopper() {
  const from = [{ x: 0, y: 0, t: -9 }, { x: 0, y: 0, t: -9 }];
  return (hands: { x: number; y: number; vy: number; seen: boolean }[], t: number) => {
    for (const [h, hand] of hands.entries()) {
      if (!hand.seen) continue;
      if (hand.y > 0.35) from[h] = { x: hand.x, y: hand.y, t }; // wound up: remember where
      else if (hand.y < -0.2 && t - from[h].t < 0.9 && Math.abs(hand.x - from[h].x) > 0.45) {
        const dir = Math.sign(hand.x - from[h].x), power = Math.min(1, Math.hypot(hand.x - from[h].x, hand.y - from[h].y) / Math.max(0.15, t - from[h].t) / 6);
        from[h].t = -9;
        return { dir, power };
      }
    }
    return null;
  };
}

// How deep a squat is, 0 (standing) to 1 (thighs level), from the player's lift (pose.ts), and how still it is held.
export const squatDepth = (lift: number) => Math.max(0, Math.min(1, (-lift - 0.3) / 0.55));
