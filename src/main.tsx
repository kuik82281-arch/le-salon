import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import PianoRoom from './piano/PianoRoom';
import { httpChatAdapter } from './piano/SalonChat';

// the online demo has no server: answer the piano's API in the browser
if (import.meta.env.VITE_DEMO) await import('./demo');

createRoot(document.getElementById('root')!).render(<StrictMode><PianoRoom onBack={() => history.back()} chat={httpChatAdapter('/api/chat', import.meta.env.VITE_CHAT_NAME ?? 'Chat')} /></StrictMode>);
