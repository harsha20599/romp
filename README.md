# Romp

Camera-tracked fitness games on the TV, run from a Galaxy Tab S7 over HDMI.
Plan, state and log live on the Watchtower board: `~/watchtower/projects/romp/`.

```bash
npm run dev      # http://localhost:5180 — add ?sim to play with the mouse, no camera
npm run check    # input-maths + streak asserts, then tsc
```

Two ways in, both serving the same `dist/` — run `npm run build` to publish a change, nothing restarts:

- **Tailscale (preferred): https://mayjuneserver.taild23e3.ts.net:8445** — `tailscale serve --https 8445` proxies to
  `romp-live.service` (`node serve.mjs 5192`, loopback): the same `dist/` over real HTTPS, tailnet-only, plus `POST /report`
  so the tablet's own measurements land in `reports/`. The camera just works. The tablet needs the Tailscale app, signed in.
  Off switch: `tailscale serve --https=8445 off`.
- **LAN: http://192.168.0.100:5180** — `systemctl --user status romp`. Plain http, so Chrome blocks the
  camera until, once on the tablet, `chrome://flags/#unsafely-treat-insecure-origin-as-secure` lists
  that address and is Enabled.

Tuning knobs: `tuning` in `src/pose.ts`.

**Set-up that matters more than any code** (measured 2026-09-20): the TV must be in **Game mode** for the tablet's HDMI
input, motion smoothing off — outside it the TV alone added ~100 ms. Use **DeX**, not mirroring. Then run
Home → Tracking → Delay → **Measure** once per screen/cable change; prediction uses the stored figure. `/clock.html`
(photograph tablet and TV together) and `/bench.html` (camera, model and latency on the device) are there for the next hunt;
`tools/tablet-diag.sh` reads the tablet over adb.

## How it is built

React draws the menus and the HUD (plain DOM). Everything on the stage is the **PlayCanvas engine** used as a code
library — no editor, only the parts imported in `src/engine.ts` (the rest is tree-shaken). One app and one WebGL2 canvas
live for the whole session; a round builds its scene under a root entity and destroys it at the end, so compiled shaders
survive from round to round and the context is never re-created.

- `src/engine.ts` — the app, materials (`flat`, `lit`), shapes, GLB loading (`fitted`), instanced dots, ribbons, the
  clip-plane material Slice cuts fruit with, pre-round warm-up, frame pacing, and the automatic "lean" step-down.
- `src/kit.ts` — what games share: round clock, hands, bursts, hit-testing, sound. `src/stage.tsx` — the React shell.
- `src/games/*.ts` — one module per game: `export default (game) => tick`, optional `export const view` for a
  perspective camera. **A new game = one module + one row in `GAMES` (main.tsx) + its star goals (meta.ts).**
- The depth kit (kit.ts + stage.tsx): game **modes** and **Team/Versus** chosen on the briefing screen (scores of different
  variants are kept apart: `Session.variant`), `hud.banner` / `hud.pop`, `round(..., extra)` for finales and endless rounds,
  `bestLine`, result notes, and `figure()` — the player's whole body on stage with touch pads (hands, head, elbows, knees,
  feet) from `players[p].rig`. Slice is the reference for how much a game should have in it; Leaks and Keepy-Uppy for full-body play.
- How players are shown (Tracking → "Your look"): **Camera** — the worker composes each pose frame and the model's own
  person mask into a per-player cut-out (`compose` in pose.worker.ts, window in `src/cut.ts`), drawn by `cutoutLook` with a
  graded picture, backlight, outline and glow; **Shadow** — the same shape in halftone dots; **Mirror** — the game over the
  whole camera picture, dimmed and duotoned, players spotlit, and `figure().at` follows them round the room (no mask);
  **Character** — a drawn figure on the skeleton (also the fallback, and what `?sim` shows). Masks are only computed while a
  full-body game is on screen, and switch themselves off if the tracker drops under ~17 fps. Hand games show hands only:
  beads of light with comet trails (`glowLook`, `trailLook`). `backdrop(scene, place)` paints each flat-stage game's world
  in one fragment shader (dojo, sky, deep, gym, synth, disco, studio, space, tiles).
- `src/physics.ts` — Rapier, fetched only by the games that use it (Goalie, Smash).

The menus load ~80 KB of script (gzipped); the engine (~325 KB) and a game's code are fetched on its briefing screen.
`serve.mjs` sends text-like files brotli-compressed and revalidates the rest by ETag, so a repeat visit re-downloads nothing.

## Test builds and field numbers

A test build runs beside the live one without touching it: a git worktree on its own branch, built into its own
`dist/`, served by `node serve.mjs 5191` (`romp-next.service`) and fronted by `tailscale serve --https 8446`. A different
port is a different origin, so the test build has its own saved stats — the live ones are safe.

`serve.mjs` also takes `POST /report`: the app posts what it measured — tracker speed 15 s after start, frame pacing
after every round (`p50/p95/p99/worst`, shaders built mid-round), and, only when "Record 12 s" is pressed on the Tracking
screen, a tape of raw landmarks for filter tuning. They land in `reports/` (git-ignored). Never camera pictures. On the
live static servers the POST simply fails and nothing is sent.

## Assets and sound

All models, sound effects and the announcer are CC0 — see `CREDITS.md`. Sounds are grouped into families by file
name in `public/assets/audio.json`; after adding `.ogg` files, rebuild it:

```bash
node -e "const fs=require('fs'),o={};for(const d of['sfx','voice','jingles'])for(const f of fs.readdirSync('public/assets/'+d).filter(f=>f.endsWith('.ogg')).sort()){const k=d==='sfx'?f.replace(/\.ogg$/,'').replace(/_?\d+$/,''):d==='voice'?'say_'+f.replace(/\.ogg$/,''):f.includes('HIT')?'jingle_win':'jingle_level';(o[k]??=[]).push(d+'/'+f)}fs.writeFileSync('public/assets/audio.json',JSON.stringify(o))"
```
