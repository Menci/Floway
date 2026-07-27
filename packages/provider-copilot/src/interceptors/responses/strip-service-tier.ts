import type { ResponsesBoundaryCtx } from './types.ts';

/**
 * Copilot does not expose a compatible `service_tier` control on native or
 * translated Responses handling. Strip it only after planning has committed to
 * the Responses target so source-side behavior and telemetry still see the
 * caller's original request. Generic in the run-result type so the same
 * definition feeds both the streaming `/responses` chain and the
 * non-streaming compaction chain.
 *
 * References:
 * - https://github.com/caozhiyuan/copilot-api/commit/f7835a44f06976cab874700e4d94a5f5c0379369
 * - https://platform.openai.com/docs/api-reference/responses/create
 */
export const withServiceTierStripped = async <TResult>(
  ctx: ResponsesBoundaryCtx,
  _env: object,
  run: () => Promise<TResult>,
): Promise<TResult> => {
  const { service_tier: _, ...payload } = ctx.payload;
  ctx.payload = payload;

  return await run();
};
