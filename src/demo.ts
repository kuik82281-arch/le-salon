// The online demo (GitHub Pages) has no server and no AI: the piano's API is answered in the browser. Nothing was
// played yet, asking for a song explains that it needs the server and a local Qwen, and the update stream is silent.
const realFetch = window.fetch.bind(window);
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, location.href);
  if (url.pathname.endsWith('/api/piano')) return json({ performances: [] });
  if (url.pathname.endsWith('/api/piano/request')) return json({ error: '试用页没有连服务器：点歌要在本地跑 npm run server，并装好 Ollama 的 qwen2.5:3b。' }, 400);
  return realFetch(input, init);
};

class SilentEventSource extends EventTarget {
  readyState = 1;
  close() { this.readyState = 2; }
}
(window as unknown as { EventSource: unknown }).EventSource = SilentEventSource;
export {};
