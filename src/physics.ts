// Rapier, loaded only by the games that need rigid bodies (Goalie, Smash). Fixed 60Hz steps, whatever the display does.
import RAPIER from '@dimforge/rapier3d-compat';

let ready: Promise<void> | undefined;
export async function physics(gravity: number) {
  await (ready ??= RAPIER.init());
  const world = new RAPIER.World({ x: 0, y: gravity, z: 0 });
  world.timestep = 1 / 60;
  let owed = 0;
  return {
    RAPIER, world,
    step(dt: number) {
      owed += dt;
      let steps = 0;
      while (owed >= 1 / 60 && steps++ < 4) { world.step(); owed -= 1 / 60; }
      if (steps > 4) owed = 0; // fell behind (a stall, a background tab): drop the backlog rather than fast-forward the world
    },
  };
}
