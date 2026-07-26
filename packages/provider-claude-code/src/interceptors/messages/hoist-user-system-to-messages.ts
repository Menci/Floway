import type { MessagesBoundaryCtx } from './types.ts';
import type { MessagesMessage, MessagesTextBlock } from '@floway-dev/protocols/messages';

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
export const hoistUserSystemToMessages = async <TResult>(
  ctx: MessagesBoundaryCtx,
  _env: object,
  run: () => Promise<TResult>,
): Promise<TResult> => {
  const system: string | MessagesTextBlock[] | undefined = ctx.payload.system;
  let captured = '';
  if (typeof system === 'string') {
    captured = system;
  } else if (system !== undefined) {
    captured = system
      .map(block => block.text)
      .filter(text => typeof text === 'string' && text.length > 0)
      .join('\n\n');
  }
  // inject-billing-block et al rebuild `system` from scratch as a three-block
  // array; removing the field here keeps the boundary mutation self-contained.
  const nextPayload = { ...ctx.payload };
  delete nextPayload.system;

  if (captured !== '') {
    // Wrapper format `[System Instructions]\n${text}` matches sub2api
    // `gateway_service.go:4480` byte-for-byte; the synthetic user content is
    // emitted as a structured `[{type:"text",text:...}]` block (the shape
    // both reference impls and real CC use) rather than a raw string.
    const synthetic: MessagesMessage[] = [
      { role: 'user', content: [{ type: 'text', text: `[System Instructions]\n${captured}` }] },
      { role: 'assistant', content: [{ type: 'text', text: SYNTHETIC_ACK }] },
    ];
    nextPayload.messages = [...synthetic, ...nextPayload.messages];
  }

  ctx.payload = nextPayload;
  return await run();
};
