import { backfillRequiredFields } from './backfill-required-fields.ts';
import { callAnthropicMessages } from './call-anthropic-messages.ts';
import { detectClaudeCodeShape } from './detect-claude-code-shape.ts';
import { compose } from './facts.ts';
import { gateAccount } from './gate-account.ts';
import { hoistUserSystemToMessages } from './hoist-user-system-to-messages.ts';
import { injectBillingBlock } from './inject-billing-block.ts';
import { injectDefaultTemplate } from './inject-default-template.ts';
import { injectIdentityBlock } from './inject-identity-block.ts';
import { observeQuota } from './observe-quota.ts';
import { observeSentinel } from './observe-sentinel.ts';
import { serialize } from './serialize.ts';
import { stripClaudeCodeHeaders } from './strip-headers.ts';
import { synthesizeMetadataUserId } from './synthesize-metadata-user-id.ts';
import { httpTerminal } from '@floway-dev/provider';

export const anthropicMessages = compose('claude-code.anthropicMessages', {
  entry: ['request.http', 'request.anthropicMessages', 'provider.upstream', 'provider.model'],
  exit: ['response.http', 'response.modelKey', 'response.anthropicMessages'],
  stages: [
    stripClaudeCodeHeaders,
    detectClaudeCodeShape,
    backfillRequiredFields,
    synthesizeMetadataUserId,
    hoistUserSystemToMessages,
    injectBillingBlock,
    injectIdentityBlock,
    injectDefaultTemplate,
    serialize,
    gateAccount,
    callAnthropicMessages,
    observeQuota,
    observeSentinel,
  ],
  ending: httpTerminal,
});
