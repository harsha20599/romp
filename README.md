# Romp

**Your body is the controller.** 17 camera-tracked motion games (fitness, rhythm, pose and arcade) that run in Chrome on
an old tablet or phone and play on your TV over a USB-C → HDMI cable. No console, no subscription, no app store.

## Play it

Romp is a static website: build it once, open it in Chrome on the tablet, allow the camera. The camera needs **HTTPS**
(or `localhost`), which is why the easiest way is a free Vercel deploy:

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fharsha20599%2Fromp&project-name=romp&repository-name=romp)

1. Click the button, sign in with GitHub, press **Deploy**. About two minutes later you get a link like `https://romp-xyz.vercel.app`.
2. Open that link in **Chrome** on your tablet, allow the camera, then Chrome menu → **Add to Home screen**.

**Or build it yourself** (Node.js 22+ and Git):

```bash
git clone https://github.com/harsha20599/romp.git
cd romp
npm install
npm run build
npm run play        # serves dist/ on your network, port 4173
```

The tablet opens `http://<your-computer's-ip>:4173`. That is plain http, so Chrome blocks the camera until you open
`chrome://flags/#unsafely-treat-insecure-origin-as-secure` on the tablet, add that address, set it to Enabled and relaunch.
Any static host with HTTPS works as well (Netlify, Cloudflare Pages, GitHub Pages at a domain root): publish `dist/`.

Then: tablet under the TV, landscape, front camera on the room; TV picture mode **Game** and motion smoothing off; stand
back till your whole body is in view; point and close your fist to press. Home → Tracking → **Measure** once per setup.

## Developing

```bash
npm run dev      # http://localhost:5180 — add ?sim to play with the mouse, no camera
npm run check    # input-maths + streak asserts, then tsc
```

How I serve it at home (both serve the same `dist/`; run `npm run build` to publish a change, nothing restarts):

- **Tailscale HTTPS** — `tailscale serve --https 8445` proxies to `node serve.mjs 5192` on loopback: the same `dist/`,
  tailnet-only, plus `POST /report` so the tablet's own measurements land in `reports/`. The camera just works; the
  tablet needs the Tailscale app, signed in.
- **LAN http on :5180** — a user service. Plain http, so the tablet needs the Chrome flag above.

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
- How players are shown in full-body games (Tracking → "Your look"): **Shadow** (default) — `bodyLook`: a halftone figure of
  light grown around 17 skeleton joints in one fragment shader, hand and foot tips glowing; no person mask, so it is free
  for the tracker and identical for two players. **Camera** — the worker composes each pose frame and the model's own person
  mask into a cut-out (`compose` in pose.worker.ts, window in `src/cut.ts`), one player only, and it switches back to Shadow
  if the tracker drops under ~17 fps. **Mirror** — the game over the whole camera picture, dimmed and duotoned, players
  spotlit; `figure().at` follows them round the room. Hand games show hands only: beads of light with comet trails.
  `backdrop(scene, place)` paints each flat-stage game's world in one fragment shader.
- Two players = two trackers (pose.ts `pairUp`): the first worker keeps the GPU and takes seat 0's side of the picture, a
  second worker runs the lite model on the CPU for seat 1, each on its own copy of the camera track, sides overlapping
  in the middle. One model doing two people per frame measured 105 ms a frame on the Tab S7 (8 readings a second).
- `src/reps.ts` — exercise detectors over the rig (running steps + cadence, jumping jacks incl. arms-only, woodchops, squat
  depth), each checked against synthetic movement in `check.ts`. The exercise games (Sprint, Jack Attack, Forge,
  Lumberjack) are built on them, and all enforce their own rests.
- Pulse (the rhythm game): `src/song.ts` holds the songs as data and a small synthesiser that plays them (kick, snare,
  hats, bass, pad, arp, lead; sidechain pump, tempo delay, generated reverb) — original music, nothing downloaded or
  licensed; `src/chart.ts` builds each stage's chart from the song's own events (checked for playability in `check.ts`);
  `src/games/pulse.ts` is the game; the `tunnel` backdrop is driven by the beat. A new song = one entry in `SONGS` + a mode row.
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

## Finding 3D models

`node tools/models.mjs` is how models are found and brought in — by a person or by an agent. `search "<thing>"` queries
Poly Pizza (low-poly; hosts Quaternius' and Google Poly's libraries model by model), Kenney's CC0 packs (the house
style — prefer them), Poly Haven and Sketchfab, ranks them for this project (CC0 first, Kenney/Quaternius first, fewer
triangles first, fetchable first) and writes a numbered **contact sheet** PNG of thumbnails to
`~/.cache/wt-scratch/romp-models/` — look at it before choosing. `pack <kenney-pack>` lists what is inside a Kenney pack;
`get <ref> --as <dir/name>` downloads, vets (triangles, size, materials, external textures), copies into
`public/assets/`, records source/author/licence/hash in `public/assets/models.json` and adds the credit line to
`public/assets/CREDITS.md`. Only CC0 and CC-BY are let in. For portals that block plain requests, `MODELS_FETCH=webfetch`
reads pages through Watchtower's browser layer (`~/watchtower/bin/webfetch`: real Chromium, stealth). Two import rules keep
kits looking like one world (both in `engine.ts`): models are made matte on load, and off-palette kits are repainted by
material name (`REPAINT`).

## Assets and sound

All models, sound effects and the announcer are CC0 — see `CREDITS.md`. Sounds are grouped into families by file
name in `public/assets/audio.json`; after adding `.ogg` files, rebuild it:

```bash
node -e "const fs=require('fs'),o={};for(const d of['sfx','voice','jingles'])for(const f of fs.readdirSync('public/assets/'+d).filter(f=>f.endsWith('.ogg')).sort()){const k=d==='sfx'?f.replace(/\.ogg$/,'').replace(/_?\d+$/,''):d==='voice'?'say_'+f.replace(/\.ogg$/,''):f.includes('HIT')?'jingle_win':'jingle_level';(o[k]??=[]).push(d+'/'+f)}fs.writeFileSync('public/assets/audio.json',JSON.stringify(o))"
```
