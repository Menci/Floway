import { WorkerEntrypoint } from 'cloudflare:workers';
import type { ExecutionContext } from 'hono';

import { bootstrapCloudflarePlatform, type CloudflareEnv } from './src/bootstrap.ts';
import {
  app,
  handleExecutionRequest,
  initBackgroundSchedulerResolver,
  initRepo,
  runScheduledMaintenance,
  SqlRepo,
} from '@floway-dev/gateway';

// Re-exported here because the current binding and the rename migration's
// target resolve the class by its Worker-module export name.
export { ExecutionDO } from './src/execution-do.ts';

export class ExecutionOperationEntrypoint extends WorkerEntrypoint<CloudflareEnv> {
  async fetch(request: Request): Promise<Response> {
    const { db } = bootstrapCloudflarePlatform(this.env);
    initRepo(new SqlRepo(db));
    return await handleExecutionRequest(request);
  }
}

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
    ctx.waitUntil(runScheduledMaintenance(null, promise => ctx.waitUntil(promise)));
  },
};
