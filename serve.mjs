// The build machine's server for a test build: the static app from ./dist, plus POST /report, where the tablet
// drops what it measured (tracker speed, frame pacing per round, tuning tapes). No dependencies.
//   node serve.mjs [port]   → reports land in ./reports/ (git-ignored): reports.jsonl, and one file per tape.
import { createServer } from 'node:http';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

const root = join(import.meta.dirname, 'dist'), reports = join(import.meta.dirname, 'reports'), port = Number(process.argv[2] ?? 5191);
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.glb': 'model/gltf-binary', '.ogg': 'audio/ogg', '.mp3': 'audio/mpeg', '.map': 'application/json' };
await mkdir(reports, { recursive: true });

createServer(async (req, res) => {
  try {
    if (req.method === 'POST' && req.url === '/report') {
      let body = '';
      for await (const chunk of req) if ((body += chunk).length > 8e6) throw new Error('too big');
      const r = JSON.parse(body);
      if (r.kind === 'tape') await writeFile(join(reports, `tape-${r.at.replace(/[:.]/g, '-')}.json`), body);
      await appendFile(join(reports, 'reports.jsonl'), JSON.stringify(r.kind === 'tape' ? { ...r, data: `${r.data.length} frames` } : r) + '\n');
      return void res.writeHead(204).end();
    }
    const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^(\.\.[/\\])+/, '');
    const file = join(root, path.endsWith('/') ? path + 'index.html' : path);
    if (!file.startsWith(root)) throw new Error('outside');
    const data = await readFile(file);
    // Hashed build files never change; everything else is re-checked, so a new build shows up on the next reload.
    res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream', 'cache-control': path.startsWith('/assets/index-') ? 'max-age=31536000, immutable' : 'no-cache' }).end(data);
  } catch {
    res.writeHead(404).end('not found');
  }
}).listen(port, '127.0.0.1', () => console.log(`romp test build on http://127.0.0.1:${port}`));
