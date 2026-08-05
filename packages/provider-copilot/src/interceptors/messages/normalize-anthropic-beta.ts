import type { MessagesBoundaryCtx } from './types.ts';

const ALLOWED_ANTHROPIC_BETAS = new Set([
  'interleaved-thinking-2025-05-14',
  'context-management-2025-06-27',
  'advanced-tool-use-2025-11-20',
]);
const INTERLEAVED_THINKING_BETA = 'interleaved-thinking-2025-05-14';
const CONTEXT_MANAGEMENT_BETA = 'context-management-2025-06-27';

// Copilot rejects unknown beta values. Preserve the supported subset of the
// caller's Messages beta intent, synthesize VS Code's thinking default only
// when the caller supplied no beta intent, and keep context_management paired
// with its required token.
// https://github.com/microsoft/vscode/blob/a234109a108ad2ca78b7d0883688b0a84e3fab42/extensions/copilot/src/platform/endpoint/node/chatEndpoint.ts#L262-L282
// https://github.com/microsoft/vscode/blob/a234109a108ad2ca78b7d0883688b0a84e3fab42/extensions/copilot/src/extension/chatSessions/claude/node/claudeLanguageModelServer.ts#L413-L427
export const withAnthropicBetaNormalized = async <TResult>(
  ctx: MessagesBoundaryCtx,
  _env: object,
  run: () => Promise<TResult>,
): Promise<TResult> => {
  const callerSuppliedBeta = ctx.anthropicBeta.length > 0;
  ctx.anthropicBeta = [...new Set(ctx.anthropicBeta.filter(beta => ALLOWED_ANTHROPIC_BETAS.has(beta)))];

  const isAdaptiveThinking = ctx.payload.thinking?.type === 'adaptive';
  if (!callerSuppliedBeta && ctx.payload.thinking?.budget_tokens && !isAdaptiveThinking) {
    ctx.anthropicBeta.push(INTERLEAVED_THINKING_BETA);
  }

  const payload = ctx.payload as typeof ctx.payload & { context_management?: unknown };
  if (payload.context_management !== undefined && !ctx.anthropicBeta.includes(CONTEXT_MANAGEMENT_BETA)) {
    ctx.anthropicBeta.push(CONTEXT_MANAGEMENT_BETA);
  }

  return await run();
};
