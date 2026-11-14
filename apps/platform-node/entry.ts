import { serve, upgradeWebSocket } from '@hono/node-server';
import { WebSocketServer } from 'ws';

import { bootstrapNodePlatform } from './src/bootstrap.ts';
import { applyMigrations } from './src/migrate.ts';
import { startScheduledMaintenance } from './src/scheduled-maintenance.ts';
import { createNodeFetchHandler, nodeWebDistDir } from './src/static-web.ts';
import {
  app,
  handleExecutionRequest,
  initBackgroundSchedulerResolver,
  initExecutionCellNamespace,
  initRepo,
  initOpenAIResponsesWebSocketUpgradeResolver,
  runScheduledMaintenance,
  SqlRepo,
} from '@floway-dev/gateway';
import { getEnvOptional, InProcessExecutionCellNamespace } from '@floway-dev/platform';

// In Node we don't have Workers' executionCtx.waitUntil — there's no request
// lifecycle to attach background work to — so the resolver fire-and-forgets
// the promise. Logging the rejection here is the only signal we get; without
// it a swallowed background failure would be silent.
initBackgroundSchedulerResolver(_c => promise => {
  promise.catch(err => console.error('[background]', err));
});

initOpenAIResponsesWebSocketUpgradeResolver((c, events) =>
  upgradeWebSocket(c, events, { onError: err => console.error('[websocket]', err) }));

const { db } = bootstrapNodePlatform();
const port = Number(getEnvOptional('PORT', '8788'));
const scheduledRuntimeLocation = getEnvOptional('RUNTIME_LOCATION', 'LOCAL').toUpperCase() || 'LOCAL';
const hostname = getEnvOptional('HOST', '127.0.0.1');
const fetch = createNodeFetchHandler(app.fetch, { distDir: nodeWebDistDir() });

// Passwordless admin login is a dev-only shortcut (empty ADMIN_KEY on a
// local instance grants seed-admin access). Refuse to boot the Node
// target under NODE_ENV=production without ADMIN_KEY so misconfiguration
// surfaces at start, not at first login. The Cloudflare side gates the
// same combination per-request via isProductionRequest.
if (process.env.NODE_ENV === 'production' && !process.env.ADMIN_KEY) {
  console.error('FATAL: NODE_ENV=production requires ADMIN_KEY. Passwordless admin login is only allowed on dev instances.');
  process.exit(1);
}

await applyMigrations(db);
initRepo(new SqlRepo(db));
initExecutionCellNamespace(new InProcessExecutionCellNamespace(handleExecutionRequest));

const scheduleBackground = (promise: Promise<unknown>): void => {
  promise.catch(err => console.error('[scheduled-maintenance background]', err));
};
startScheduledMaintenance(() => runScheduledMaintenance(scheduledRuntimeLocation, scheduleBackground));

serve({
  fetch,
  hostname,
  port,
  websocket: { server: new WebSocketServer({ noServer: true }) },
}, info => {
  console.log(`Floway listening on http://localhost:${info.port}`);
});
