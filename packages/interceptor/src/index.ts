// Interceptors wrap a single typed call. Each interceptor receives the call's
// own invocation state and a `run` to delegate to the next interceptor (the
// innermost run executes the call itself). Interceptors may inspect or mutate
// that invocation state before `run`, await `run` and transform the result,
// short-circuit by returning without calling `run`, or retry by invoking `run`
// again. The shape is generic in Ctx/Result so it works for any kind of call,
// wired by the caller into concrete chains.
//
// `Ctx` carries the call itself — payload, headers, chosen target — and is the
// slot interceptors write to. There is no ambient second slot: every chain this
// runs is a provider boundary chain, and a boundary has nothing around the call
// to hand down.
//
// ## Mutation convention
//
// Mutations applied to `ctx` before `run()` propagate forward through every
// downstream interceptor and into the terminal call. They are **one-way**: the
// interceptor that wrote a field does not restore it on the way out, and the
// framework does not snapshot/rewind state for it. Whatever consumes the
// chain's output post-run (the caller that invoked `runInterceptors`, an outer
// interceptor's after-`run()` code) must keep its own captured copy of any input
// it still needs.
//
// This is a provider-boundary convention and not the gateway's: what a request
// travels in through the gateway is a fact record, which is frozen at every
// handover and rebuilt rather than written to. The two live side by side because
// they answer different questions — a boundary shapes one wire call it owns
// outright, a pipeline carries a turn nobody owns alone.
//
// The convention exists because partial adoption is the worst case: if some
// interceptors restore and others don't, there is no honest invariant the
// rest of the codebase can rely on — readers can no longer tell what `ctx`
// will look like at any given seam without auditing every interceptor in the
// chain. Forbidding restore everywhere is the only way to get a single
// predictable shape.
//
// The framework does not enforce this; reviewers do. A new interceptor that
// writes `ctx.foo = bar` in `try` and `ctx.foo = original` in `finally` is a
// convention violation, not a feature.
export type InterceptorRun<Result> = () => Promise<Result>;
export type Interceptor<Ctx, Result> = (ctx: Ctx, run: InterceptorRun<Result>) => Promise<Result>;

export const runInterceptors = async <Ctx, Result>(
  ctx: Ctx,
  interceptors: readonly Interceptor<Ctx, Result>[],
  terminal: InterceptorRun<Result>,
): Promise<Result> => {
  const run = (index: number): Promise<Result> => (index < interceptors.length ? interceptors[index](ctx, () => run(index + 1)) : terminal());
  return await run(0);
};
