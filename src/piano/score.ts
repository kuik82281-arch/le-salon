// Scores for 琴室 (adapted from Piano Atelier's score.js): the validated JSON score both the page and the bridge use
// (server/store.ts checks what the AI plays with it), a compact notation he can write by hand, and the built-in pieces.
// All times are seconds. No DOM here: the bridge imports this file.

export type ScoreNote = { midi: number; time: number; duration: number; velocity: number };
export type ScorePedal = { time: number; down: boolean };
export type Score = { version: 1; title: string; source: string; notes: ScoreNote[]; pedals: ScorePedal[]; duration: number };

const NAMES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
export const noteName = (m: number) => NAMES[m % 12] + (Math.floor(m / 12) - 1);

export const SCORE_LIMITS = { notes: 50_000, pedals: 20_000, seconds: 7200 };

export function validateScore(input: unknown): Score {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('乐谱必须是 JSON 对象');
  const src = input as { version?: unknown; title?: unknown; source?: unknown; notes?: unknown; pedals?: unknown };
  if (src.version !== 1) throw new Error('乐谱 version 必须是 1');
  if (!Array.isArray(src.notes) || !src.notes.length || src.notes.length > SCORE_LIMITS.notes) throw new Error(`notes 必须包含 1–${SCORE_LIMITS.notes} 个音符`);
  const finite = (n: unknown, min: number, max: number, label: string) => {
    if (typeof n !== 'number' || !Number.isFinite(n) || n < min || n > max) throw new Error(`${label} 超出范围`);
    return n;
  };
  const notes = src.notes.map((raw, i) => {
    const n = raw as Partial<ScoreNote> | null;
    if (!n || typeof n !== 'object') throw new Error(`notes[${i}] 格式错误`);
    const midi = finite(n.midi, 21, 108, `notes[${i}].midi`);
    if (!Number.isInteger(midi)) throw new Error('midi 必须是整数');
    return {
      midi,
      time: finite(n.time, 0, SCORE_LIMITS.seconds, `notes[${i}].time`),
      duration: finite(n.duration, 0.01, 120, `notes[${i}].duration`),
      velocity: finite(n.velocity ?? 0.75, 0.01, 1, `notes[${i}].velocity`),
    };
  }).sort((a, b) => a.time - b.time);
  const rawPedals = src.pedals ?? [];
  if (!Array.isArray(rawPedals) || rawPedals.length > SCORE_LIMITS.pedals) throw new Error('pedals 格式错误');
  const pedals = rawPedals.map((raw) => {
    const p = raw as Partial<ScorePedal> | null;
    if (!p || typeof p.down !== 'boolean') throw new Error('pedal.down 必须是布尔值');
    return { time: finite(p.time, 0, SCORE_LIMITS.seconds, 'pedal.time'), down: p.down };
  }).sort((a, b) => a.time - b.time);
  const duration = Math.max(...notes.map((n) => n.time + n.duration), ...pedals.map((p) => p.time));
  if (duration > SCORE_LIMITS.seconds) throw new Error('乐谱最长为两小时');
  return {
    version: 1,
    title: typeof src.title === 'string' && src.title.trim() ? src.title.slice(0, 160) : '未命名',
    source: typeof src.source === 'string' ? src.source.slice(0, 1000) : '',
    notes,
    pedals,
    duration,
  };
}

const LETTER: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
/** "C4", "F#3", "Bb2", "c5" -> MIDI number. */
export function pitchToMidi(text: string): number {
  const m = /^([A-Ga-g])([#♯b♭]*)(-?\d)$/.exec(text.trim());
  if (!m) throw new Error(`看不懂的音高「${text}」（写成 C4、F#3、Bb2 这样）`);
  const accidental = [...m[2]].reduce((n, c) => n + (c === '#' || c === '♯' ? 1 : -1), 0);
  const midi = (Number(m[3]) + 1) * 12 + LETTER[m[1].toUpperCase()] + accidental;
  if (midi < 21 || midi > 108) throw new Error(`「${text}」不在钢琴的 88 个键里（A0–C8）`);
  return midi;
}

/**
 * The notation the AI writes: one line per hand (or voice), all starting together. Tokens are separated by spaces:
 *   C4/1        a note, one beat          E4+G4+C5/2   a chord, two beats       R/0.5   a rest, half a beat
 *   C4/1!0.9    a louder note (velocity 0.01–1)       |  a bar line, ignored (just for reading)
 * Beats follow `bpm`. A line may start with "pedal:" followed by beat numbers where the sustain pedal is pressed and
 * lifted alternately, e.g. "pedal: 0 4 4 8" (down at 0, up at 4, down at 4, up at 8).
 */
export function scoreFromNotation(input: { title?: string; bpm?: number; voices: string[]; source?: string }): Score {
  const bpm = input.bpm ?? 90;
  if (!Number.isFinite(bpm) || bpm < 20 || bpm > 300) throw new Error('bpm 要在 20–300 之间');
  const beat = 60 / bpm;
  const notes: ScoreNote[] = [];
  const pedals: ScorePedal[] = [];
  input.voices.forEach((line, v) => {
    const text = line.trim();
    if (/^pedal\s*:/i.test(text)) {
      text.replace(/^pedal\s*:/i, '').trim().split(/\s+/).filter(Boolean).forEach((b, i) => {
        const at = Number(b);
        if (!Number.isFinite(at) || at < 0) throw new Error(`踏板拍点「${b}」看不懂`);
        pedals.push({ time: at * beat, down: i % 2 === 0 });
      });
      return;
    }
    let at = 0;
    for (const token of text.split(/\s+/).filter((t) => t && t !== '|' && t !== '||')) {
      const m = /^([^/]+)\/([\d.]+)(?:!([\d.]+))?$/.exec(token);
      if (!m) throw new Error(`第 ${v + 1} 行的「${token}」看不懂（写成 C4/1、E4+G4/2、R/0.5）`);
      const beats = Number(m[2]);
      if (!Number.isFinite(beats) || beats <= 0 || beats > 64) throw new Error(`「${token}」的拍数不对`);
      const velocity = m[3] ? Math.min(1, Math.max(0.01, Number(m[3]))) : 0.72;
      if (m[1].toUpperCase() !== 'R') {
        for (const p of m[1].split('+')) notes.push({ midi: pitchToMidi(p), time: at * beat, duration: Math.max(0.05, beats * beat * 0.92), velocity });
      }
      at += beats;
    }
  });
  return validateScore({ version: 1, title: input.title ?? '未命名', source: input.source ?? '', notes, pedals });
}

function melody(title: string, sequence: [number, number][], beat = 0.44): Score {
  const notes: ScoreNote[] = [];
  let time = 0;
  for (const [m, d] of sequence) {
    notes.push({ midi: m, time, duration: d * beat * 0.9, velocity: 0.72 });
    time += d * beat;
  }
  return validateScore({ version: 1, title, source: '公版旋律 · 简编', notes });
}
const twinkle = [60, 60, 67, 67, 69, 69, 67, 65, 65, 64, 64, 62, 62, 60, 67, 67, 65, 65, 64, 64, 62, 67, 67, 65, 65, 64, 64, 62, 60, 60, 67, 67, 69, 69, 67, 65, 65, 64, 64, 62, 62, 60]
  .map((m, i) => [m, i % 7 === 6 ? 2 : 1] as [number, number]);
const ode = [64, 64, 65, 67, 67, 65, 64, 62, 60, 60, 62, 64, 64, 62, 62, 64, 64, 65, 67, 67, 65, 64, 62, 60, 60, 62, 64, 62, 60, 60]
  .map((m, i) => [m, [14, 29].includes(i) ? 2 : 1] as [number, number]);
const bach = validateScore({
  version: 1,
  title: 'C 大调前奏曲',
  source: 'J. S. Bach · BWV 846 · 开篇',
  notes: [[48, 52, 55, 60, 64], [48, 50, 57, 62, 65], [47, 50, 55, 62, 65], [48, 52, 55, 60, 64]].flatMap((ch, bar) =>
    [0, 1].flatMap((rep) => [0, 1, 2, 3, 4, 2, 3, 4].map((n, j) => ({ midi: ch[n], time: (bar * 16 + rep * 8 + j) * 0.2, duration: n < 2 ? 0.65 : 0.3, velocity: n === 0 ? 0.8 : 0.62 })))),
});

export const DEMOS: { id: string; score: Score }[] = [
  { id: 'bach', score: bach },
  { id: 'ode', score: melody('欢乐颂', ode, 0.4) },
  { id: 'twinkle', score: melody('小星星', twinkle) },
];

/** A standard MIDI file (format 0 / 1) -> a score: every channel but percussion onto the one keyboard, tempo changes
 * honoured, the sustain pedal kept (adapted from Piano Atelier's parseMIDI). */
export function parseMIDI(buffer: ArrayBuffer, title = '导入的 MIDI', source = ''): { score: Score; warnings: string[] } {
  const v = new DataView(buffer);
  let pos = 0;
  const need = (n: number) => { if (pos + n > v.byteLength) throw new Error('MIDI 文件截断'); };
  const u8 = () => { need(1); return v.getUint8(pos++); };
  const u16 = () => { need(2); const n = v.getUint16(pos); pos += 2; return n; };
  const u32 = () => { need(4); const n = v.getUint32(pos); pos += 4; return n; };
  const str = (n: number) => String.fromCharCode(...Array.from({ length: n }, u8));
  const vlq = () => { let n = 0; for (let i = 0; i < 4; i++) { const b = u8(); n = n * 128 + (b & 127); if (!(b & 128)) return n; } throw new Error('MIDI 可变整数无效'); };
  if (str(4) !== 'MThd') throw new Error('不是标准 MIDI 文件');
  const hlen = u32();
  if (hlen < 6) throw new Error('MIDI 头无效');
  const format = u16(), tracks = u16(), division = u16();
  if (format > 1) throw new Error('仅支持 MIDI format 0 / 1');
  if (division & 0x8000 || !division) throw new Error('不支持 SMPTE MIDI 时间码');
  pos += hlen - 6;
  type Ev = { tick: number; ch: number; tr: number; midi?: number; velocity?: number; on?: boolean; pedal?: boolean };
  const events: Ev[] = [];
  const tempos: { tick: number; us: number; seconds?: number }[] = [{ tick: 0, us: 500000 }];
  const warnings = new Set<string>();
  for (let tr = 0; tr < tracks; tr++) {
    if (str(4) !== 'MTrk') throw new Error('MIDI 轨道头无效');
    const length = u32(), end = pos + length;
    if (end > v.byteLength) throw new Error('MIDI 轨道截断');
    let tick = 0, running = 0;
    while (pos < end) {
      tick += vlq();
      let b = u8();
      if (b < 128) { if (!running) throw new Error('MIDI running status 无效'); pos--; b = running; } else if (b < 240) running = b; else running = 0;
      if (b === 255) {
        const type = u8(), len = vlq();
        if (pos + len > end) throw new Error('MIDI meta 越界');
        if (type === 81 && len === 3) { const us = (v.getUint8(pos) << 16) | (v.getUint8(pos + 1) << 8) | v.getUint8(pos + 2); if (us) tempos.push({ tick, us }); }
        pos += len;
      } else if (b === 240 || b === 247) {
        pos += vlq();
      } else {
        const kind = b >> 4, ch = b & 15;
        if (kind < 8 || kind > 14) throw new Error('MIDI 事件无效');
        const a = u8(), d = kind === 12 || kind === 13 ? 0 : u8();
        if (ch === 9) { warnings.add('已跳过打击乐'); continue; }
        if (kind === 9 || kind === 8) events.push({ tick, ch, tr, midi: a, velocity: d / 127, on: kind === 9 && d > 0 });
        else if (kind === 11 && a === 64) events.push({ tick, ch, tr, pedal: d >= 64 });
      }
      if (events.length > 200000) throw new Error('MIDI 过大');
    }
    pos = end;
  }
  tempos.sort((a, b) => a.tick - b.tick);
  let sec = 0, last = 0, us = 500000;
  for (const t of tempos) { sec += ((t.tick - last) * us) / 1e6 / division; t.seconds = sec; last = t.tick; us = t.us; }
  const seconds = (tick: number) => {
    let lo = 0, hi = tempos.length - 1;
    while (lo < hi) { const mid = Math.ceil((lo + hi) / 2); if (tempos[mid].tick <= tick) lo = mid; else hi = mid - 1; }
    const t = tempos[lo];
    return t.seconds! + ((tick - t.tick) * t.us) / 1e6 / division;
  };
  events.sort((a, b) => a.tick - b.tick);
  const active = new Map<string, { midi: number; time: number; velocity: number }[]>();
  const pedalChannels = new Map<number, boolean>();
  const notes: ScoreNote[] = [];
  const pedals: ScorePedal[] = [];
  let pedalDown = false;
  for (const e of events) {
    const time = seconds(e.tick);
    if (e.pedal !== undefined) {
      pedalChannels.set(e.ch, e.pedal);
      const down = [...pedalChannels.values()].some(Boolean);
      if (down !== pedalDown) { pedals.push({ time, down }); pedalDown = down; }
      continue;
    }
    if (e.midi! < 21 || e.midi! > 108) { warnings.add('已跳过 88 键以外的音'); continue; }
    const id = `${e.tr}:${e.ch}:${e.midi}`;
    if (e.on) { if (!active.has(id)) active.set(id, []); active.get(id)!.push({ midi: e.midi!, time, velocity: Math.max(0.05, e.velocity!) }); }
    else { const n = active.get(id)?.shift(); if (n) notes.push({ ...n, duration: Math.max(0.01, time - n.time) }); }
  }
  for (const queue of active.values()) for (const n of queue) { warnings.add('未闭合的音限制为 0.5 秒'); notes.push({ ...n, duration: 0.5 }); }
  return { score: validateScore({ version: 1, title, source, notes, pedals }), warnings: [...warnings] };
}
