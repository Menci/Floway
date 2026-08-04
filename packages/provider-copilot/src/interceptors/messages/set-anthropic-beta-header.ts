import type { MessagesBoundaryCtx } from './types.ts';

const INTERLEAVED_THINKING_BETA = 'interleaved-thinking-2025-05-14';
const CONTEXT_MANAGEMENT_BETA = 'context-management-2025-06-27';

// Copilot receives an empty client-header bag. This is the sole writer of its
// Messages `anthropic-beta` header and derives both tokens from the final wire
// payload: non-adaptive budget thinking needs interleaved-thinking, while the
// `context_management` field is rejected unless its matching beta is present.
// https://github.com/caozhiyuan/copilot-api/blob/b2dbf9d57612bdf75e87f71993567bd5315b22b5/src/services/copilot/create-messages.ts
export const withAnthropicBetaHeaderSet = async <TResult>(
  ctx: MessagesBoundaryCtx,
  _env: object,
  run: () => Promise<TResult>,
): Promise<TResult> => {
  const betas: string[] = [];
  const isAdaptiveThinking = ctx.payload.thinking?.type === 'adaptive';
  if (ctx.payload.thinking?.budget_tokens && !isAdaptiveThinking) {
    betas.push(INTERLEAVED_THINKING_BETA);
  }

  const payload = ctx.payload as typeof ctx.payload & { context_management?: unknown };
  if (payload.context_management !== undefined) betas.push(CONTEXT_MANAGEMENT_BETA);

  if (betas.length > 0) ctx.headers.set('anthropic-beta', betas.join(','));
  return await run();
};
