import { serve, upgradeWebSocket } from '@hono/node-server';
import { WebSocketServer } from 'ws';

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
