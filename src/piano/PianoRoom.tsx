import { useCallback, useEffect, useRef, useState } from 'react';
import { PianoAudio } from './audio';
import { PianoPlayer, type PlayerState } from './player';
import { DEMOS, type Score } from './score';
import type { PianoStage } from './pianoStage';
import './piano-room.css';

// 琴室: a grand piano alone on a dark stage under one spotlight (pianoStage.ts). The page is almost only the stage: a back
// button, the room's name, what is playing with a thin gold line of progress, and one gold button that brings the
// panel up (what was played, the pieces, tempo, volume, the lid, the view, playing by hand). When the AI plays (its
// piano tool, server/mcp.ts or the HTTP API) the piece arrives on /api/updates and starts at once, keys moving; if the
// sound is still locked (browsers need a first tap) a quiet 轻触聆听 waits for her. Classes carry the pr- prefix.

type Performance = { id: string; by: 'ai' | 'user'; via?: 'hand' | 'qwen'; title: string; note: string; createdAt: string; score: Score };
/** Who the piece came from, for the programme line. */
const byLine = (p: Performance) => (p.by === 'user' ? '你点的' : p.via === 'qwen' ? 'AI 为你点的' : 'AI 为你弹奏');
type Now = { title: string; by: string; note?: string };

const WHITE_KEYS = 'ASDFGHJKL';
const BLACK_KEYS: Record<string, number> = { W: 1, E: 3, T: 6, Y: 8, U: 10, O: 13, P: 15 };
const WHITE_STEPS = [0, 2, 4, 5, 7, 9, 11, 12, 14];
const mmss = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const dateLabel = (iso: string) => { const d = new Date(iso); return `${d.getMonth() + 1}月${d.getDate()}日`; };

export default function PianoRoom({ onBack }: { onBack: () => void }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<PianoStage | null>(null);
  const audioRef = useRef(new PianoAudio());
  const playerRef = useRef<PianoPlayer | null>(null);
  const [ready, setReady] = useState(false);
  const [state, setState] = useState<PlayerState | null>(null);
  const [now, setNow] = useState<Now | null>(null);
  const [panel, setPanel] = useState(false);
  const [hands, setHands] = useState(false);
  const [octave, setOctave] = useState(4);
  const [sustain, setSustain] = useState(false);
  const [view, setView] = useState<'hero' | 'keys'>('hero');
  const [lid, setLid] = useState(true);
  const [mine, setMine] = useState<Performance[]>([]);
  const [waiting, setWaiting] = useState<Performance | null>(null);
  const handHeld = useRef(new Map<string, number>());
  const [ask, setAsk] = useState('');
  const [asking, setAsking] = useState(false);
  const [askNote, setAskNote] = useState('');

  // the stage and the performer
  useEffect(() => {
    let alive = true;
    let stage: PianoStage | null = null;
    void import('./pianoStage').then(({ PianoStage: Stage }) => {
      if (!alive || !hostRef.current) return;
      stage = new Stage(hostRef.current);
      stageRef.current = stage;
      const player = new PianoPlayer(audioRef.current, (midi, down, velocity) => stage?.setKey(midi, down, velocity));
      playerRef.current = player;
      const sync = () => setState(player.getState());
      for (const ev of ['loaded', 'state', 'ended']) player.addEventListener(ev, sync);
      setReady(true);
    });
    return () => {
      alive = false;
      playerRef.current?.destroy();
      audioRef.current.close();
      stage?.dispose();
      stageRef.current = null;
    };
  }, []);

  // progress, a few times a second while playing
  useEffect(() => {
    if (state?.state !== 'playing') return;
    const t = window.setInterval(() => playerRef.current && setState(playerRef.current.getState()), 250);
    return () => window.clearInterval(t);
  }, [state?.state]);

  // the browser pauses sound when the page is hidden: pause with it
  useEffect(() => {
    const hide = () => { if (document.visibilityState !== 'visible') playerRef.current?.pause(); };
    document.addEventListener('visibilitychange', hide);
    return () => document.removeEventListener('visibilitychange', hide);
  }, []);

  const perform = useCallback(async (score: Score, who: Now) => {
    const player = playerRef.current;
    if (!player) return;
    player.loadScore(score);
    setNow(who);
    if (!audioRef.current.unlocked) return false;
    await player.play();
    return true;
  }, []);

  // what he played before, and what he plays now
  useEffect(() => {
    if (!ready) return;
    void fetch('/api/piano').then((r) => r.json()).then((b) => setMine(b?.performances ?? [])).catch(() => undefined);
    if (typeof EventSource === 'undefined') return;
    const es = new EventSource('/api/updates');
    es.addEventListener('piano', (event) => {
      try {
        const p = JSON.parse((event as MessageEvent<string>).data)?.performance as Performance | undefined;
        if (!p) return;
        setMine((list) => [p, ...list.filter((x) => x.id !== p.id)]);
        void perform(p.score, { title: p.title, by: byLine(p), note: p.note }).then((played) => { if (!played) setWaiting(p); });
      } catch { /* a broken event: the list on the next open will have it */ }
    });
    return () => es.close();
  }, [ready, perform]);

  const listen = async () => {
    await audioRef.current.unlock().catch(() => undefined);
    setWaiting(null);
    await playerRef.current?.play().catch(() => undefined);
  };

  const toggle = async () => {
    const player = playerRef.current;
    if (!player) return;
    if (player.state === 'playing') player.pause();
    else if (player.score) await player.play().catch(() => undefined);
    else await perform(DEMOS[0].score, { title: DEMOS[0].score.title, by: DEMOS[0].score.source });
  };

  // a tap on a key of the piano itself plays it
  useEffect(() => {
    const el = hostRef.current;
    if (!el || !ready) return;
    const held = new Map<number, number>();
    const down = async (e: PointerEvent) => {
      const midi = stageRef.current?.keyAt(e.clientX, e.clientY);
      if (midi == null) return;
      await audioRef.current.unlock().catch(() => undefined);
      if (!audioRef.current.unlocked || !playerRef.current) return;
      held.set(e.pointerId, playerRef.current.noteOn(midi, 0.72));
    };
    const up = (e: PointerEvent) => {
      const v = held.get(e.pointerId);
      if (v !== undefined) { playerRef.current?.noteOff(v); held.delete(e.pointerId); }
    };
    el.addEventListener('pointerdown', down);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
    return () => { el.removeEventListener('pointerdown', down); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', up); };
  }, [ready]);

  // playing by hand: the strip of keys, or the computer keyboard (A–L white, W E T Y U O P black, Z / X octave, space pedal)
  const handOn = useCallback(async (tag: string, midi: number) => {
    if (handHeld.current.has(tag)) return;
    await audioRef.current.unlock().catch(() => undefined);
    if (!audioRef.current.unlocked || !playerRef.current || midi < 21 || midi > 108) return;
    handHeld.current.set(tag, playerRef.current.noteOn(midi, 0.75));
  }, []);
  const handOff = useCallback((tag: string) => {
    const v = handHeld.current.get(tag);
    if (v !== undefined) { playerRef.current?.noteOff(v); handHeld.current.delete(tag); }
  }, []);
  useEffect(() => {
    if (!hands) return;
    const base = (octave + 1) * 12;
    const keyDown = (e: KeyboardEvent) => {
      if (e.repeat || (e.target as HTMLElement)?.closest('input,textarea')) return;
      const k = e.key.toUpperCase();
      if (k === 'Z') setOctave((o) => Math.max(1, o - 1));
      else if (k === 'X') setOctave((o) => Math.min(6, o + 1));
      else if (k === ' ') { e.preventDefault(); setSustain(true); playerRef.current?.setSustain(true); }
      else if (WHITE_KEYS.includes(k)) void handOn(`k${k}`, base + WHITE_STEPS[WHITE_KEYS.indexOf(k)]);
      else if (k in BLACK_KEYS) void handOn(`k${k}`, base + BLACK_KEYS[k]);
    };
    const keyUp = (e: KeyboardEvent) => {
      const k = e.key.toUpperCase();
      if (k === ' ') { setSustain(false); playerRef.current?.setSustain(false); }
      else handOff(`k${k}`);
    };
    window.addEventListener('keydown', keyDown);
    window.addEventListener('keyup', keyUp);
    return () => { window.removeEventListener('keydown', keyDown); window.removeEventListener('keyup', keyUp); };
  }, [hands, octave, handOn, handOff]);

  const playing = state?.state === 'playing';
  const progress = state && state.duration ? Math.min(1, state.position / state.duration) : 0;
  const stripStart = (octave + 1) * 12;
  const stripWhites: number[] = [];
  for (let m = stripStart; m < stripStart + 25; m++) if (![1, 3, 6, 8, 10].includes(m % 12)) stripWhites.push(m);

  return (
    <div className="pr-page">
      <div ref={hostRef} className="pr-stage" />
      {!ready && <p className="pr-loading">灯光正在亮起</p>}

      <header className="pr-top">
        <button type="button" className="pr-ring" onClick={onBack} aria-label="返回">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 5l-7 7 7 7" /></svg>
        </button>
        <div className="pr-title"><b>琴 室</b><small>Le Salon</small></div>
        <span className="pr-ring pr-ring--ghost" aria-hidden="true" />
      </header>

      {now && (
        <section className={`pr-now${panel || hands ? ' is-raised' : ''}`} aria-live="polite">
          <small>{now.by}</small>
          <b>{now.title}</b>
          {now.note && <p>{now.note}</p>}
          <div className="pr-line"><i style={{ width: `${progress * 100}%` }} /></div>
          <div className="pr-now-row">
            <span>{mmss(state?.position ?? 0)}</span>
            <button type="button" className="pr-play" onClick={() => void toggle()} aria-label={playing ? '暂停' : '播放'}>
              {playing ? <svg viewBox="0 0 24 24"><path d="M8 5h3v14H8zM13 5h3v14h-3z" /></svg> : <svg viewBox="0 0 24 24"><path d="M8 5l11 7-11 7z" /></svg>}
            </button>
            <span>{mmss(state?.duration ?? 0)}</span>
          </div>
        </section>
      )}

      {waiting && (
        <button type="button" className="pr-listen" onClick={() => void listen()}>
          <span>{waiting.title}</span>
          <b>轻触 · 聆听</b>
        </button>
      )}

      <button type="button" className={`pr-fab${panel ? ' is-on' : ''}`} onClick={() => setPanel((p) => !p)} aria-label={panel ? '收起' : '曲目与控制'}>
        {panel ? <svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18" /></svg> : <svg viewBox="0 0 24 24"><path d="M9 18V6l10-2v12" /><circle cx="6.5" cy="18" r="2.5" /><circle cx="16.5" cy="16" r="2.5" /></svg>}
      </button>

      <aside className={`pr-sheet${panel ? ' is-open' : ''}`} aria-hidden={!panel}>
        <form className="pr-ask" onSubmit={(e) => {
          e.preventDefault();
          const song = ask.trim();
          if (!song || asking) return;
          setAsking(true); setAskNote('Qwen 正在找谱…');
          void audioRef.current.unlock().catch(() => undefined);
          void fetch('/api/piano/request', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ song }) })
            .then(async (r) => { const b = await r.json().catch(() => null); if (!r.ok) throw new Error(b?.error ?? '没找到'); setAsk(''); setAskNote(''); })
            .catch((err: Error) => setAskNote(err.message))
            .finally(() => setAsking(false));
        }}>
          <input value={ask} onChange={(e) => setAsk(e.target.value)} placeholder="点一首歌" aria-label="点一首歌" enterKeyHint="search" />
          <button type="submit" disabled={asking || !ask.trim()}>{asking ? '…' : '点歌'}</button>
        </form>
        {askNote && <p className="pr-ask-note">{askNote}</p>}
        {mine.length > 0 && (
          <>
            <h2>弹过的</h2>
            <ul>
              {mine.slice(0, 12).map((p) => (
                <li key={p.id}>
                  <button type="button" onClick={() => { void perform(p.score, { title: p.title, by: byLine(p), note: p.note }).then((ok) => { if (!ok) setWaiting(p); }); }}>
                    <b>{p.title}</b>
                    <small>{byLine(p)} · {dateLabel(p.createdAt)}{p.note ? ` · ${p.note}` : ''}</small>
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
        <h2>曲目</h2>
        <ul>
          {DEMOS.map((d) => (
            <li key={d.id}>
              <button type="button" onClick={() => { void audioRef.current.unlock().catch(() => undefined).then(() => perform(d.score, { title: d.score.title, by: d.score.source })); }}>
                <b>{d.score.title}</b><small>{d.score.source}</small>
              </button>
            </li>
          ))}
        </ul>
        <div className="pr-controls">
          <label className="pr-tempo">
            <span>速度</span>
            <button type="button" onClick={() => void playerRef.current?.setTempo(Math.round(((state?.tempo ?? 1) - 0.1) * 10) / 10).then(setState)} aria-label="慢一点">−</button>
            <em>{(state?.tempo ?? 1).toFixed(1)}×</em>
            <button type="button" onClick={() => void playerRef.current?.setTempo(Math.round(((state?.tempo ?? 1) + 0.1) * 10) / 10).then(setState)} aria-label="快一点">+</button>
          </label>
          <label className="pr-volume"><span>音量</span><input type="range" min={0} max={100} defaultValue={70} onChange={(e) => playerRef.current?.setVolume(Number(e.target.value) / 100)} /></label>
        </div>
        <div className="pr-chips">
          <button type="button" className={view === 'keys' ? 'is-on' : ''} onClick={() => { const v = view === 'keys' ? 'hero' : 'keys'; setView(v); stageRef.current?.view(v); }}>{view === 'keys' ? '全景' : '看琴键'}</button>
          <button type="button" className={lid ? '' : 'is-on'} onClick={() => setLid(stageRef.current?.toggleLid() ?? true)}>{lid ? '合上琴盖' : '打开琴盖'}</button>
          <button type="button" className={hands ? 'is-on' : ''} onClick={() => { setHands((h) => !h); setPanel(false); }}>{hands ? '收起琴键' : '亲手弹'}</button>
          <button type="button" onClick={() => { playerRef.current?.stop(); setNow(null); }}>停止</button>
        </div>
      </aside>

      {hands && (
        <div className="pr-hands" onContextMenu={(e) => e.preventDefault()}>
          <div className="pr-hands-bar">
            <button type="button" onClick={() => setOctave((o) => Math.max(1, o - 1))} aria-label="低八度">‹</button>
            <span>C{octave} – C{octave + 2}</span>
            <button type="button" onClick={() => setOctave((o) => Math.min(6, o + 1))} aria-label="高八度">›</button>
            <button type="button" className={`pr-pedal${sustain ? ' is-on' : ''}`} onPointerDown={() => { setSustain(true); playerRef.current?.setSustain(true); }} onPointerUp={() => { setSustain(false); playerRef.current?.setSustain(false); }} onPointerLeave={() => { if (sustain) { setSustain(false); playerRef.current?.setSustain(false); } }}>延音</button>
            <button type="button" onClick={() => setHands(false)} aria-label="收起琴键">×</button>
          </div>
          <div className="pr-keys">
            {stripWhites.map((m, i) => (
              <button
                key={m}
                type="button"
                className="pr-white"
                style={{ left: `${(i / stripWhites.length) * 100}%`, width: `${100 / stripWhites.length}%` }}
                onPointerDown={(e) => { (e.target as HTMLElement).setPointerCapture(e.pointerId); void handOn(`p${e.pointerId}`, m); }}
                onPointerUp={(e) => handOff(`p${e.pointerId}`)}
                onPointerCancel={(e) => handOff(`p${e.pointerId}`)}
                aria-label={`${m}`}
              />
            ))}
            {stripWhites.slice(0, -1).map((m, i) => ([1, 3, 6, 8, 10].includes((m + 1) % 12) ? (
              <button
                key={`b${m}`}
                type="button"
                className="pr-black"
                style={{ left: `${((i + 1) / stripWhites.length) * 100}%` }}
                onPointerDown={(e) => { e.stopPropagation(); (e.target as HTMLElement).setPointerCapture(e.pointerId); void handOn(`p${e.pointerId}`, m + 1); }}
                onPointerUp={(e) => handOff(`p${e.pointerId}`)}
                onPointerCancel={(e) => handOff(`p${e.pointerId}`)}
                aria-label={`${m + 1}`}
              />
            ) : null))}
          </div>
        </div>
      )}
    </div>
  );
}
