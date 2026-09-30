import type { MessagesFacts } from '../../chat-facts.ts';
import { defineStage, move } from '@floway-dev/pipeline';

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

export const copilotAnthropicMessagesNormalizeAnthropicBeta = defineStage<MessagesFacts, MessagesFacts, object, object>({
  name: 'copilotAnthropicMessagesNormalizeAnthropicBeta',
  through: {
    request: { needs: ['request.provider.payload', 'request.provider.anthropicBeta'], consumes: ['request.provider.anthropicBeta'], provides: ['request.provider.anthropicBeta'] },
    response: { needs: [], consumes: [], provides: [] },
  },
  execute: async (facts, next) => {
    const payload = facts['request.provider.payload'] as typeof facts['request.provider.payload'] & { context_management?: unknown };
    let beta = facts['request.provider.anthropicBeta'];

    const callerSuppliedBeta = beta.length > 0;
    beta = [...new Set(beta.filter(beta => ALLOWED_ANTHROPIC_BETAS.has(beta)))];

    const isAdaptiveThinking = payload.thinking?.type === 'adaptive';
    if (!callerSuppliedBeta && payload.thinking?.budget_tokens && !isAdaptiveThinking) {
      beta = [...beta, INTERLEAVED_THINKING_BETA];
    }

    if (payload.context_management !== undefined && !beta.includes(CONTEXT_MANAGEMENT_BETA)) {
      beta = [...beta, CONTEXT_MANAGEMENT_BETA];
    }

    return move({ ...await next(move({ ...facts, 'request.provider.anthropicBeta': beta })) });

  },
});
