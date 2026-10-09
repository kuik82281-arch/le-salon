// Le Salon - the HTTP server: the piano's API, a stream that tells open pages what to play, and (after `npm run
// build`) the page itself.
//
//   GET  /api/piano                 -> { performances }     what was played (newest first)
//   POST /api/piano/play            { title, note?, bpm?, voices? | notes? } -> { performance }   the AI plays a piece it wrote
//   POST /api/piano/request         { song, by?, note? }    -> { performance }   a song by name: Qwen finds the MIDI
//   GET  /api/updates               event stream: `piano` { performance } whenever something is played
//   POST /api/chat                  { messages, context? } -> { reply }   the chat window: any OpenAI-compatible model
//
// PORT (7532), DATA_DIR (./data), SALON_TOKEN (Bearer for POSTs, if set), OLLAMA_URL and SALON_QWEN_MODEL come from
// the environment; the chat window's model from CHAT_BASE_URL (an OpenAI-compatible /v1, default: the local Ollama),
// CHAT_MODEL (default SALON_QWEN_MODEL or qwen2.5:3b), CHAT_API_KEY and CHAT_SYSTEM (who it is).
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import path from 'node:path';
import { SalonError, onPerformance, playPiece, recentPerformances, requestSong } from './store.ts';

const CHAT_BASE = (process.env.CHAT_BASE_URL ?? `${process.env.OLLAMA_URL ?? 'http://127.0.0.1:11434'}/v1`).replace(/\/$/, '');
const CHAT_MODEL = process.env.CHAT_MODEL ?? process.env.SALON_QWEN_MODEL ?? 'qwen2.5:3b';
const CHAT_SYSTEM = process.env.CHAT_SYSTEM ?? '你在一间只有一架三角钢琴的琴室里，陪对方一边听琴一边聊天。说话简短、自然。';

/** The chat window: the last 20 messages and what is playing go to an OpenAI-compatible chat/completions. */
async function chat(body: Record<string, unknown>) {
  const messages = (Array.isArray(body.messages) ? body.messages : [])
    .filter((m): m is { role: 'user' | 'assistant'; content: string } => !!m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    .slice(-20)
    .map((m) => ({ role: m.role, content: m.content.slice(0, 4000) }));
  if (!messages.length) throw new SalonError('messages is empty');
  const context = (body.context ?? {}) as { playing?: unknown; by?: unknown };
  const playing = typeof context.playing === 'string' && context.playing ? `
现在琴上在弹：${context.playing.slice(0, 80)}${typeof context.by === 'string' ? `（${context.by.slice(0, 40)}）` : ''}。` : '';
  const r = await fetch(`${CHAT_BASE}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(process.env.CHAT_API_KEY ? { authorization: `Bearer ${process.env.CHAT_API_KEY}` } : {}) },
    body: JSON.stringify({ model: CHAT_MODEL, messages: [{ role: 'system', content: CHAT_SYSTEM + playing }, ...messages] }),
    signal: AbortSignal.timeout(90_000),
  }).catch(() => { throw new SalonError(`连不上聊天模型（${CHAT_BASE}）：设好 CHAT_BASE_URL / CHAT_MODEL，或开着 Ollama`); });
  const data = await r.json().catch(() => null) as { choices?: { message?: { content?: string } }[]; error?: { message?: string } } | null;
  const reply = data?.choices?.[0]?.message?.content?.trim();
  if (!r.ok || !reply) throw new SalonError(`聊天模型没有回答：${data?.error?.message ?? r.status}`);
  return { reply };
}

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
  if (req.method === 'POST' && p === '/api/chat') return send(res, 200, await chat(((await readJson(req)) ?? {}) as Record<string, unknown>));
  send(res, 404, { error: 'not found' });
}

createServer((req, res) => {
  route(req, res).catch((error) => {
    if (error instanceof SalonError) send(res, 400, { error: error.message });
    else { console.error(error); send(res, 500, { error: 'server error' }); }
  });
}).listen(PORT, () => console.log(`Le Salon on http://localhost:${PORT}`));
