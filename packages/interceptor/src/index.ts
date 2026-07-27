// Interceptors wrap a single typed call. Each interceptor receives the call's
// own invocation state, the ambient environment around it, and a `run` to
// delegate to the next interceptor (the innermost run executes the call
// itself). Interceptors may inspect or mutate that invocation state before
// `run`, await `run` and transform the result, short-circuit by returning
// without calling `run`, or retry by invoking `run` again. The shape is
// intentionally generic in Ctx/Env/Result so it works for any kind of call —
// provider-side wire shaping, source-side translation, retry policy — wired by
// the caller into concrete chains.
//
// `Ctx` carries the call itself — payload, headers, chosen target — and is the
// slot interceptors write to. `Env` carries what surrounds the call and does
// not belong to it: the gateway's chat chains pass the request-scoped gateway
// context there, while the provider-boundary chains have nothing ambient to
// hand down and pass `{}`.
//
// ## Mutation convention
//
// Mutations applied to `ctx` or `env` before `run()` propagate forward through
// every downstream interceptor and into the terminal call. They are **one-way**:
// the interceptor that wrote a field does not restore it on the way out, and
// the framework does not snapshot/rewind state for it. Whatever consumes the
// chain's output post-run (the caller that invoked `runInterceptors`, an outer
// interceptor's after-`run()` code) must keep its own captured copy of any input
// it still needs.
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
export type Interceptor<Ctx, Env, Result> = (ctx: Ctx, env: Env, run: InterceptorRun<Result>) => Promise<Result>;

export const runInterceptors = async <Ctx, Env, Result>(
  ctx: Ctx,
  env: Env,
  interceptors: readonly Interceptor<Ctx, Env, Result>[],
  terminal: InterceptorRun<Result>,
): Promise<Result> => {
  const run = (index: number): Promise<Result> => (index < interceptors.length ? interceptors[index](ctx, env, () => run(index + 1)) : terminal());
  return await run(0);
};
