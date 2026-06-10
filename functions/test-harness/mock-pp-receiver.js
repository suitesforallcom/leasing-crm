// =========================================================================
// Mock PP-приёмник для эмуляторного E2E (local-only, в прод не деплоится).
// Поднимается in-process из run-e2e.js. Режимы ответа переключаются БЕЗ
// смены URL (runtime-конфиг вебхука кэшируется на 60s в functions-эмуляторе,
// менять url в _config посреди теста нельзя):
//   'ok'      → 200 {ok:true}
//   'fail500' → всегда 500
//   'flaky'   → 500 на первые 3 запроса после reset, дальше 200
// Каждый запрос пишется в received[]: {atMs, headers, rawBody}.
// =========================================================================
const http = require('node:http');

function createMockReceiver(port) {
  const received = [];
  const state = { mode: 'ok', flakyFails: 0 };
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const rawBody = Buffer.concat(chunks);
      if (req.url === '/hook' && req.method === 'POST') {
        received.push({ atMs: Date.now(), headers: { ...req.headers }, rawBody });
        if (state.mode === 'fail500') {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end('{"error":"simulated"}');
          return;
        }
        if (state.mode === 'flaky' && state.flakyFails < 3) {
          state.flakyFails++;
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end('{"error":"flaky"}');
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"ok":true}');
        return;
      }
      res.writeHead(404); res.end();
    });
  });
  return {
    received,
    setMode(mode) { state.mode = mode; state.flakyFails = 0; },
    start() { return new Promise((r) => server.listen(port, '127.0.0.1', r)); },
    stop() { return new Promise((r) => server.close(r)); },
  };
}

module.exports = { createMockReceiver };
