import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// `npm run dev` serves the page; the API runs alongside with `npm run server` (port 7532), proxied here.
export default defineConfig({
  plugins: [react()],
  server: { proxy: { '/api': 'http://localhost:7532' } },
});
