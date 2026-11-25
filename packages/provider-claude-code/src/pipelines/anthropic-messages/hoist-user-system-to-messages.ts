import { defineStage } from './facts.ts';
import type { AnthropicMessagesMessage, AnthropicMessagesPayload } from '@floway-dev/protocols/anthropic-messages';

export const hoistUserSystemToMessages = defineStage({
  name: 'claude-code.anthropic-messages.hoist-user-system-to-messages',
  through: {
    request: { needs: ['request.anthropicMessages', 'request.claudeCodeShaped'], provides: ['request.anthropicMessages'], consumes: [] },
    response: { needs: [], provides: [], consumes: [] },
  },
  async execute(facts, scope) {
    if (facts['request.claudeCodeShaped']) return await scope.next(facts);
    const payload = facts['request.anthropicMessages'];
    return await scope.next({ ...facts, 'request.anthropicMessages': withSystemInMessages(payload) });
  },
});

// Synthetic assistant turn that closes the hoisted user/assistant pair so the
// upstream's role-alternation guard stays satisfied. The text is visible to
// the upstream and may echo back in completion text, so keep it minimal.
//
// Two independent OAuth-mimicry impls (sub2api `gateway_service.go:4486`
// and claude-relay-service) converged on this exact literal; divergence is
// a likely detector signal, so we match.
const SYNTHETIC_ACK = 'Understood. I will follow these instructions.';

// On the re-mimicry path the upstream's `system` slot is reserved for the
// three CC-mimicry blocks (billing / identity / default template). Any
// caller-supplied system content must therefore move OUT of `system` before
// those three blocks are injected, otherwise the operator's instructions
// would be lost. The convention sub2api and Parrot both ship — and the one
// real CC clients fall back to when their own system text exceeds the bare
// identity block — is to fold the original system text into the head of
// `messages` as a synthetic user/assistant turn. The acknowledgement keeps
// the conversation alternation valid so the upstream's role-alternation
// guard doesn't fire.
//
// Non-text fields on blocks (citations, cache_control) are intentionally
// dropped — the wrapped turn is best-effort recovery of the operator's
// intent.
//
// References:
//   - https://github.com/Wei-Shaw/sub2api/blob/4a5665da5b2c6b83c4597844ea6e573746c821b1/backend/internal/service/gateway_service.go#L4480-L4486
export const withSystemInMessages = (payload: AnthropicMessagesPayload): AnthropicMessagesPayload => {
  const { system, ...nextPayload } = payload;
  let captured = '';
  if (typeof system === 'string') {
    captured = system;
  } else if (system !== undefined) {
    captured = system
      .map(block => block.text)
      .filter(text => typeof text === 'string' && text.length > 0)
      .join('\n\n');
  }
  if (captured !== '') {
    // Wrapper format `[System Instructions]\n${text}` matches sub2api
    // `gateway_service.go:4480` byte-for-byte; the synthetic user content is
    // emitted as a structured `[{type:"text",text:...}]` block (the shape
    // both reference impls and real CC use) rather than a raw string.
    const synthetic: AnthropicMessagesMessage[] = [
      { role: 'user', content: [{ type: 'text', text: `[System Instructions]\n${captured}` }] },
      { role: 'assistant', content: [{ type: 'text', text: SYNTHETIC_ACK }] },
    ];
    nextPayload.messages = [...synthetic, ...nextPayload.messages];
  }

  return nextPayload;
};
