import { buildBillingBlock, computeCcVersionFingerprint } from './system-blocks.ts';
import type { MessagePayload } from './types.ts';
import { CLAUDE_CLI_VERSION } from '../../headers.ts';

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
export const injectBillingBlock = (payload: MessagePayload): MessagePayload => {
  const fingerprint = computeCcVersionFingerprint(CLAUDE_CLI_VERSION, payload);
  const block = buildBillingBlock(CLAUDE_CLI_VERSION, fingerprint);
  return { ...payload, system: [block] };
};
