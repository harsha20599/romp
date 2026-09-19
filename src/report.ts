// Field numbers from the real tablet, posted back to the build machine. Tuning used to mean asking the player to read
// figures off the screen; now the device just says what it measured. Only the build machine's server (serve.mjs)
// listens on /report — anywhere else the POST fails and nothing happens.
import { perf, track, tuning } from './pose.ts';

export function report(kind: string, data: unknown = {}) {
  const round = (o: object) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, typeof v === 'number' ? +v.toFixed(1) : v]));
  const body = JSON.stringify({ kind, at: new Date().toISOString(), ua: navigator.userAgent, screen: [innerWidth, innerHeight, devicePixelRatio], tracker: { ...round(perf), ...round(track), model: tuning.model, sharp: tuning.sharp, fastCam: tuning.fastCam, direct: tuning.direct }, data });
  try { void fetch('/report', { method: 'POST', body, keepalive: body.length < 60000 }).catch(() => {}); } catch { /* offline: nothing to do */ }
}
