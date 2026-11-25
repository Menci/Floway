import { copilotOperation } from '../facts.ts';
import { parseOpenAIResponsesCompact } from './parse.ts';
import { serializeOpenAIResponsesCompact } from './serialize.ts';
import { compressImages } from '../openai-responses/compress-images.ts';
import { fillEmptyNamespaceDescriptions } from '../openai-responses/fill-empty-namespace-descriptions.ts';
import { itemIdMembrane } from '../openai-responses/item-id-membrane.ts';
import { selectOpenAIResponsesModel } from '../openai-responses/select-model.ts';
import { setInitiatorHeader } from '../openai-responses/set-initiator-header.ts';
import { setVisionHeader } from '../openai-responses/set-vision-header.ts';
import { stripImageGeneration } from '../openai-responses/strip-image-generation.ts';
import { stripServiceTier } from '../openai-responses/strip-service-tier.ts';
import { authorize } from '../shared/authorize.ts';
import { observeQuota } from '../shared/observe-quota.ts';
import { setIdentityHeaders } from '../shared/set-identity-headers.ts';
import { stripClientHeaders } from '../shared/strip-client-headers.ts';
import { formatOpenAIResponsesError } from '@floway-dev/protocols/openai-responses';
import { httpTerminal } from '@floway-dev/provider';

export const openaiResponsesCompact = copilotOperation<'openaiResponsesCompact'>().compose('copilot.openaiResponsesCompact', {
  entry: ['request.http', 'provider.upstream', 'provider.model', 'request.openaiResponses'],
  exit: ['response.http', 'response.modelKey', 'response.openaiResponses'],
  stages: [
    stripClientHeaders,
    selectOpenAIResponsesModel,
    setIdentityHeaders,
    compressImages,
    fillEmptyNamespaceDescriptions,
    stripServiceTier,
    stripImageGeneration,
    itemIdMembrane,
    setVisionHeader,
    setInitiatorHeader,
    serializeOpenAIResponsesCompact,
    observeQuota,
    authorize('response.openaiResponses', formatOpenAIResponsesError),
    parseOpenAIResponsesCompact,
  ],
  ending: httpTerminal,
});
