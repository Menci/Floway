import { defineStage } from './facts.ts';
import { buildBillingBlock, computeCcVersionFingerprint } from './system-blocks.ts';
import { CLAUDE_CLI_VERSION } from '../../headers.ts';
import type { AnthropicMessagesPayload } from '@floway-dev/protocols/anthropic-messages';

export const injectBillingBlock = defineStage({
  name: 'claude-code.anthropic-messages.inject-billing-block',
  through: {
    request: { needs: ['request.anthropicMessages', 'request.claudeCodeShaped'], provides: ['request.anthropicMessages'], consumes: [] },
    response: { needs: [], provides: [], consumes: [] },
  },
  async execute(facts, scope) {
    if (facts['request.claudeCodeShaped']) return await scope.next(facts);
    const payload = facts['request.anthropicMessages'];
    return await scope.next({ ...facts, 'request.anthropicMessages': withBillingBlock(payload) });
  },
});

// Drops the per-request `cc_version=${VERSION}.${FP}` billing block at the
// head of `system`. This must run BEFORE inject-identity-block /
// inject-default-template so the order on the wire matches the byte-for-byte
// CC shape: system[0] billing, system[1] identity, system[2] default
// template (the cached one).
//
// Hoist must have run first so any caller-supplied system text is already
// captured into `messages`; this stage starts a fresh
// `system` array.
//
// The fingerprint runs on the post-hoist payload deliberately. That is the
// shape Anthropic will actually see on the wire, so the fingerprint must
// reflect it — fingerprinting the pre-hoist shape would compute a different
// value than what the request body settles to and break CC mimicry.
export const withBillingBlock = (payload: AnthropicMessagesPayload): AnthropicMessagesPayload => {
  const fingerprint = computeCcVersionFingerprint(CLAUDE_CLI_VERSION, payload);
  const block = buildBillingBlock(CLAUDE_CLI_VERSION, fingerprint);
  return { ...payload, system: [block] };
};
