// Le Salon - the HTTP server: the piano's API, a stream that tells open pages what to play, and (after `npm run
// build`) the page itself.
//
//   GET  /api/piano                 -> { performances }     what was played (newest first)
//   POST /api/piano/play            { title, note?, bpm?, voices? | notes? } -> { performance }   the AI plays a piece it wrote
//   POST /api/piano/request         { song, by?, note? }    -> { performance }   a song by name: Qwen finds the MIDI
//   GET  /api/updates               event stream: `piano` { performance } whenever something is played
//
// PORT (7532), DATA_DIR (./data), SALON_TOKEN (Bearer for POSTs, if set), OLLAMA_URL and SALON_QWEN_MODEL come from
// the environment.
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import path from 'node:path';
import { SalonError, onPerformance, playPiece, recentPerformances, requestSong } from './store.ts';

const PORT = Number(process.env.PORT ?? 7532);
const TOKEN = process.env.SALON_TOKEN ?? '';
const DIST = path.join(import.meta.dirname, '..', 'dist');

const send = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
};
const readJson = (req: IncomingMessage) => new Promise<unknown>((resolve, reject) => {
  let raw = '';
  req.setEncoding('utf8');
  req.on('data', (chunk) => { raw += chunk; if (raw.length > 2_000_000) reject(new SalonError('body too large')); });
  req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : null); } catch { reject(new SalonError('body is not JSON')); } });
  req.on('error', reject);
});

const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.woff2': 'font/woff2' };
function serveStatic(url: URL, res: ServerResponse) {
  let file = path.join(DIST, decodeURIComponent(url.pathname));
  if (!file.startsWith(DIST) || !existsSync(file) || statSync(file).isDirectory()) file = path.join(DIST, 'index.html');
  if (!existsSync(file)) { send(res, 404, { error: 'run `npm run build` first, or use `npm run dev` for the page' }); return; }
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream' });
  createReadStream(file).pipe(res);
}

function updates(req: IncomingMessage, res: ServerResponse) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
  res.write('event: ready\ndata: {}\n\n');
  const off = onPerformance((performance) => res.write(`event: piano\ndata: ${JSON.stringify({ performance })}\n\n`));
  const ping = setInterval(() => res.write('event: ping\ndata: {}\n\n'), 15_000);
  req.on('close', () => { off(); clearInterval(ping); });
}

async function route(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const p = url.pathname;
  if (!p.startsWith('/api/')) return serveStatic(url, res);
  if (req.method === 'GET' && p === '/api/updates') return updates(req, res);
  if (req.method === 'GET' && p === '/api/piano') return send(res, 200, { performances: recentPerformances() });
  if (req.method === 'POST' && (p === '/api/piano/play' || p === '/api/piano/request')) {
    if (TOKEN && req.headers.authorization !== `Bearer ${TOKEN}` && p === '/api/piano/play') return send(res, 401, { error: 'unauthorized' });
    const body = ((await readJson(req)) ?? {}) as Record<string, unknown>;
    if (p === '/api/piano/play') return send(res, 200, { performance: playPiece(body as Parameters<typeof playPiece>[0]) });
    const by = body.by === 'ai' ? 'ai' : 'user';
    if (by === 'ai' && TOKEN && req.headers.authorization !== `Bearer ${TOKEN}`) return send(res, 401, { error: 'unauthorized' });
    return send(res, 200, { performance: await requestSong({ song: String(body.song ?? ''), by, note: typeof body.note === 'string' ? body.note : undefined }) });
  }
  send(res, 404, { error: 'not found' });
}

createServer((req, res) => {
  route(req, res).catch((error) => {
    if (error instanceof SalonError) send(res, 400, { error: error.message });
    else { console.error(error); send(res, 500, { error: 'server error' }); }
  });
}).listen(PORT, () => console.log(`Le Salon on http://localhost:${PORT}`));
