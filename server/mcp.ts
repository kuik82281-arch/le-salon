// Le Salon - an MCP server (stdio) so any model that speaks MCP can play the piano for you: Claude Desktop, Claude
// Code, or your own agent. It calls the running HTTP server (SALON_URL, default http://localhost:7532), so the open
// page hears it at once.
//
//   tools: play     - play a piece it writes itself, in a compact notation (one line per hand)
//          request  - ask for a song by name: a local Qwen model finds the score in a MIDI archive, the piano plays it
//          recent   - what was played lately
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { NOTATION_HELP } from './store.ts';

const BASE = process.env.SALON_URL ?? 'http://localhost:7532';
const TOKEN = process.env.SALON_TOKEN ?? '';
const text = (value: string, isError = false) => ({ content: [{ type: 'text' as const, text: value }], ...(isError ? { isError: true } : {}) });
const mmss = (s: number) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;

async function call(method: string, p: string, body?: unknown) {
  const res = await fetch(`${BASE}${p}`, {
    method,
    headers: { 'content-type': 'application/json', ...(TOKEN ? { authorization: `Bearer ${TOKEN}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new Error(typeof json.error === 'string' ? json.error : `HTTP ${res.status}`);
  return json;
}

const server = new McpServer({ name: 'le-salon', version: '0.1.0' });

server.registerTool('play', {
  description: `Play a piece on the grand piano in Le Salon for the user: the open page starts playing at once, keys moving. ${NOTATION_HELP} You can improvise, or look up a melody first.`,
  inputSchema: { title: z.string().min(1).max(60), note: z.string().max(140).optional(), bpm: z.number().min(20).max(300).optional(), voices: z.array(z.string().max(20000)).min(1).max(8) },
}, async (input) => {
  try {
    const { performance } = (await call('POST', '/api/piano/play', input)) as { performance: { title: string; score: { notes: unknown[]; duration: number } } };
    return text(`Playing "${performance.title}": ${performance.score.notes.length} notes, ${mmss(performance.score.duration)}.`);
  } catch (error) {
    return text(error instanceof Error ? error.message : String(error), true);
  }
});

server.registerTool('request', {
  description: 'Ask for a song by name and let the piano play it: a local Qwen model finds the score in a MIDI archive (mostly Western songs, game and film music, classical pieces), no notation to write. Write the title as it is known in English when you can.',
  inputSchema: { song: z.string().min(1).max(80), note: z.string().max(140).optional() },
}, async ({ song, note }) => {
  try {
    const { performance } = (await call('POST', '/api/piano/request', { song, note, by: 'ai' })) as { performance: { title: string; score: { duration: number } } };
    return text(`Found it - playing "${performance.title}" (${mmss(performance.score.duration)}).`);
  } catch (error) {
    return text(error instanceof Error ? error.message : String(error), true);
  }
});

server.registerTool('recent', { description: 'What was played lately.', annotations: { readOnlyHint: true } }, async () => {
  try {
    const { performances } = (await call('GET', '/api/piano')) as { performances: { title: string; createdAt: string; note: string; by: string; score: { duration: number } }[] };
    return text(performances.length ? performances.slice(0, 12).map((p) => `${p.createdAt.slice(0, 16).replace('T', ' ')} "${p.title}" ${mmss(p.score.duration)} (${p.by})${p.note ? ` - ${p.note}` : ''}`).join('\n') : 'Nothing played yet.');
  } catch (error) {
    return text(error instanceof Error ? error.message : String(error), true);
  }
});

await server.connect(new StdioServerTransport());
