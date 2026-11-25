import { defineStage } from './facts.ts';
import { move, transform } from '@floway-dev/pipeline';
import type { AnthropicMessagesPayload } from '@floway-dev/protocols/anthropic-messages';

export const hoistUserSystemToMessages = defineStage({
  name: 'claude-code.hoist-user-system-to-messages',
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
      'request.anthropicMessages': move(hoistSystem(facts['request.anthropicMessages'])),
    },
  })),
});

// Reserve the system slot for the Claude Code system blocks. The acknowledgement
// closes the synthetic user/assistant pair before the caller's turns.
// https://github.com/Wei-Shaw/sub2api/blob/4a5665da5b2c6b83c4597844ea6e573746c821b1/backend/internal/service/gateway_service.go#L4480-L4486
export const hoistSystem = ({ system, ...payload }: AnthropicMessagesPayload): AnthropicMessagesPayload => {
  const text = typeof system === 'string'
    ? system
    : system?.flatMap(block => typeof block.text === 'string' && block.text.length > 0 ? [block.text] : []).join('\n\n');
  if (!text) return payload;
  return {
    ...payload,
    messages: [
      { role: 'user', content: [{ type: 'text', text: `[System Instructions]\n${text}` }] },
      { role: 'assistant', content: [{ type: 'text', text: 'Understood. I will follow these instructions.' }] },
      ...payload.messages,
    ],
  };
};
