# Romp

Camera-tracked fitness games on the TV, run from a Galaxy Tab S7 over HDMI.
Plan, state and log live on the Watchtower board: `~/watchtower/projects/romp/`.

```bash
npm run dev      # http://localhost:5180 — add ?sim to play with the mouse, no camera
npm run check    # input-maths + streak asserts, then tsc
```

On the tablet: `adb reverse tcp:5180 tcp:5180`, open `http://localhost:5180` in Chrome
(localhost is what lets the camera work without HTTPS). Tuning knobs: `tuning` in `src/pose.ts`.
