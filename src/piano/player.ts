// The performer (adapted from Piano Atelier's player.js): plays a score on PianoAudio and tells the scene which keys are
// down (`visual(midi, down)`), so the keys move with the music; play / pause / stop / seek / tempo, and keys she presses
// herself. Events: loaded, state, ended, noteon, noteoff, pedal.
import type { PianoAudio } from './audio';
import { validateScore, type Score, type ScoreNote } from './score';

export type PlayerState = { state: 'empty' | 'ready' | 'playing' | 'paused' | 'ended'; position: number; duration: number; title: string; source: string; tempo: number; volume: number; audioUnlocked: boolean };
type Ev = { time: number; type: 'on' | 'off' | 'pedal'; n?: ScoreNote; id?: number; down?: boolean };

export class PianoPlayer extends EventTarget {
  score: Score | null = null;
  state: PlayerState['state'] = 'empty';
  position = 0;
  rate = 1;
  private active = new Map<number, { voice: number; midi: number }>();
  private manual = new Map<number, { voice: number; midi: number }>();
  private cursor = 0;
  private events: Ev[] = [];
  private command = 0;
  private anchor = 0;
  private startPosition = 0;
  private timer: ReturnType<typeof setInterval>;

  constructor(private audio: PianoAudio, private visual: (midi: number, down: boolean, velocity?: number) => void) {
    super();
    this.timer = setInterval(() => this.tick(), 10);
  }

  private emit(type: string, detail: unknown) { this.dispatchEvent(new CustomEvent(type, { detail })); }

  loadScore(input: unknown) {
    const score = validateScore(input);
    this.stop();
    this.score = score;
    this.events = [];
    score.notes.forEach((n, id) => this.events.push({ time: n.time, type: 'on', n, id }, { time: n.time + n.duration, type: 'off', n, id }));
    score.pedals.forEach((p) => this.events.push({ time: p.time, type: 'pedal', down: p.down }));
    const order = { off: 0, pedal: 1, on: 2 };
    this.events.sort((a, b) => a.time - b.time || order[a.type] - order[b.type]);
    this.state = 'ready';
    this.emit('loaded', this.getState());
    return this.getState();
  }

  async play() {
    if (!this.score) throw new Error('NO_SCORE');
    if (this.state === 'playing') return this.getState();
    const ticket = ++this.command;
    await this.audio.unlock();
    if (ticket !== this.command) return this.getState();
    if (this.position >= this.score.duration) this.position = 0;
    this.cursor = this.events.findIndex((e) => e.time >= this.position);
    if (this.cursor < 0) this.cursor = this.events.length;
    let pedal = false;
    for (const p of this.score.pedals) if (p.time < this.position) pedal = p.down;
    this.audio.setSustain(pedal);
    this.emit('pedal', { down: pedal });
    this.score.notes.forEach((n, id) => { if (n.time < this.position && n.time + n.duration > this.position) this.startNote(id, n); });
    this.anchor = this.audio.ctx!.currentTime;
    this.startPosition = this.position;
    this.state = 'playing';
    this.emit('state', this.getState());
    return this.getState();
  }

  private startNote(id: number, n: ScoreNote) {
    const voice = this.audio.noteOn(n.midi, n.velocity);
    this.active.set(id, { voice, midi: n.midi });
    this.visual(n.midi, true, n.velocity);
    this.emit('noteon', { ...n, id });
  }

  private stopNote(id: number) {
    const n = this.active.get(id);
    if (!n) return;
    this.audio.noteOff(n.voice);
    this.active.delete(id);
    this.refreshKey(n.midi);
    this.emit('noteoff', { midi: n.midi, id });
  }

  private refreshKey(midi: number) {
    this.visual(midi, [...this.active.values(), ...this.manual.values()].some((n) => n.midi === midi));
  }

  private releaseAll() {
    this.audio.stop();
    const mids = new Set([...this.active.values(), ...this.manual.values()].map((n) => n.midi));
    this.active.clear();
    this.manual.clear();
    for (const m of mids) this.visual(m, false);
    this.emit('pedal', { down: false });
  }

  pause() {
    this.command++;
    if (this.state === 'playing' && this.score && this.audio.ctx) this.position = Math.min(this.score.duration, this.startPosition + (this.audio.ctx.currentTime - this.anchor) * this.rate);
    this.releaseAll();
    if (this.score) this.state = 'paused';
    this.emit('state', this.getState());
    return this.getState();
  }

  stop() {
    this.command++;
    this.releaseAll();
    this.position = 0;
    this.cursor = 0;
    this.state = this.score ? 'ready' : 'empty';
    this.emit('state', this.getState());
    return this.getState();
  }

  async seek(time: number) {
    if (!this.score) return this.getState();
    const was = this.state === 'playing';
    this.pause();
    this.position = Math.max(0, Math.min(this.score.duration, time));
    return was ? this.play() : this.getState();
  }

  async setTempo(rate: number) {
    const was = this.state === 'playing';
    if (was) this.pause();
    this.rate = Math.min(3, Math.max(0.25, rate));
    return was ? this.play() : this.getState();
  }

  setVolume(v: number) { this.audio.setVolume(Math.min(1, Math.max(0, v))); }

  /** A key she presses herself. Returns the voice to release. */
  noteOn(midi: number, velocity = 0.75) {
    const voice = this.audio.noteOn(midi, velocity);
    this.manual.set(voice, { midi, voice });
    this.visual(midi, true, velocity);
    this.emit('noteon', { midi, velocity, manual: true, id: voice });
    return voice;
  }

  noteOff(id: number) {
    const n = this.manual.get(id);
    if (!n) return;
    this.audio.noteOff(id);
    this.manual.delete(id);
    this.refreshKey(n.midi);
  }

  setSustain(down: boolean) { this.audio.setSustain(down); this.emit('pedal', { down }); }

  private tick() {
    if (this.state !== 'playing' || !this.score || !this.audio.ctx) return;
    this.position = Math.min(this.score.duration, this.startPosition + (this.audio.ctx.currentTime - this.anchor) * this.rate);
    while (this.cursor < this.events.length && this.events[this.cursor].time <= this.position) {
      const e = this.events[this.cursor++];
      if (e.type === 'on') { if (e.n!.time + e.n!.duration > this.position) this.startNote(e.id!, e.n!); }
      else if (e.type === 'off') this.stopNote(e.id!);
      else this.setSustain(Boolean(e.down));
    }
    if (this.position >= this.score.duration) {
      this.releaseAll();
      this.state = 'ended';
      this.emit('ended', this.getState());
      this.emit('state', this.getState());
    }
  }

  getState(): PlayerState {
    return {
      state: this.state, position: this.position, duration: this.score?.duration ?? 0, title: this.score?.title ?? '', source: this.score?.source ?? '',
      tempo: this.rate, volume: this.audio.volume, audioUnlocked: this.audio.unlocked,
    };
  }

  destroy() { clearInterval(this.timer); this.stop(); }
}
