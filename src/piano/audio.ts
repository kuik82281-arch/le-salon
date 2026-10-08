// The piano's voice (adapted from Piano Atelier's audio.js): decaying, slightly inharmonic string partials, with a short
// felt-hammer knock at the attack and a hall around it (a generated reverb tail), so it sounds like a stage, not a box.
// Synthesis, not samples. The AudioContext opens on her first tap (browsers allow sound only after a gesture).

type Voice = { release: (time: number) => void; ends: number; midi: number; held: boolean };

function hallImpulse(ctx: BaseAudioContext, seconds = 2.6) {
  const rate = ctx.sampleRate, len = Math.floor(rate * seconds);
  const ir = ctx.createBuffer(2, len, rate);
  for (let ch = 0; ch < 2; ch++) {
    const data = ir.getChannelData(ch);
    for (let i = 0; i < len; i++) {
      const t = i / rate;
      // early reflections, then a smooth darkening tail
      const early = t < 0.08 && i % Math.floor(rate * (0.011 + ch * 0.003)) < 3 ? 0.6 : 0;
      data[i] = ((Math.random() * 2 - 1) * Math.exp(-t * 2.6) + early) * (1 - t / seconds);
    }
  }
  return ir;
}

export function createVoice(ctx: BaseAudioContext, destination: AudioNode, midi: number, velocity: number, when: number) {
  const frequency = 440 * 2 ** ((midi - 69) / 12);
  const gain = ctx.createGain();
  gain.gain.value = 0;
  gain.connect(destination);
  const oscillators: OscillatorNode[] = [];
  const decay = 1.8 + 4 * (1 - (midi - 21) / 87);
  const peak = 0.1 * velocity;
  gain.gain.setValueAtTime(0, when);
  gain.gain.linearRampToValueAtTime(peak, when + 0.004);
  gain.gain.exponentialRampToValueAtTime(peak * 0.5, when + 0.1);
  gain.gain.exponentialRampToValueAtTime(0.00001, when + decay);
  for (let h = 1; h <= 8; h++) {
    const f = frequency * h * Math.sqrt(1 + 0.000025 * h * h);
    if (f > ctx.sampleRate * 0.45) break;
    // two strings per note, a hair apart: the slow beating that makes a real piano shimmer
    for (const detune of h === 1 ? [-1.2, 1.2] : [0]) {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = 'sine';
      o.frequency.value = f;
      o.detune.value = detune;
      const amp = (h === 1 ? 0.6 : 0.56 / h ** 1.6) * (h > 3 ? velocity : 1);
      g.gain.setValueAtTime(amp, when);
      g.gain.exponentialRampToValueAtTime(0.00001, when + decay / (1 + (h - 1) * 0.48));
      o.connect(g);
      g.connect(gain);
      o.start(when);
      o.stop(when + decay + 0.05);
      oscillators.push(o);
      o.onended = () => { o.disconnect(); g.disconnect(); };
    }
  }
  // the hammer: a few milliseconds of filtered noise, brighter when struck harder
  const knockLen = Math.floor(ctx.sampleRate * 0.03);
  const noise = ctx.createBuffer(1, knockLen, ctx.sampleRate);
  const nd = noise.getChannelData(0);
  for (let i = 0; i < knockLen; i++) nd[i] = (Math.random() * 2 - 1) * (1 - i / knockLen) ** 3;
  const knock = ctx.createBufferSource();
  knock.buffer = noise;
  const bp = ctx.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.value = Math.min(6000, frequency * 3);
  bp.Q.value = 1.4;
  const kg = ctx.createGain();
  kg.gain.value = 0.05 * velocity * velocity;
  knock.connect(bp); bp.connect(kg); kg.connect(destination);
  knock.start(when);
  knock.onended = () => { knock.disconnect(); bp.disconnect(); kg.disconnect(); };

  const release = (time: number) => {
    gain.gain.cancelAndHoldAtTime(time);
    gain.gain.setTargetAtTime(0.00001, time, 0.055);
    for (const o of oscillators) { try { o.stop(time + 0.35); } catch { /* already stopped */ } }
    setTimeout(() => gain.disconnect(), Math.max(0, (time - ctx.currentTime + 0.5) * 1000));
  };
  return { release, ends: when + decay };
}

export class PianoAudio {
  ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private voices = new Map<number, Voice>();
  volume = 0.7;
  sustain = false;
  private nextID = 0;

  async unlock() {
    if (!this.ctx) {
      const ctx = new AudioContext({ latencyHint: 'interactive' });
      this.ctx = ctx;
      this.master = ctx.createGain();
      this.master.gain.value = this.volume;
      const compressor = ctx.createDynamicsCompressor();
      compressor.threshold.value = -15; compressor.ratio.value = 5; compressor.knee.value = 12;
      const dry = ctx.createGain(), wet = ctx.createGain(), hall = ctx.createConvolver();
      dry.gain.value = 0.82; wet.gain.value = 0.32;
      hall.buffer = hallImpulse(ctx);
      this.master.connect(dry); this.master.connect(hall); hall.connect(wet);
      dry.connect(compressor); wet.connect(compressor);
      compressor.connect(ctx.destination);
    }
    await this.ctx.resume();
    if (this.ctx.state !== 'running') throw new Error('轻触一下琴室，声音才能打开');
    return true;
  }

  get unlocked() { return this.ctx?.state === 'running'; }

  noteOn(midi: number, velocity = 0.75) {
    if (!this.ctx || this.ctx.state !== 'running' || !this.master) throw new Error('AUDIO_LOCKED');
    const now = this.ctx.currentTime;
    for (const [id, v] of this.voices) if (v.ends < now) this.voices.delete(id);
    while (this.voices.size >= 96) {
      const [id, v] = this.voices.entries().next().value as [number, Voice];
      v.release(now);
      this.voices.delete(id);
    }
    const id = ++this.nextID;
    const v = createVoice(this.ctx, this.master, midi, velocity, now);
    this.voices.set(id, { ...v, midi, held: true });
    return id;
  }

  noteOff(id: number) {
    const v = this.voices.get(id);
    if (!v || !this.ctx) return;
    v.held = false;
    if (!this.sustain) { v.release(this.ctx.currentTime); this.voices.delete(id); }
  }

  setSustain(down: boolean) {
    this.sustain = Boolean(down);
    if (!down && this.ctx) for (const [id, v] of this.voices) if (!v.held) { v.release(this.ctx.currentTime); this.voices.delete(id); }
  }

  setVolume(v: number) {
    this.volume = v;
    if (this.master && this.ctx) this.master.gain.setTargetAtTime(v, this.ctx.currentTime, 0.02);
  }

  stop() {
    if (this.ctx) for (const v of this.voices.values()) v.release(this.ctx.currentTime);
    this.voices.clear();
    this.setSustain(false);
  }

  close() {
    this.stop();
    void this.ctx?.close();
    this.ctx = null;
  }
}
