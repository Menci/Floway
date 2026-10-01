import { CLAUDE_CLI_VERSION } from '../headers.ts';
import type { ClaudeCodePreparedRequest } from '../pipeline-facts.ts';
import { buildBillingBlock, computeCcVersionFingerprint } from '../system-blocks.ts';
import { defineStage, move } from '@floway-dev/pipeline';
import type { AnthropicMessagesPayload } from '@floway-dev/protocols/anthropic-messages';
import type { ProviderChatResponse } from '@floway-dev/provider';

// Drops the per-request `cc_version=${VERSION}.${FP}` billing block at the
// head of `system`. This must run BEFORE inject-identity-block /
// inject-default-template so the order on the wire matches the byte-for-byte
// CC shape: system[0] billing, system[1] identity, system[2] default
// template (the cached one).
//
// Hoist must have run first so any caller-supplied system text is already
// captured into `messages`; this stage unconditionally starts a fresh
// `system` array.
//
// The fingerprint runs on the post-hoist payload deliberately. That is the
// shape Anthropic will actually see on the wire, so the fingerprint must
// reflect it — fingerprinting the pre-hoist shape would compute a different
// value than what the request body settles to and break CC mimicry.
export const injectBillingBlockPayload = <P extends Omit<AnthropicMessagesPayload, 'model'>>(payload: P): P => {
  const fingerprint = computeCcVersionFingerprint(CLAUDE_CLI_VERSION, payload);
  const block = buildBillingBlock(CLAUDE_CLI_VERSION, fingerprint);
  payload = { ...payload, system: [block] };
  return payload;
};

export const injectBillingBlock = defineStage<ClaudeCodePreparedRequest, ClaudeCodePreparedRequest, ProviderChatResponse<'anthropicMessages'>, ProviderChatResponse<'anthropicMessages'>>({
  name: 'injectBillingBlock',
  through: { request: { needs: ['request.provider.payload', 'request.claudeCode.shaped'], consumes: ['request.provider.payload'], provides: ['request.provider.payload'] }, response: { needs: [], consumes: [], provides: [] } },
  execute: async (facts, next) => move({ ...await next(move({ ...facts, 'request.provider.payload': facts['request.claudeCode.shaped'] ? facts['request.provider.payload'] : injectBillingBlockPayload(facts['request.provider.payload']) })) }),
});
