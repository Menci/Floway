import { serve, upgradeWebSocket } from '@hono/node-server';
import { setGlobalDispatcher } from 'undici';
import { WebSocketServer } from 'ws';

import { bootstrapNodePlatform } from './src/bootstrap.ts';
import { parseNodeListenPort } from './src/config.ts';
import { createNodeGlobalDispatcher } from './src/global-dispatcher.ts';
import { applyMigrations } from './src/migrate.ts';
import {
  app,
  initBackgroundSchedulerResolver,
  initRepo,
  initResponsesWebSocketUpgradeResolver,
  runScheduledMaintenance,
  SqlRepo,
} from '@floway-dev/gateway';
import { getEnvOptional } from '@floway-dev/platform';

setGlobalDispatcher(createNodeGlobalDispatcher());

// In Node we don't have Workers' executionCtx.waitUntil — there's no request
// lifecycle to attach background work to — so the resolver fire-and-forgets
// the promise. Logging the rejection here is the only signal we get; without
// it a swallowed background failure would be silent.
initBackgroundSchedulerResolver(_c => promise => {
  promise.catch(err => console.error('[background]', err));
});

initResponsesWebSocketUpgradeResolver((c, events) =>
  upgradeWebSocket(c, events, { onError: err => console.error('[websocket]', err) }));

const { db } = bootstrapNodePlatform();
const port = parseNodeListenPort(getEnvOptional('PORT', '8788'));

// Passwordless admin login is a dev-only shortcut (empty ADMIN_KEY on a
// local instance grants seed-admin access). Refuse to boot the Node
// target under NODE_ENV=production without ADMIN_KEY so misconfiguration
// surfaces at start, not at first login. The Cloudflare side gates the
// same combination per-request via isProductionRequest.
if (process.env.NODE_ENV === 'production' && !process.env.ADMIN_KEY) {
  console.error('FATAL: NODE_ENV=production requires ADMIN_KEY. Passwordless admin login is only allowed on dev instances.');
  process.exit(1);
}

const SCHEDULED_INTERVAL_MS = 60 * 60 * 1000;

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
  runScheduledMaintenance().catch(err => {
    console.error('[scheduled-maintenance] sweep failed:', err);
  });
};
setTimeout(sweep, STARTUP_DELAY_MS).unref();
setInterval(sweep, SCHEDULED_INTERVAL_MS).unref();

serve({
  fetch: app.fetch,
  port,
  websocket: { server: new WebSocketServer({ noServer: true }) },
}, info => {
  console.log(`Floway listening on http://localhost:${info.port}`);
});
