// The few things the menus and the renderer both need, kept apart so the menus never import the renderer.
export const PLAYER_COLORS = ['#818cf8', '#34d399'];

// Bloom is the one effect that costs real GPU time next to the pose model; the home screen can switch it off.
export const effects = { on: (() => { try { return localStorage.getItem('romp.fx') !== 'off'; } catch { return true; } })() };

// Frame pacing, measured where it matters — on the device, during a real round. Read out by the shell after each game.
// `lean`: the renderer gave up bloom and extra resolution because the device could not hold its frame rate.
export const pace = { dts: [] as number[], shaders: 0, late: 0, lean: false };
export function paceSummary() {
  const d = pace.dts.sort((a, b) => a - b), at = (q: number) => +(d[Math.floor((d.length - 1) * q)] ?? 0).toFixed(1);
  const out = { frames: d.length, p50: at(0.5), p95: at(0.95), p99: at(0.99), worst: at(1), over34ms: d.filter((v) => v > 34).length, shadersBuiltMidRound: pace.late, lean: pace.lean, renderer: 'playcanvas' };
  pace.dts = [];
  return out;
}
