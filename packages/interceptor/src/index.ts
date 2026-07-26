// Around-middleware for wrapping a single typed call. Each interceptor receives
// the call's context, the in-flight request, and a `run` to delegate to the
// next interceptor (the innermost run executes the call itself). Interceptors
// may inspect/mutate the request before `run`, await `run` and transform the
// result, short-circuit by returning without calling `run`, or retry by
// invoking `run` again. The shape is intentionally generic in Ctx/Req/Result so
// it works for any kind of call — provider-side wire shaping, source-side
// translation, retry policy — wired by the caller into concrete chains.
//
// ## Mutation convention
//
// Mutations applied to `ctx` or `request` before `run()` propagate forward
// through every downstream interceptor and into the terminal call. They are
// **one-way**: the interceptor that wrote a field does not restore it on the
// way out, and the framework does not snapshot/rewind state for it. Whatever
// consumes the chain's output post-run (the caller that invoked
// `runInterceptors`, an outer interceptor's after-`run()` code) must keep
// its own captured copy of any input it still needs.
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
export type Interceptor<Ctx, Req, Result> = (ctx: Ctx, request: Req, run: InterceptorRun<Result>) => Promise<Result>;

export const runInterceptors = async <Ctx, Req, Result>(
  ctx: Ctx,
  request: Req,
  interceptors: readonly Interceptor<Ctx, Req, Result>[],
  terminal: InterceptorRun<Result>,
): Promise<Result> => {
  const run = (index: number): Promise<Result> => (index < interceptors.length ? interceptors[index](ctx, request, () => run(index + 1)) : terminal());
  return await run(0);
};
