// Hand-rolled ambient declaration for the subset of `cloudflare:workers` used
// by the Cloudflare composition root; the workspace intentionally does not
// depend on the full `@cloudflare/workers-types` (sibling files follow the
// same pattern for `cloudflare:sockets` and the WebSocket surface).
//
// Production code at `apps/platform-cloudflare/src/execution-do.ts`
// does `import { DurableObject } from 'cloudflare:workers'` so the CF runtime
// recognizes the subclass as a Durable Object; tests resolve
// the same import through `__tests__/test-utils/cloudflare-workers-stub.ts`
// via the alias in `apps/platform-cloudflare/vitest.config.ts`.

declare module 'cloudflare:workers' {
  // The runtime stores `(ctx, env)` on `this` for us; we
  // declare them as `protected` so the actor body can read `this.ctx`.
  export abstract class DurableObject<Env = unknown> {
    protected ctx: DurableObjectState;
    protected env: Env;
    constructor(ctx: DurableObjectState, env: Env);
  }

  export abstract class WorkerEntrypoint<Env = unknown> {
    protected env: Env;
  }
}

// The runtime surface used for hibernatable WebSockets and the loopback
// WorkerEntrypoint that executes database-owning operations outside the DO.
interface DurableObjectState {
  readonly exports: {
    readonly ExecutionOperationEntrypoint: {
      fetch(request: Request): Promise<Response>;
    };
  };
  acceptWebSocket(server: WebSocket): void;
  getWebSockets(): WebSocket[];
}

// Cloudflare extends Web Crypto with a constant-time comparison primitive.
// https://developers.cloudflare.com/workers/runtime-apis/web-crypto/#timingsafeequal
interface SubtleCrypto {
  timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean;
}
