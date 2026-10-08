import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), 'le-salon-'));
const { onPerformance, playPiece, recentPerformances, requestSong, setFetchForTests } = await import('./store.ts');
const { pitchToMidi, scoreFromNotation } = await import('../src/piano/score.ts');

test('the notation: pitches, chords, rests, accents, two hands together, the pedal', () => {
  assert.equal(pitchToMidi('C4'), 60);
  assert.equal(pitchToMidi('F#3'), 54);
  assert.equal(pitchToMidi('Bb2'), 46);
  const s = scoreFromNotation({ bpm: 120, voices: ['E4/1 R/1 | C4+E4+G4/2!0.9', 'C3/4', 'pedal: 0 4'] });
  assert.equal(s.notes.length, 5);
  assert.deepEqual(s.notes.filter((n) => n.time === 1).map((n) => n.midi).sort(), [60, 64, 67]);
  assert.deepEqual(s.pedals, [{ time: 0, down: true }, { time: 2, down: false }]);
});

test('a piece the AI plays is kept newest first and told to the open pages', () => {
  const heard: string[] = [];
  const off = onPerformance((p) => heard.push(p.title));
  playPiece({ title: 'one', voices: ['C4/1 D4/1 E4/2'] });
  const p = playPiece({ title: 'two', note: 'for you', voices: ['G4/2'] });
  off();
  assert.equal(recentPerformances()[0].id, p.id);
  assert.deepEqual(heard, ['one', 'two']);
  assert.throws(() => playPiece({ title: 'empty', voices: ['R/4'] }), /notes/);
});

/** A tiny MIDI file: one track, C4 then E4, a quarter note each at 120 bpm (division 480). */
function tinyMidi() {
  const track = [0x00, 0x90, 60, 100, 0x83, 0x60, 0x80, 60, 0, 0x00, 0x90, 64, 90, 0x83, 0x60, 0x80, 64, 0, 0x00, 0xff, 0x2f, 0x00];
  return new Uint8Array([0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 0, 0, 1, 0x01, 0xe0, 0x4d, 0x54, 0x72, 0x6b, 0, 0, 0, track.length, ...track]).buffer;
}

test('a song by name: Qwen names it, the archive is searched, Qwen picks the file, the MIDI is played', async () => {
  setFetchForTests((async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/api/chat')) {
      const last = JSON.parse(String(init?.body)).messages.at(-1).content as string;
      return new Response(JSON.stringify({ message: { content: JSON.stringify(last.startsWith('Request:') ? { index: 1 } : { title: 'Fur Elise', artist: 'Beethoven' }) } }));
    }
    if (url.includes('/api/midi/search')) return new Response(JSON.stringify({ result: { results: [{ name: 'elise-remix.mid', downloadUrl: '/uploads/1.mid' }, { name: 'Fur Elise.mid', downloadUrl: '/uploads/2.mid' }] } }));
    if (url.endsWith('/uploads/2.mid')) return new Response(tinyMidi());
    return new Response('no', { status: 404 });
  }) as typeof fetch);
  try {
    const p = await requestSong({ song: '致爱丽丝', by: 'user' });
    assert.equal(p.via, 'qwen');
    assert.equal(p.sourceUrl, 'https://bitmidi.com/uploads/2.mid');
    assert.deepEqual(p.score.notes.map((n) => n.midi), [60, 64]);
  } finally {
    setFetchForTests(null);
  }
});
