import { defineStage } from './facts.ts';
import { IDENTITY_BLOCK } from './system-blocks.ts';
import { move, transform } from '@floway-dev/pipeline';
import type { AnthropicMessagesPayload } from '@floway-dev/protocols/anthropic-messages';

export const injectIdentityBlock = defineStage({
  name: 'claude-code.inject-identity-block',
  through: {
    request: {
      needs: ['request.anthropicMessages', 'request.claudeCodeShaped'],
      provides: ['request.anthropicMessages'],
      consumes: [],
    },
    response: { needs: [], provides: [], consumes: [] },
  },
  execute: transform(() => ({
    request: facts => facts['request.claudeCodeShaped'] ? facts : {
      ...facts,
      'request.anthropicMessages': move(addIdentityBlock(facts['request.anthropicMessages'])),
    },
  })),
});

export const addIdentityBlock = (payload: AnthropicMessagesPayload): AnthropicMessagesPayload => {
  if (!Array.isArray(payload.system)) throw new TypeError('Expected Claude Code billing block before the identity block');
  return { ...payload, system: [...payload.system, IDENTITY_BLOCK] };
};
