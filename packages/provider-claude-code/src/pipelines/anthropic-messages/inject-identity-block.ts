import { defineStage } from './facts.ts';
import { IDENTITY_BLOCK } from './system-blocks.ts';
import type { AnthropicMessagesPayload } from '@floway-dev/protocols/anthropic-messages';

export const injectIdentityBlock = defineStage({
  name: 'claude-code.anthropic-messages.inject-identity-block',
  through: {
    request: { needs: ['request.anthropicMessages', 'request.claudeCodeShaped'], provides: ['request.anthropicMessages'], consumes: [] },
    response: { needs: [], provides: [], consumes: [] },
  },
  async execute(facts, scope) {
    if (facts['request.claudeCodeShaped']) return await scope.next(facts);
    const payload = facts['request.anthropicMessages'];
    return await scope.next({ ...facts, 'request.anthropicMessages': withIdentityBlock(payload) });
  },
});

export const withIdentityBlock = (payload: AnthropicMessagesPayload): AnthropicMessagesPayload => {
  const { system } = payload;
  if (!Array.isArray(system)) throw new Error('inject-identity-block: expected system to be an array (inject-billing-block must run first)');
  return { ...payload, system: [...system, IDENTITY_BLOCK] };
};
