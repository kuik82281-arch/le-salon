import { useEffect, useRef, useState } from 'react';

// A small chat window that floats over the room, so you can talk while the piano plays (or while you play it). It is an
// interface, not a chat of its own: the room shows it only when it is given an adapter, and the adapter decides who
// answers (an HTTP endpoint, a local model, anything). What is playing goes along with every message as context.
// Drag it by its title bar; fold it into a small gold bubble. Classes carry the pr- prefix.

export type SalonChatMessage = { role: 'user' | 'assistant'; content: string };
export type SalonChatContext = { playing?: string; by?: string };
export type SalonChatAdapter = {
  /** The window's title (who you are talking to). */
  name?: string;
  send: (messages: SalonChatMessage[], context: SalonChatContext) => Promise<string>;
};

/** POST {messages, context} to `url`, answered with {reply} (or {error}). */
export function httpChatAdapter(url = '/api/chat', name = 'Chat'): SalonChatAdapter {
  return {
    name,
    async send(messages, context) {
      const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ messages, context }) });
      const b = await r.json().catch(() => null);
      if (!r.ok || typeof b?.reply !== 'string') throw new Error(b?.error ?? `${r.status}`);
      return b.reply;
    },
  };
}

export default function SalonChat({ adapter, context }: { adapter: SalonChatAdapter; context: SalonChatContext }) {
  const [open, setOpen] = useState(true);
  const [messages, setMessages] = useState<SalonChatMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const boxRef = useRef<HTMLElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ dx: number; dy: number } | null>(null);

  useEffect(() => { listRef.current?.scrollTo({ top: listRef.current.scrollHeight }); }, [messages, busy, open]);

  const send = async () => {
    const text = draft.trim();
    if (!text || busy) return;
    const next = [...messages, { role: 'user' as const, content: text }];
    setMessages(next);
    setDraft('');
    setBusy(true);
    setError('');
    try {
      const reply = await adapter.send(next, context);
      setMessages((list) => [...list, { role: 'assistant', content: reply }]);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const onDown = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest('button')) return;
    const box = boxRef.current?.getBoundingClientRect();
    if (!box) return;
    drag.current = { dx: e.clientX - box.left, dy: e.clientY - box.top };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onMove = (e: React.PointerEvent) => {
    const d = drag.current;
    const box = boxRef.current;
    if (!d || !box) return;
    const x = Math.min(Math.max(0, e.clientX - d.dx), window.innerWidth - box.offsetWidth);
    const y = Math.min(Math.max(0, e.clientY - d.dy), window.innerHeight - 44);
    setPos({ x, y });
  };
  const onUp = () => { drag.current = null; };

  const place = pos ? { left: pos.x, top: pos.y, bottom: 'auto' } : undefined;

  if (!open) {
    return (
      <button type="button" className="pr-chat-bubble" style={place} onClick={() => setOpen(true)} aria-label={`打开和 ${adapter.name ?? 'Chat'} 的对话`}>
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h16v11H9l-5 4z" /></svg>
        {messages.length > 0 && <i />}
      </button>
    );
  }

  return (
    <section ref={boxRef} className="pr-chat" style={place} aria-label={`和 ${adapter.name ?? 'Chat'} 聊天`}>
      <header onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}>
        <b>{adapter.name ?? 'Chat'}</b>
        {context.playing && <small>♪ {context.playing}</small>}
        <button type="button" onClick={() => setOpen(false)} aria-label="收起">–</button>
      </header>
      <div ref={listRef} className="pr-chat-list">
        {messages.length === 0 && <p className="pr-chat-empty">边听边聊</p>}
        {messages.map((m, i) => <p key={i} className={`pr-chat-msg pr-chat-msg--${m.role}`}>{m.content}</p>)}
        {busy && <p className="pr-chat-msg pr-chat-msg--assistant pr-chat-typing">…</p>}
        {error && <p className="pr-chat-error">{error}</p>}
      </div>
      <form onSubmit={(e) => { e.preventDefault(); void send(); }}>
        <input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="说点什么" aria-label="消息" enterKeyHint="send" />
        <button type="submit" disabled={busy || !draft.trim()} aria-label="发送">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h13M13 6l6 6-6 6" /></svg>
        </button>
      </form>
    </section>
  );
}
