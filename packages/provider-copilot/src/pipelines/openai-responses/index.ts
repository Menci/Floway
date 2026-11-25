import { copilotOperation } from '../facts.ts';
import { abortOnToolArgumentWhitespace } from './abort-on-tool-argument-whitespace.ts';
import { compressImages } from './compress-images.ts';
import { fillEmptyNamespaceDescriptions } from './fill-empty-namespace-descriptions.ts';
import { itemIdMembrane } from './item-id-membrane.ts';
import { parseOpenAIResponses } from './parse.ts';
import { selectOpenAIResponsesModel } from './select-model.ts';
import { serializeOpenAIResponses } from './serialize.ts';
import { setInitiatorHeader } from './set-initiator-header.ts';
import { setVisionHeader } from './set-vision-header.ts';
import { stripImageGeneration } from './strip-image-generation.ts';
import { stripServiceTier } from './strip-service-tier.ts';
import { normalizeDeepSeek } from './vendor-deepseek-normalize.ts';
import { normalizeQwen } from './vendor-qwen-normalize.ts';
import { authorize } from '../shared/authorize.ts';
import { observeQuota } from '../shared/observe-quota.ts';
import { setIdentityHeaders } from '../shared/set-identity-headers.ts';
import { stripClientHeaders } from '../shared/strip-client-headers.ts';
import { formatOpenAIResponsesError } from '@floway-dev/protocols/openai-responses';
import { httpTerminal } from '@floway-dev/provider';

export const openaiResponses = copilotOperation<'openaiResponses'>().compose('copilot.openaiResponses', {
  entry: ['request.http', 'provider.upstream', 'provider.model', 'request.openaiResponses'],
  exit: ['response.http', 'response.modelKey', 'response.openaiResponses'],
  stages: [
    normalizeDeepSeek,
    normalizeQwen,
    stripClientHeaders,
    selectOpenAIResponsesModel,
    setIdentityHeaders,
    compressImages,
    fillEmptyNamespaceDescriptions,
    stripServiceTier,
    stripImageGeneration,
    itemIdMembrane,
    abortOnToolArgumentWhitespace,
    setVisionHeader,
    setInitiatorHeader,
    serializeOpenAIResponses,
    observeQuota,
    authorize('response.openaiResponses', formatOpenAIResponsesError),
    parseOpenAIResponses,
  ],
  ending: httpTerminal,
});
