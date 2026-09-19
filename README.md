# Romp

Camera-tracked fitness games on the TV, run from a Galaxy Tab S7 over HDMI.
Plan, state and log live on the Watchtower board: `~/watchtower/projects/romp/`.

```bash
npm run dev      # http://localhost:5180 — add ?sim to play with the mouse, no camera
npm run check    # input-maths + streak asserts, then tsc
```

Two ways in, both serving the same `dist/` — run `npm run build` to publish a change, nothing restarts:

- **Tailscale (preferred): https://mayjuneserver.taild23e3.ts.net:8445** — `tailscale serve` hands out the folder over real HTTPS,
  tailnet-only. The camera just works. The tablet needs the Tailscale app, signed in.
  Off switch: `tailscale serve --https=8445 off`.
- **LAN: http://192.168.0.100:5180** — `systemctl --user status romp`. Plain http, so Chrome blocks the
  camera until, once on the tablet, `chrome://flags/#unsafely-treat-insecure-origin-as-secure` lists
  that address and is Enabled.

Tuning knobs: `tuning` in `src/pose.ts`.
