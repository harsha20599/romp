# Romp

Camera-tracked fitness games on the TV, run from a Galaxy Tab S7 over HDMI.
Plan, state and log live on the Watchtower board: `~/watchtower/projects/romp/`.

```bash
npm run dev      # http://localhost:5180 — add ?sim to play with the mouse, no camera
npm run check    # input-maths + streak asserts, then tsc
```

Served to the LAN by `systemctl --user status romp` → **http://192.168.0.100:5180** (static `dist/`;
run `npm run build` to publish a change — no restart needed). The tablet is only a browser.

Chrome blocks the camera on plain-http LAN addresses, so once, on the tablet: open
`chrome://flags/#unsafely-treat-insecure-origin-as-secure`, add `http://192.168.0.100:5180`,
set it to Enabled, relaunch. Tuning knobs: `tuning` in `src/pose.ts`.
