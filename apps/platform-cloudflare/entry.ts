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

const repos = new WeakMap<CloudflareEnv['DB'], SqlRepo>();

const initGateway = (env: CloudflareEnv): void => {
  const { db } = bootstrapCloudflarePlatform(env);
  let repo = repos.get(db);
  if (repo === undefined) {
    repo = new SqlRepo(db);
    repos.set(db, repo);
  }
  initRepo(repo);
};

export class ExecutionOperationEntrypoint extends WorkerEntrypoint<CloudflareEnv> {
  async fetch(request: Request): Promise<Response> {
    initGateway(this.env);
    return await handleExecutionRequest(request, promise => this.ctx.waitUntil(promise));
  }
}

initBackgroundSchedulerResolver(c => promise => c.executionCtx.waitUntil(promise));

export default {
  fetch(req: Request, env: CloudflareEnv, ctx: ExecutionContext) {
    initGateway(env);
    return app.fetch(req, env, ctx);
  },
  scheduled(_controller: unknown, env: CloudflareEnv, ctx: ExecutionContext) {
    initGateway(env);
    ctx.waitUntil(runScheduledMaintenance(null, promise => ctx.waitUntil(promise)));
  },
};
