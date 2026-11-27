import { defineStage } from './facts.ts';
import type { AnthropicMessagesMessage, AnthropicMessagesPayload } from '@floway-dev/protocols/anthropic-messages';

// Move caller instructions into an alternating pair before the billing stage
// replaces the system blocks. The acknowledgement matches the CLI convention.
// https://github.com/Wei-Shaw/sub2api/blob/4a5665da5b2c6b83c4597844ea6e573746c821b1/backend/internal/service/gateway_service.go#L4480-L4486
const SYNTHETIC_ACK = 'Understood. I will follow these instructions.';

const withHoistedUserSystem = ({ system, ...payload }: AnthropicMessagesPayload): AnthropicMessagesPayload => {
  let captured = '';
  if (typeof system === 'string') {
    captured = system;
  } else if (system !== undefined) {
    captured = system
      .map(block => block.text)
      .filter(text => typeof text === 'string' && text.length > 0)
      .join('\n\n');
  }
  if (captured === '') return payload;
  const synthetic: AnthropicMessagesMessage[] = [
    { role: 'user', content: [{ type: 'text', text: `[System Instructions]\n${captured}` }] },
    { role: 'assistant', content: [{ type: 'text', text: SYNTHETIC_ACK }] },
  ];
  return { ...payload, messages: [...synthetic, ...payload.messages] };
};

export const hoistUserSystemToMessages = defineStage({
  name: 'claude-code.anthropic-messages.hoist-user-system-to-messages',
  through: {
    request: { needs: ['anthropicMessages', 'claudeCode.shaped'], provides: ['anthropicMessages'], consumes: [] },
    response: { needs: [], provides: [], consumes: [] },
  },
  async execute(facts, scope) {
    if (facts['claudeCode.shaped']) return await scope.next(facts);
    return await scope.next({ ...facts, anthropicMessages: withHoistedUserSystem(facts.anthropicMessages) });
  },
});
