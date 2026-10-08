// Le Salon - what was played: kept in DATA_DIR/piano.json (the last 40), and told to every open page at once.
//
//   playPiece   the AI writes a piece itself, in the compact notation (src/piano/score.ts) or as notes
//   requestSong a song asked for by name: a local Qwen model (Ollama) names it in English, the BitMidi archive is
//               searched, Qwen picks the file that is really that song, and the MIDI is played on the piano
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseMIDI, scoreFromNotation, validateScore, type Score } from '../src/piano/score.ts';

export class SalonError extends Error {}

/** `by`: who asked for it; `via`: written by hand (the notation) or found by Qwen (a MIDI from the archive). */
export type Performance = { id: string; by: 'ai' | 'user'; via: 'hand' | 'qwen'; title: string; note: string; createdAt: string; score: Score; sourceUrl?: string };

const KEEP = 40;
const MAX_NOTES = 4000;
const DATA_DIR = process.env.DATA_DIR ?? path.join(import.meta.dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'piano.json');

let performances: Performance[] = (() => {
  try {
    const saved = JSON.parse(readFileSync(FILE, 'utf8')) as { performances?: Performance[] };
    return Array.isArray(saved.performances) ? saved.performances : [];
  } catch {
    return [];
  }
})();

const listeners = new Set<(p: Performance) => void>();
/** Pages listening (the HTTP server's /api/updates stream). Returns the unsubscribe. */
export function onPerformance(fn: (p: Performance) => void) { listeners.add(fn); return () => listeners.delete(fn); }

export const recentPerformances = () => performances;

function keep(p: Performance): Performance {
  performances = [p, ...performances].slice(0, KEEP);
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(`${FILE}.tmp`, JSON.stringify({ performances }));
  renameSync(`${FILE}.tmp`, FILE);
  for (const fn of listeners) fn(p);
  return p;
}

export const NOTATION_HELP =
  'Write the piece in `voices`: one line per hand (or voice), all lines start together; `bpm` is the tempo (default 90). ' +
  'Each note is pitch/beats: C4/1 (middle C, one beat), F#3/0.5, Bb2/2; a chord joins pitches with +: E4+G4+C5/2; a rest is R/1; ' +
  'add !velocity for a louder note: C5/1!0.95; | is a bar line, only for reading. A separate line "pedal: 0 4 4 8" presses the sustain pedal ' +
  'at beat 0, lifts it at 4, presses again, lifts at 8. Example: voices ["E4/1 D4/1 C4/1 D4/1 | E4/1 E4/1 E4/2", "C3+G3/4 | C3+G3/4"].';

export function playPiece(input: { title: string; note?: string; bpm?: number; voices?: string[]; notes?: unknown[] }, now = new Date()): Performance {
  const title = String(input.title ?? '').trim().slice(0, 60) || 'Untitled';
  let score: Score;
  try {
    score = input.voices?.length
      ? scoreFromNotation({ title, bpm: input.bpm, voices: input.voices, source: 'AI' })
      : validateScore({ version: 1, title, source: 'AI', notes: input.notes ?? [] });
  } catch (error) {
    throw new SalonError(error instanceof Error ? error.message : String(error));
  }
  if (score.notes.length > MAX_NOTES) throw new SalonError(`at most ${MAX_NOTES} notes in a piece`);
  return keep({ id: `pf-${now.getTime().toString(36)}`, by: 'ai', via: 'hand', title, note: String(input.note ?? '').trim().slice(0, 140), createdAt: now.toISOString(), score });
}

// ------------------------------------------------------------ 点歌: Qwen (a local Ollama model) finds a MIDI

const OLLAMA = process.env.OLLAMA_URL ?? 'http://127.0.0.1:11434';
const QWEN = process.env.SALON_QWEN_MODEL ?? 'qwen2.5:3b';
const ARCHIVE = 'https://bitmidi.com';
const MIDI_MAX_BYTES = 2 * 1024 * 1024;
const REQUEST_MAX_NOTES = 20_000;

type Fetch = typeof fetch;
let fetcher: Fetch = (...a) => fetch(...a);
/** Tests replace the network (Ollama and the archive). */
export function setFetchForTests(f: Fetch | null) { fetcher = f ?? ((...a) => fetch(...a)); }

async function askQwen<T>(system: string, user: string, examples: [string, unknown][] = []): Promise<T | null> {
  const messages = [{ role: 'system', content: system }];
  for (const [q, a] of examples) messages.push({ role: 'user', content: q }, { role: 'assistant', content: JSON.stringify(a) });
  messages.push({ role: 'user', content: user });
  try {
    const res = await fetcher(`${OLLAMA}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: AbortSignal.timeout(25_000),
      body: JSON.stringify({ model: QWEN, stream: false, format: 'json', options: { temperature: 0 }, messages }),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { message?: { content?: string } };
    return JSON.parse(body.message?.content ?? 'null') as T;
  } catch {
    return null;
  }
}

type Candidate = { name: string; downloadUrl: string };
async function searchArchive(q: string): Promise<Candidate[]> {
  try {
    const res = await fetcher(`${ARCHIVE}/api/midi/search?q=${encodeURIComponent(q)}`, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return [];
    const body = (await res.json()) as { result?: { results?: Candidate[] } };
    return (body.result?.results ?? []).filter((c) => typeof c?.downloadUrl === 'string' && /\.midi?$/i.test(c.downloadUrl)).slice(0, 8);
  } catch {
    return [];
  }
}

export async function requestSong(input: { song: string; by: 'ai' | 'user'; note?: string }, now = new Date()): Promise<Performance> {
  const song = String(input.song ?? '').trim().slice(0, 80);
  if (!song) throw new SalonError('which song?');
  // a 3B model needs examples: it only translates the name (it would rather invent another song than say it does not know)
  const plan = await askQwen<{ title?: unknown; artist?: unknown }>(
    'Translate a song name into the title it is known by in English. Reply as JSON {"title": "...", "artist": "..."} (artist "" if unsure). Never invent another song.',
    song,
    [
      ['月亮代表我的心', { title: 'The Moon Represents My Heart', artist: 'Teresa Teng' }],
      ['致爱丽丝', { title: 'Fur Elise', artist: 'Beethoven' }],
      ['天空之城', { title: 'Castle in the Sky', artist: 'Joe Hisaishi' }],
      ['梦中的婚礼', { title: "Mariage d'Amour", artist: 'Richard Clayderman' }],
      ['River Flows in You', { title: 'River Flows in You', artist: 'Yiruma' }],
    ],
  );
  const title = typeof plan?.title === 'string' ? plan.title.trim().slice(0, 60) : '';
  const artist = typeof plan?.artist === 'string' && !/unsure|unknown|various|不确定|未知/i.test(plan.artist) ? plan.artist.trim().slice(0, 40) : '';
  const queries = [...new Set([title, song, title && artist ? `${title} ${artist}` : ''].filter(Boolean))].slice(0, 3);
  const seen = new Set<string>();
  const candidates: Candidate[] = [];
  for (const q of queries) for (const c of await searchArchive(q)) if (!seen.has(c.downloadUrl)) { seen.add(c.downloadUrl); candidates.push(c); }
  if (!candidates.length) throw new SalonError(`no score found for "${song}"`);
  const pick = await askQwen<{ index?: unknown }>(
    'You choose which MIDI file is the requested song. Reply as JSON {"index": n} with the number of the best match, or {"index": -1} if none of them is that song. Prefer a piano version, then the most complete one.',
    `Request: ${song}${title && title !== song ? ` (${title})` : ''}\nFiles:\n${candidates.map((c, i) => `${i}. ${c.name}`).join('\n')}`,
  );
  const index = typeof pick?.index === 'number' ? pick.index : Number(pick?.index);
  if (index === -1) throw new SalonError(`"${song}" is not in the archive`);
  const chosen = Number.isInteger(index) && candidates[index] ? candidates[index] : candidates[0];
  const url = new URL(chosen.downloadUrl, ARCHIVE).toString();
  const res = await fetcher(url, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new SalonError('the score could not be downloaded');
  const bytes = await res.arrayBuffer();
  if (bytes.byteLength > MIDI_MAX_BYTES) throw new SalonError('that score is too large');
  let score: Score;
  try {
    score = parseMIDI(bytes, song, url).score;
  } catch (error) {
    throw new SalonError(error instanceof Error ? error.message : String(error));
  }
  if (score.notes.length > REQUEST_MAX_NOTES) throw new SalonError('that score is too long');
  return keep({ id: `pf-${now.getTime().toString(36)}`, by: input.by, via: 'qwen', title: song, note: String(input.note ?? '').trim().slice(0, 140), createdAt: now.toISOString(), score, sourceUrl: url });
}
