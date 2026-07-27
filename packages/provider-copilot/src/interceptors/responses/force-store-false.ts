import type { ResponsesBoundaryCtx } from './types.ts';

/**
 * Copilot's `/responses` rejects `store: true` with
 * `400 {"error":{"message":"store is not supported","code":"unsupported_value","param":"store"}}`.
 * Force `store: false` on the outgoing payload once planning has committed to
 * the Copilot Responses target so the upstream accepts the request. The
 * gateway's own stored-items persistence keys off the caller's original `store`
 * value captured at parse time and is unaffected by this upstream-only flag.
 *
 * Generic in the run-result type so the same definition feeds both the
 * streaming `/responses` chain and the non-streaming compaction chain — the
 * synth-via-trigger compact call also rejects `store: true`.
 */
export const withStoreForcedFalse = async <TResult>(
  ctx: ResponsesBoundaryCtx,
  _env: object,
  run: () => Promise<TResult>,
): Promise<TResult> => {
  ctx.payload = { ...ctx.payload, store: false };

  return await run();
};
