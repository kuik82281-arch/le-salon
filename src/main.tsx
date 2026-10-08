import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import PianoRoom from './piano/PianoRoom';

// the online demo has no server: answer the piano's API in the browser
if (import.meta.env.VITE_DEMO) await import('./demo');

createRoot(document.getElementById('root')!).render(<StrictMode><PianoRoom onBack={() => history.back()} /></StrictMode>);
