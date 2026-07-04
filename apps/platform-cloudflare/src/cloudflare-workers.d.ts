// Hand-rolled ambient declaration for the subset of `cloudflare:workers` that
// `BroadcastDO` reaches for at runtime; the workspace intentionally does not
// depend on the full `@cloudflare/workers-types` (sibling files follow the
// same pattern for `cloudflare:sockets` and the WebSocket surface).
//
// Production code at `apps/platform-cloudflare/src/broadcast-do.ts`
// does `import { DurableObject } from 'cloudflare:workers'` so the CF runtime
// gates RPC dispatch on the subclass extending this base; the tests resolve
// the same import through `test/cloudflare-workers-stub.ts` via the vitest
// alias in `apps/platform-cloudflare/vitest.config.ts`.

declare module 'cloudflare:workers' {
  // The base class's only role for our actor is to mark the subclass as
  // RPC-eligible. The runtime stores `(ctx, env)` on `this` for us; we
  // declare them as `protected` so the actor body can read `this.ctx`.
  export abstract class DurableObject<Env = unknown> {
    protected ctx: DurableObjectState;
    protected env: Env;
    constructor(ctx: DurableObjectState, env: Env);
  }
}

// The runtime's `DurableObjectState` surface the actor touches — the
// WebSocket Hibernation entry points and the alarm scheduler (used by
// DurableHttpSessionDO for idle eviction).
interface DurableObjectState {
  acceptWebSocket(server: WebSocket): void;
  getWebSockets(): WebSocket[];
  storage: {
    setAlarm(scheduledTime: number): Promise<void>;
    deleteAlarm(): Promise<void>;
  };
}
