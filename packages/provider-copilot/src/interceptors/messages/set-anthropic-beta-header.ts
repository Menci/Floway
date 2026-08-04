import type { MessagesBoundaryCtx } from './types.ts';

const INTERLEAVED_THINKING_BETA = 'interleaved-thinking-2025-05-14';
const CONTEXT_MANAGEMENT_BETA = 'context-management-2025-06-27';

// Copilot receives an empty client-header bag. This is the sole writer of its
// Messages `anthropic-beta` header and derives both tokens from the final wire
// payload: non-adaptive budget thinking needs interleaved-thinking, while the
// `context_management` field is rejected unless its matching beta is present.
// https://github.com/microsoft/vscode/blob/a234109a108ad2ca78b7d0883688b0a84e3fab42/extensions/copilot/src/platform/endpoint/node/chatEndpoint.ts#L262-L282
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
