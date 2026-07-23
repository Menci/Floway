import type { ExecutionContext } from 'hono';

import { bootstrapCloudflarePlatform, type CloudflareEnv } from './src/bootstrap.ts';
import {
  app,
  initBackgroundSchedulerResolver,
  initRepo,
  runScheduledMaintenance,
  SqlRepo,
} from '@floway-dev/gateway';

// Re-exported here because the CF runtime resolves the DO class by its
// exported name on the Worker module. The wrangler `migrations.new_sqlite_classes`
// entry must match this export.
export { BroadcastDO } from './src/broadcast-do.ts';

initBackgroundSchedulerResolver(c => promise => c.executionCtx.waitUntil(promise));

export default {
  fetch(req: Request, env: CloudflareEnv, ctx: ExecutionContext) {
    const { db } = bootstrapCloudflarePlatform(env);
    initRepo(new SqlRepo(db));
    return app.fetch(req, env, ctx);
  },
  scheduled(_controller: unknown, env: CloudflareEnv, ctx: ExecutionContext) {
    const { db } = bootstrapCloudflarePlatform(env);
    initRepo(new SqlRepo(db));
    ctx.waitUntil(runScheduledMaintenance());
  },
};
