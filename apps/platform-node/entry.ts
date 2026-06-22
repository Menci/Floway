import { serve, upgradeWebSocket } from '@hono/node-server';
import { Agent, Pool, setGlobalDispatcher } from 'undici';
import { WebSocketServer } from 'ws';

// api.{individual,business,enterprise}.githubcopilot.com closes its
// keep-alive socket immediately after each response. When undici's default
// pool reuses that socket for the next POST, the race surfaces as either
// UND_ERR_SOCKET (close lands before the next write) or
// RequestContentLengthMismatchError (close lands mid-write — see client-h1.js
// L1340 in undici v6, where bytesWritten < contentLength because the socket
// was destroyed while the body was still being streamed). Disabling HTTP/1.1
// connection reuse for these hosts removes the race.
//
// `pipelining: 0` is the actual lever per undici's Client docs: "Set to `0`
// to disable keep-alive connections." The Agent factory restricts the
// override to the three Copilot data-plane origins so OpenAI, Azure,
// Gemini, custom OpenAI-compatible, Ollama, GitHub OAuth, and the Codex
// catalog endpoint all keep undici's default keep-alive behaviour and don't
// pay an extra TCP+TLS handshake per request.
//
// Refs: https://github.com/nodejs/undici/blob/main/docs/docs/api/Client.md
//       https://github.com/Menci/Floway/pull/78#issuecomment-4765475966
const COPILOT_HOSTS = new Set([
  'api.individual.githubcopilot.com',
  'api.business.githubcopilot.com',
  'api.enterprise.githubcopilot.com',
]);
setGlobalDispatcher(new Agent({
  factory: (origin, opts) => {
    const hostname = typeof origin === 'string' ? new URL(origin).hostname : origin.hostname;
    return COPILOT_HOSTS.has(hostname) ? new Pool(origin, { ...opts, pipelining: 0 }) : new Pool(origin, opts);
  },
}));

import { bootstrapNodePlatform } from './src/bootstrap.ts';
import { applyMigrations } from './src/migrate.ts';
import {
  app,
  initBackgroundSchedulerResolver,
  initResponsesWebSocketUpgradeResolver,
  initRepo,
  runScheduledMaintenance,
  SqlRepo,
} from '@floway-dev/gateway';

// In Node we don't have Workers' executionCtx.waitUntil — there's no request
// lifecycle to attach background work to — so the resolver fire-and-forgets
// the promise. Logging the rejection here is the only signal we get; without
// it a swallowed background failure would be silent.
initBackgroundSchedulerResolver(_c => promise => {
  promise.catch(err => console.error('[background]', err));
});

initResponsesWebSocketUpgradeResolver((c, events) =>
  upgradeWebSocket(c, events, { onError: err => console.error('[websocket]', err) }));

const dbPath = process.env.FLOWAY_DB_PATH ?? './data/floway.db';
const filesDir = process.env.FLOWAY_FILES_DIR ?? './data/files';
const port = Number(process.env.PORT ?? 8788);

const SCHEDULED_INTERVAL_MS = 60 * 60 * 1000;

const { db } = bootstrapNodePlatform({ dbPath, filesDir });
await applyMigrations(db);
initRepo(new SqlRepo(db));

// Run the scheduled maintenance job once after a short startup delay and
// then every hour. Without the startup run, a process that restarts more
// often than the interval (crash loop, frequent deploys) would never run
// maintenance and the responses-items expiry sweep would silently lag. The
// 30s delay keeps the very first request after boot from racing the sweep.
// unref() on both timers lets the process exit cleanly on SIGINT.
const STARTUP_DELAY_MS = 30 * 1000;
const sweep = (): void => {
  runScheduledMaintenance().catch(err => console.error('[scheduled]', err));
};
setTimeout(sweep, STARTUP_DELAY_MS).unref();
setInterval(sweep, SCHEDULED_INTERVAL_MS).unref();

serve({
  fetch: app.fetch,
  port,
  websocket: { server: new WebSocketServer({ noServer: true }) },
}, info => {
  console.log(`floway listening on http://localhost:${info.port}`);
});
