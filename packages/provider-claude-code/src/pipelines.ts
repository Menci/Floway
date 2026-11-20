import { authenticateClaudeCode } from './stages/authenticate.ts';
import { backfillRequiredFields } from './stages/backfill-required-fields.ts';
import { decodeClaudeCodeResponse } from './stages/decode-response.ts';
import { hoistUserSystemToMessages } from './stages/hoist-user-system-to-messages.ts';
import { injectBillingBlock } from './stages/inject-billing-block.ts';
import { injectDefaultTemplate } from './stages/inject-default-template.ts';
import { injectIdentityBlock } from './stages/inject-identity-block.ts';
import { observeClaudeCodeResponse } from './stages/observe-response.ts';
import { prepareClaudeCodeRequest } from './stages/prepare-request.ts';
import { recognizeClaudeCodeShape } from './stages/recognize-shape.ts';
import { retryClaudeCodeAccess } from './stages/retry-access.ts';
import { synthesizeMetadataUserId } from './stages/synthesize-metadata-user-id.ts';
import { http } from '@floway-dev/http/pipeline';
import { compose } from '@floway-dev/pipeline';
import { observeProviderCall, type ProviderOperationRequest, type ProviderChatResponse, type ProviderPipelines } from '@floway-dev/provider';

export const createClaudeCodePipelines = (upstreamId: string): ProviderPipelines => ({
  anthropicMessages: compose<ProviderOperationRequest<'anthropicMessages'>, ProviderChatResponse<'anthropicMessages'>>('claudeCode.anthropicMessages', [
    recognizeClaudeCodeShape, backfillRequiredFields, synthesizeMetadataUserId(upstreamId), hoistUserSystemToMessages,
    injectBillingBlock, injectIdentityBlock, injectDefaultTemplate, authenticateClaudeCode(upstreamId),
    prepareClaudeCodeRequest, decodeClaudeCodeResponse(upstreamId), retryClaudeCodeAccess(upstreamId), observeClaudeCodeResponse(upstreamId), observeProviderCall, http,
  ]),
});
