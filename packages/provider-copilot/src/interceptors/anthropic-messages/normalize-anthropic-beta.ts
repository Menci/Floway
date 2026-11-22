import type { AnthropicMessagesBoundaryCtx } from './types.ts';
import type { AnthropicMessagesPayload } from '@floway-dev/protocols/anthropic-messages';

const ALLOWED_ANTHROPIC_BETAS = new Set([
  'interleaved-thinking-2025-05-14',
  'context-management-2025-06-27',
  'advanced-tool-use-2025-11-20',
]);
const INTERLEAVED_THINKING_BETA = 'interleaved-thinking-2025-05-14';
const CONTEXT_MANAGEMENT_BETA = 'context-management-2025-06-27';

// Copilot rejects unknown beta values. Preserve the supported subset of the
// caller's Anthropic Messages beta intent, synthesize VS Code's thinking default only
// when the caller supplied no beta intent, and keep context_management paired
// with its required token.
// https://github.com/microsoft/vscode/blob/a234109a108ad2ca78b7d0883688b0a84e3fab42/extensions/copilot/src/platform/endpoint/node/chatEndpoint.ts#L262-L282
// https://github.com/microsoft/vscode/blob/a234109a108ad2ca78b7d0883688b0a84e3fab42/extensions/copilot/src/extension/chatSessions/claude/node/claudeLanguageModelServer.ts#L413-L427
export const normalizeCopilotAnthropicBeta = (
  beta: readonly string[],
  payload: AnthropicMessagesPayload,
): readonly string[] => {
  const callerSuppliedBeta = beta.length > 0;
  const normalized = [...new Set(beta.filter(value => ALLOWED_ANTHROPIC_BETAS.has(value)))];

  const isAdaptiveThinking = payload.thinking?.type === 'adaptive';
  if (!callerSuppliedBeta && (payload.thinking?.type === 'enabled' ? payload.thinking.budget_tokens : undefined) && !isAdaptiveThinking) {
    normalized.push(INTERLEAVED_THINKING_BETA);
  }

  const extendedPayload = payload as typeof payload & { context_management?: unknown };
  if (extendedPayload.context_management !== undefined && !normalized.includes(CONTEXT_MANAGEMENT_BETA)) {
    normalized.push(CONTEXT_MANAGEMENT_BETA);
  }
  return Object.freeze(normalized);
};

export const withAnthropicBetaNormalized = async <TResult>(
  ctx: AnthropicMessagesBoundaryCtx,
  _env: object,
  run: () => Promise<TResult>,
): Promise<TResult> => {
  ctx.anthropicBeta = [...normalizeCopilotAnthropicBeta(ctx.anthropicBeta, ctx.payload)];

  return await run();
};
