// Vitest runs in Node, not workerd; the `cloudflare:workers` module the
// production runtime exposes is unresolvable here. We ship a minimal local
// stub that mirrors only what subclasses reach for at runtime: the
// `DurableObject` base class with a constructor that stores `ctx` and `env`
// on `this`. Tests instantiate actors by passing a fake state object
// directly, so the base class is intentionally a no-op constructor — the
// runtime's RPC-gating semantics are documented inline on each actor's
// `extends` declaration, not by anything this stub provides.

export class DurableObject<Env = unknown> {
  protected ctx: DurableObjectState;
  protected env: Env;
  constructor(ctx: DurableObjectState, env: Env) {
    this.ctx = ctx;
    this.env = env;
  }
}
