import type { AnthropicMessagesMessage, AnthropicMessagesPayload, AnthropicMessagesTextBlockParam } from '@floway-dev/protocols/anthropic-messages';

type MessagePayload = Omit<AnthropicMessagesPayload, 'model'>;

// The synthetic assistant turn closes the hoisted user/assistant pair so the
// upstream's role-alternation guard stays satisfied. The text is visible to
// the model, so we keep it minimal and match the literal used by two
// independent OAuth-mimicry implementations.
const SYNTHETIC_ACK = 'Understood. I will follow these instructions.';

// The mimicry path reserves `system` for billing, identity, and template
// blocks. Caller system text is folded into the head of `messages` as a
// synthetic user/assistant turn so it survives that replacement.
//
// Non-text block fields such as citations and cache controls are dropped from
// the wrapped turn.
//
// https://github.com/Wei-Shaw/sub2api/blob/4a5665da5b2c6b83c4597844ea6e573746c821b1/backend/internal/service/gateway_service.go#L4480-L4486
export const hoistUserSystemToMessagesPayload = <P extends MessagePayload>(payload: P): P => {
  const system: string | AnthropicMessagesTextBlockParam[] | undefined = payload.system;
  let captured = '';
  if (typeof system === 'string') {
    captured = system;
  } else if (system !== undefined) {
    captured = system
      .map(block => block.text)
      .filter(text => typeof text === 'string' && text.length > 0)
      .join('\n\n');
  }
  const { system: _removed, ...nextPayload } = payload;

  if (captured !== '') {
    const synthetic: AnthropicMessagesMessage[] = [
      { role: 'user', content: [{ type: 'text', text: `[System Instructions]\n${captured}` }] },
      { role: 'assistant', content: [{ type: 'text', text: SYNTHETIC_ACK }] },
    ];
    nextPayload.messages = [...synthetic, ...nextPayload.messages];
  }

  return nextPayload as P;
};
