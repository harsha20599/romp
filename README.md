# Romp Demo

**Your body is the controller.** The free public Romp demo includes two camera-controlled games:

- **Run** — lean, jump, and duck through a three-lane endless runner.
- **Slice** — swipe through fruit and dodge bombs, with Arcade, Classic, and Zen modes.

Play solo, together, or take turns. Stars, stages, activity points, daily quests, and profiles are saved on your device.

This repository is the basic demo edition. It uses standard browser-managed camera capture and smoothed body tracking,
without predictive hand positioning, automatic camera exposure tuning, or screen-delay calibration. Tracking quality
and responsiveness depend on your camera, lighting, browser, and display. Development of the full commercial Romp
product is separate from this repository.

## Play it

Romp is a static website. Open it in Chrome on an Android tablet, allow the camera, and optionally connect the tablet
to your TV over USB-C → HDMI. The camera requires **HTTPS** or `localhost`.

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fharsha20599%2Fromp&project-name=romp-demo&repository-name=romp-demo)

Deploy the repository, open the resulting HTTPS link on your tablet, and use Chrome's **Add to Home screen** option.
Stand back until your whole body is visible. Point at a button and close your fist to press; holding still is also
available under **Tracking → Press with**. Touch, mouse, and keyboard controls remain available.

Use landscape orientation with the camera facing the room. On a TV, enable Game mode and turn motion smoothing off.
Use a well-lit room so the camera can follow your hands.

## Build and develop

Requires Node.js 22+ and Git.

```bash
git clone https://github.com/harsha20599/romp.git
cd romp
npm install
npm run dev       # http://localhost:5180; add ?sim for mouse/keyboard play without a camera
npm run check     # input, progression, and demo checks, then TypeScript
npm run build     # creates dist/
npm run play      # serves dist/ on your network, port 4173
```

Any static host with HTTPS can serve `dist/`, including Vercel, Netlify, Cloudflare Pages, or GitHub Pages at a domain
root. A plain HTTP LAN address will not have camera access unless the browser explicitly trusts that origin;
prefer HTTPS for playing on another device.

In `?sim` mode, move the mouse to control a hand, use the arrow keys to lean/jump/duck, A/D to raise hands, and F to
close a fist. Click or tap during a round to pause; Escape also pauses.

## Code map

- `src/main.tsx` — menus, the two-game catalog, profiles, and results.
- `src/games/run.ts`, `src/games/slice.ts` — the demo games.
- `src/pose.ts`, `src/pose.worker.ts` — camera input and MediaPipe tracking, including two-player support.
- `src/engine.ts` — the persistent PlayCanvas renderer and shared scene tools.
- `src/kit.ts`, `src/stage.tsx` — round timing, hands, hit testing, and the game shell.
- `src/meta.ts`, `src/stats.ts` — progression and local saved sessions. Existing saves are preserved.
- `src/audio.ts` — sound effects and procedural background music.

React draws the menus and HUD; PlayCanvas draws the games on one persistent WebGL canvas. Each game's code loads on
demand. Camera processing stays on the device, and this demo does not upload tracking recordings or measurements.

## Assets

Third-party assets retain their own licenses. See `CREDITS.md` and `public/assets/CREDITS.md` for attribution.
`tools/models.mjs` can search and import CC0/CC-BY models with source and license records.

## License

**Free for personal use.** Play it, change it, build on it, and tinker however you like.
**Sharing publicly** (a fork, a hosted copy, a video, or a post) needs a visible credit to **@yem.cube on Instagram**.
**Commercial use** needs written approval first. Ask [@yem.cube on Instagram](https://www.instagram.com/yem.cube).
This covers every version, including older Romp releases. Third-party parts keep their own licenses.
Full terms: [LICENSE](LICENSE).
