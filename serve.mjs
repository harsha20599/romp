// The build machine's server for a test build: the static app from ./dist, plus POST /report, where the tablet
// drops what it measured (tracker speed, frame pacing per round, tuning tapes). No dependencies.
//   node serve.mjs [port]   → reports land in ./reports/ (git-ignored): reports.jsonl, and one file per tape.
import { createServer } from 'node:http';
import { appendFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { brotliCompress, constants, gzip } from 'node:zlib';
import { extname, join, normalize } from 'node:path';

const root = join(import.meta.dirname, 'dist'), reports = join(import.meta.dirname, 'reports'), port = Number(process.argv[2] ?? 5191);
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.glb': 'model/gltf-binary', '.ogg': 'audio/ogg', '.mp3': 'audio/mpeg', '.map': 'application/json' };
await mkdir(reports, { recursive: true });
// Text-like files go out compressed (the tracker's wasm shrinks from 11.7MB to ~3MB). Each is compressed once per
// build and kept in memory; models (.task) and sounds are already dense, so they are sent as they are.
const SQUASH = new Set(['.html', '.js', '.mjs', '.css', '.json', '.wasm', '.svg', '.glb', '.map']), squashed = new Map();
const br = promisify(brotliCompress), gz = promisify(gzip);
async function squash(file, tag, data, accepts) {
  const how = /\bbr\b/.test(accepts) ? 'br' : /\bgzip\b/.test(accepts) ? 'gzip' : '';
  if (!how || data.length < 1024) return { data };
  const key = `${file}|${tag}|${how}`;
  if (!squashed.has(key)) squashed.set(key, how === 'br' ? br(data, { params: { [constants.BROTLI_PARAM_QUALITY]: 6, [constants.BROTLI_PARAM_SIZE_HINT]: data.length } }) : gz(data));
  return { data: await squashed.get(key), how };
}

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
    // Hashed build files never change. Everything else is re-checked against its ETag: a new build shows up on the
    // next reload, and an unchanged 9MB model costs a 304, not a download.
    const info = await stat(file), tag = `"${info.size.toString(36)}-${Math.round(info.mtimeMs).toString(36)}"`;
    const headers = { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream', etag: tag, vary: 'accept-encoding', 'cache-control': /^\/assets\/[^/]+-[\w-]{8}\.(js|css)$/.test(path) ? 'max-age=31536000, immutable' : 'no-cache' };
    if (req.headers['if-none-match'] === tag) return void res.writeHead(304, headers).end();
    const raw = await readFile(file), out = SQUASH.has(extname(file)) ? await squash(file, tag, raw, String(req.headers['accept-encoding'] ?? '')) : { data: raw };
    if (out.how) headers['content-encoding'] = out.how;
    res.writeHead(200, headers).end(out.data);
  } catch {
    res.writeHead(404).end('not found');
  }
}).listen(port, '127.0.0.1', () => console.log(`romp test build on http://127.0.0.1:${port}`));
