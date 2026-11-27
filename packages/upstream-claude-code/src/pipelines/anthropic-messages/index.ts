import { authorizeAndRetry } from './authorize-and-retry.ts';
import { backfillRequiredFields } from './backfill-required-fields.ts';
import { detectShape } from './detect-shape.ts';
import { dial } from './dial.ts';
import { compose } from './facts.ts';
import { hoistUserSystemToMessages } from './hoist-user-system-to-messages.ts';
import { injectBillingBlock } from './inject-billing-block.ts';
import { injectDefaultTemplate } from './inject-default-template.ts';
import { injectIdentityBlock } from './inject-identity-block.ts';
import { observeQuota } from './observe-quota.ts';
import { observeSentinel } from './observe-sentinel.ts';
import { observeStream } from './observe-stream.ts';
import { parseResponse } from './parse-response.ts';
import { stripHeaders } from './strip-headers.ts';
import { synthesizeMetadataUserId } from './synthesize-metadata-user-id.ts';
import type { ClaudeCodeServices } from '../../service.ts';
import { httpTerminal, type UpstreamPipeline } from '@floway-dev/upstream';

const anthropicMessages: UpstreamPipeline<'anthropicMessages', ClaudeCodeServices> =
  compose('claude-code.anthropic-messages', {
    entry: ['http', 'upstream', 'model', 'anthropicMessages'],
    exit: ['http', 'anthropicMessages'],
    stages: [
      stripHeaders,
      detectShape,
      backfillRequiredFields,
      synthesizeMetadataUserId,
      hoistUserSystemToMessages,
      injectBillingBlock,
      injectIdentityBlock,
      injectDefaultTemplate,
      observeStream,
      parseResponse,
      observeSentinel,
      authorizeAndRetry,
      observeQuota,
      dial,
    ],
    ending: httpTerminal,
  });

export const claudeCodePipelines = Object.freeze({ anthropicMessages });
