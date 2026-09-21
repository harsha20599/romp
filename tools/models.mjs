#!/usr/bin/env node
// models — find, look at, vet and bring in free 3D models for Romp.  (No dependencies; Node 18+.)
//
//   node tools/models.mjs search "anvil" [--n 12]      search the portals, print a ranked table, and write a CONTACT SHEET
//                                                      (a PNG of thumbnails, numbered) — open it and look before choosing
//   node tools/models.mjs packs [query]                Kenney's 3D packs (all CC0), optionally filtered by name
//   node tools/models.mjs pack <kenney-pack> [filter]  download a Kenney pack (cached) and list the GLBs inside it
//   node tools/models.mjs get <ref> --as <dir/name>    bring one model into public/assets/<dir>/<name>.glb, vet it, credit it
//        ref = polypizza:<id> | kenney:<pack>/<file.glb> | a direct .glb URL (then add --licence CC0|CC-BY --author "…")
//   node tools/models.mjs inspect <file.glb>           triangles, materials, textures, animations, warnings
//
// Portals: Poly Pizza (low-poly, CC0 and CC-BY, hosts Quaternius' and Google Poly's libraries model by model; search page
// and model pages are scraped — its API needs a key), Kenney (CC0 packs: the house style — prefer it), Poly Haven (CC0,
// realistic: API), Sketchfab (API search of downloadable CC0/CC-BY models; downloading needs an account token, so those
// are listed with their page link only). For a portal that blocks plain requests, fetch through Watchtower's browser layer:
// set MODELS_FETCH=webfetch and pages are read with `~/watchtower/bin/webfetch html <url>` (real Chromium, stealth).
//
// Rules the tool enforces: only CC0 and CC-BY come in; CC-BY gets an attribution line in public/assets/CREDITS.md (CC0 is
// credited too, as a courtesy); every file is recorded in public/assets/models.json with its source, author, licence and hash.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, copyFileSync, readdirSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';
import { homedir } from 'node:os';

const ROOT = join(dirname(new URL(import.meta.url).pathname), '..'), ASSETS = join(ROOT, 'public/assets'), CACHE = join(homedir(), '.cache/wt-scratch/romp-models');
const UA = { 'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) romp-models/1.0' };
const args = process.argv.slice(2), flag = (name, fallback) => { const i = args.indexOf('--' + name); return i < 0 ? fallback : args[i + 1]; };
mkdirSync(CACHE, { recursive: true });

async function page(url) {
  if (process.env.MODELS_FETCH === 'webfetch') return execFileSync(join(homedir(), 'watchtower/bin/webfetch'), ['html', url], { encoding: 'utf8', maxBuffer: 64e6 });
  const r = await fetch(url, { headers: UA }); if (!r.ok) throw new Error(`${r.status} ${url}`); return r.text();
}
const json = async (url) => (await fetch(url, { headers: UA })).json();
async function download(url, to) { if (existsSync(to)) return to; const r = await fetch(url, { headers: UA }); if (!r.ok) throw new Error(`${r.status} ${url}`); mkdirSync(dirname(to), { recursive: true }); writeFileSync(to, Buffer.from(await r.arrayBuffer())); return to; }
const licenceOf = (text) => (/CC0|Public Domain/i.test(text) ? 'CC0' : /CC[- ]BY(?![- ](NC|ND|SA))/i.test(text) ? 'CC-BY' : /CC[- ]BY[- ]SA/i.test(text) ? 'CC-BY-SA' : 'other');

// ---- portals ---------------------------------------------------------------------------------------------------------
async function polypizza(q, n) {
  const ids = [...new Set([...(await page(`https://poly.pizza/search/${encodeURIComponent(q)}`)).matchAll(/\/m\/([A-Za-z0-9_-]{6,14})/g)].map((m) => m[1]))].slice(0, n);
  return (await Promise.all(ids.map(async (id) => {
    try {
      const html = await page(`https://poly.pizza/m/${id}`), og = (html.match(/property="og:title" content="([^"]+)"/) ?? [])[1] ?? id, title = og.replace(/ - Free Model.*/i, '').trim();
      const author = (html.match(/"Creator":\{"Username":"([^"]+)"/) ?? og.match(/ By (.+)$/i) ?? [])[1] ?? '?', glb = (html.match(/https:\/\/static\.poly\.pizza\/[A-Za-z0-9_-]+\.glb/) ?? [])[0], thumb = (html.match(/property="og:image" content="([^"]+)"/) ?? [])[1];
      const tris = Number((html.match(/"Tris":(\d+)/) ?? [])[1]) || null;
      return glb ? { ref: `polypizza:${id}`, source: 'Poly Pizza', title, author, licence: licenceOf(html), tris, url: `https://poly.pizza/m/${id}`, glb, thumb } : null;
    } catch { return null; }
  }))).filter(Boolean);
}
async function sketchfab(q, n) {
  const out = [];
  for (const licence of ['cc0', 'by']) {
    const d = await json(`https://api.sketchfab.com/v3/search?type=models&q=${encodeURIComponent(q + ' low poly')}&downloadable=true&license=${licence}&count=${Math.ceil(n / 2)}&sort_by=-likeCount`).catch(() => ({}));
    for (const r of d.results ?? []) out.push({ ref: `sketchfab:${r.uid}`, source: 'Sketchfab', title: r.name, author: r.user?.displayName ?? '?', licence: licence === 'cc0' ? 'CC0' : 'CC-BY', tris: r.faceCount ?? null, url: r.viewerUrl, glb: null, thumb: (r.thumbnails?.images ?? []).sort((a, b) => Math.abs(a.width - 256) - Math.abs(b.width - 256))[0]?.url });
  }
  return out;
}
async function polyhaven(q, n) {
  const all = await json('https://api.polyhaven.com/assets?t=models').catch(() => ({})), words = q.toLowerCase().split(/\s+/);
  return Object.entries(all).filter(([id, a]) => words.every((w) => `${id} ${a.name} ${(a.tags ?? []).join(' ')} ${(a.categories ?? []).join(' ')}`.toLowerCase().includes(w))).slice(0, n)
    .map(([id, a]) => ({ ref: `polyhaven:${id}`, source: 'Poly Haven', title: a.name, author: Object.keys(a.authors ?? {}).join(', '), licence: 'CC0', tris: a.polycount ?? null, url: `https://polyhaven.com/a/${id}`, glb: null, thumb: `https://cdn.polyhaven.com/asset_img/thumbs/${id}.png?height=256` }));
}
async function kenneyPacks(filter = '') {
  const packs = new Map();
  for (let p = 1; p <= 8; p++) { const html = await page(`https://kenney.nl/assets/category:3D${p > 1 ? `/page:${p}` : ''}`).catch(() => ''); const found = [...html.matchAll(/kenney\.nl\/assets\/([a-z0-9-]+)"[^>]*>\s*(?:<img[^>]*src="([^"]+)")?/g)]; if (!found.length) break; for (const m of found) if (!/^(category|page|tag)/.test(m[1])) packs.set(m[1], packs.get(m[1]) ?? m[2] ?? null); }
  return [...packs].filter(([id]) => id.includes(filter.toLowerCase().replace(/\s+/g, '-'))).map(([id, thumb]) => ({ ref: `kenney:${id}`, source: 'Kenney', title: id, author: 'Kenney', licence: 'CC0', tris: null, url: `https://kenney.nl/assets/${id}`, glb: null, thumb }));
}
async function kenneyPack(id) {
  const dir = join(CACHE, 'kenney', id);
  if (!existsSync(dir)) { const zip = ((await page(`https://kenney.nl/assets/${id}`)).match(/https:\/\/kenney\.nl\/media\/pages\/assets\/[^"]+\.zip/) ?? [])[0]; if (!zip) throw new Error(`no download found for Kenney pack "${id}"`); await download(zip, dir + '.zip'); mkdirSync(dir, { recursive: true }); execFileSync('unzip', ['-qo', dir + '.zip', '-d', dir]); }
  const walk = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : e.name.endsWith('.glb') ? [join(d, e.name)] : []));
  return walk(dir);
}

// ---- looking --------------------------------------------------------------------------------------------------------
async function sheet(rows, name) { // a numbered page of thumbnails, screenshotted: what the agent (or a person) actually looks at
  const out = join(CACHE, `${name.replace(/\W+/g, '-')}.png`), cells = rows.map((r, i) => `<div><img src="${r.thumb ?? ''}"><b>${i + 1}. ${r.title.slice(0, 34)}</b><span>${r.source} · ${r.licence}${r.tris ? ` · ${r.tris} tris` : ''}</span></div>`).join('');
  const html = `<body style="margin:0;background:#16122e;color:#fff;font:14px system-ui;display:grid;grid-template-columns:repeat(6,1fr);gap:8px;padding:8px">${cells}<style>div{background:#241d4a;border-radius:8px;padding:6px;display:flex;flex-direction:column;gap:2px}img{width:100%;aspect-ratio:1;object-fit:contain;background:#0f0b22;border-radius:6px}span{opacity:.7;font-size:12px}</style>`;
  try { const { chromium } = await import(join(homedir(), 'watchtower/node_modules/playwright/index.mjs')); const b = await chromium.launch(), p = await b.newPage({ viewport: { width: 1320, height: 240 * Math.ceil(rows.length / 6) + 16 } }); await p.setContent(html, { waitUntil: 'networkidle' }).catch(() => {}); await p.screenshot({ path: out }); await b.close(); return out; } catch (e) { return `(no contact sheet: ${String(e).slice(0, 80)})`; }
}
function inspect(file) {
  const b = readFileSync(file), j = JSON.parse(b.subarray(20, 20 + b.readUInt32LE(12)).toString());
  const tris = (j.meshes ?? []).flatMap((m) => m.primitives).reduce((a, p) => a + (j.accessors[p.indices ?? p.attributes.POSITION].count / 3), 0);
  const mats = (j.materials ?? []).map((m) => `${m.name ?? '?'}${m.pbrMetallicRoughness?.metallicFactor === undefined || m.pbrMetallicRoughness.metallicFactor > 0.5 ? ' (metallic: the loader makes it matte)' : ''}`), external = (j.images ?? []).filter((i) => i.uri && !i.uri.startsWith('data:')).map((i) => i.uri);
  const warn = [tris > 20000 ? `${Math.round(tris)} triangles is heavy for a phone` : '', b.length > 1.5e6 ? `${(b.length / 1e6).toFixed(1)} MB` : '', external.length ? `needs external textures beside it: ${external.join(', ')}` : '', (j.extensionsRequired ?? []).length ? `requires ${j.extensionsRequired.join(', ')}` : ''].filter(Boolean);
  return { bytes: b.length, triangles: Math.round(tris), meshes: (j.meshes ?? []).length, materials: mats, textures: (j.images ?? []).length, external, animations: (j.animations ?? []).map((a) => a.name), warn };
}

// ---- commands -------------------------------------------------------------------------------------------------------
const [cmd, what] = args;
if (cmd === 'search') {
  const n = Number(flag('n', 12)), found = (await Promise.all([polypizza(what, n), sketchfab(what, 6), polyhaven(what, 4), kenneyPacks(what.split(' ')[0])])).flat().filter((r) => r.licence === 'CC0' || r.licence === 'CC-BY');
  // House style first: CC0 before CC-BY, Kenney/Quaternius before anyone, fewer triangles before more, things we can fetch before links.
  const score = (r) => (r.licence === 'CC0' ? 0 : 3) + (/kenney|quaternius/i.test(r.author + r.source) ? 0 : 2) + (r.glb || r.source === 'Kenney' ? 0 : 2) + (r.tris ? Math.min(3, r.tris / 8000) : 1);
  found.sort((a, b) => score(a) - score(b));
  found.forEach((r, i) => console.log(`${String(i + 1).padStart(2)}. ${r.ref.padEnd(26)} ${r.licence.padEnd(6)} ${String(r.tris ?? '?').padStart(6)} tris  ${r.title.slice(0, 38).padEnd(38)} ${r.author.slice(0, 18).padEnd(18)} ${r.url}`));
  writeFileSync(join(CACHE, 'last-search.json'), JSON.stringify(found, null, 1));
  console.log(`\ncontact sheet: ${await sheet(found, what)}\n(get one with: node tools/models.mjs get <ref> --as <dir/name>)`);
} else if (cmd === 'packs') { for (const p of await kenneyPacks(what ?? '')) console.log(p.ref.padEnd(40), p.url); }
else if (cmd === 'pack') { for (const f of (await kenneyPack(what)).filter((f) => !args[2] || basename(f).includes(args[2]))) console.log(`kenney:${what}/${basename(f)}`); }
else if (cmd === 'inspect') console.log(inspect(what));
else if (cmd === 'get') {
  const as = flag('as'); if (!as) throw new Error('say where it goes: --as <dir/name>');
  let src, meta;
  if (what.startsWith('polypizza:')) { const id = what.slice(10), html = await page(`https://poly.pizza/m/${id}`), og = (html.match(/property="og:title" content="([^"]+)"/) ?? [])[1] ?? id; meta = { source: 'Poly Pizza', url: `https://poly.pizza/m/${id}`, title: og.replace(/ - Free Model.*/i, '').trim(), author: (html.match(/"Creator":\{"Username":"([^"]+)"/) ?? [])[1] ?? '?', licence: licenceOf(html) }; src = await download((html.match(/https:\/\/static\.poly\.pizza\/[A-Za-z0-9_-]+\.glb/) ?? [])[0], join(CACHE, 'polypizza', id + '.glb')); }
  else if (what.startsWith('kenney:')) { const [pack, file] = what.slice(7).split('/'); src = (await kenneyPack(pack)).find((f) => basename(f) === file); if (!src) throw new Error(`${file} is not in ${pack}`); meta = { source: 'Kenney', url: `https://kenney.nl/assets/${pack}`, title: `${pack} / ${file}`, author: 'Kenney', licence: 'CC0' }; }
  else { meta = { source: new URL(what).host, url: what, title: basename(what), author: flag('author', '?'), licence: flag('licence', 'other') }; if (meta.licence !== 'CC0' && meta.licence !== 'CC-BY') throw new Error(`licence is "${meta.licence}" — only CC0 and CC-BY come into this project`); src = await download(what, join(CACHE, 'url', createHash('sha1').update(what).digest('hex') + '.glb')); }
  if (meta.licence !== 'CC0' && meta.licence !== 'CC-BY') throw new Error(`licence is "${meta.licence}" — only CC0 and CC-BY come into this project`);
  const to = join(ASSETS, as + '.glb'), info = inspect(src); mkdirSync(dirname(to), { recursive: true }); copyFileSync(src, to);
  for (const uri of info.external) { const from = join(dirname(src), uri); if (existsSync(from)) { mkdirSync(dirname(join(dirname(to), uri)), { recursive: true }); copyFileSync(from, join(dirname(to), uri)); } }
  const manifest = join(ASSETS, 'models.json'), list = existsSync(manifest) ? JSON.parse(readFileSync(manifest, 'utf8')) : [];
  writeFileSync(manifest, JSON.stringify([...list.filter((m) => m.file !== as + '.glb'), { file: as + '.glb', ...meta, sha256: createHash('sha256').update(readFileSync(to)).digest('hex').slice(0, 16), triangles: info.triangles, added: new Date().toISOString().slice(0, 10) }], null, 1) + '\n');
  if (!existsSync(join(ASSETS, 'CREDITS.md'))) writeFileSync(join(ASSETS, 'CREDITS.md'), '# Credits for 3D models\n\nEverything here is CC0 or CC-BY. CC-BY requires the credit below; CC0 is credited as a thank-you.\n\n');
  appendFileSync(join(ASSETS, 'CREDITS.md'), `- \`${as}.glb\` — "${meta.title}" by ${meta.author} (${meta.source}, ${meta.licence}) ${meta.url}\n`);
  console.log(`→ public/assets/${as}.glb`, info, info.warn.length ? '\nWARNINGS: ' + info.warn.join('; ') : '');
} else console.log(readFileSync(new URL(import.meta.url).pathname, 'utf8').split('\n').slice(1, 22).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
