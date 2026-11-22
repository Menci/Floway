import { buildBillingBlock, computeCcVersionFingerprint } from './system-blocks.ts';
import { CLAUDE_CLI_VERSION } from '../../headers.ts';
import type { AnthropicMessagesPayload } from '@floway-dev/protocols/anthropic-messages';

type MessagePayload = Omit<AnthropicMessagesPayload, 'model'>;

// Billing is `system[0]` and must precede the identity and cached template
// blocks. The fingerprint reflects the post-hoist payload because that is the
// exact body Anthropic receives.
export const injectBillingBlockPayload = <P extends MessagePayload>(payload: P): P => {
  const fingerprint = computeCcVersionFingerprint(CLAUDE_CLI_VERSION, payload);
  return { ...payload, system: [buildBillingBlock(CLAUDE_CLI_VERSION, fingerprint)] };
};
