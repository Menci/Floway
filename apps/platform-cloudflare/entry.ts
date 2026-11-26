import type { ExecutionContext } from 'hono';

import { bootstrapCloudflarePlatform, type CloudflareEnv } from './src/bootstrap.ts';
import {
  app,
  initBackgroundSchedulerResolver,
  initRepo,
  runScheduledMaintenance,
  SqlRepo,
} from '@floway-dev/gateway';

// Re-exported here because the current binding and the rename migration's
// target resolve the class by its Worker-module export name.
export { ExecutionDO } from './src/execution-do.ts';

initBackgroundSchedulerResolver(c => promise => {
  c.executionCtx.waitUntil(promise.catch(error => console.error('[background]', error)));
});

export default {
  fetch(req: Request, env: CloudflareEnv, ctx: ExecutionContext) {
    const { db } = bootstrapCloudflarePlatform(env);
    initRepo(new SqlRepo(db));
    return app.fetch(req, env, ctx);
  },
  scheduled(_controller: unknown, env: CloudflareEnv, ctx: ExecutionContext) {
    const { db } = bootstrapCloudflarePlatform(env);
    initRepo(new SqlRepo(db));
    ctx.waitUntil(runScheduledMaintenance(null, promise => ctx.waitUntil(promise)));
  },
};
