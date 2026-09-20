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
