import { compressImages } from './compress-images.ts';
import { dial } from './dial.ts';
import { fillEmptyNamespaceDescriptions } from './fill-empty-namespace-descriptions.ts';
import { guardToolArgumentWhitespace } from './guard-tool-argument-whitespace.ts';
import { itemIdMembrane } from './item-id-membrane.ts';
import { selectModel } from './select-model.ts';
import { setInitiatorHeader } from './set-initiator-header.ts';
import { setVisionHeader } from './set-vision-header.ts';
import { stripImageGeneration } from './strip-image-generation.ts';
import { stripServiceTier } from './strip-service-tier.ts';
import { normalizeDeepSeek } from './vendor-deepseek-normalize.ts';
import { normalizeQwen } from './vendor-qwen-normalize.ts';
import { copilotOperation } from '../facts.ts';
import { authorize } from '../shared/authorize.ts';
import { formatOpenAIError } from '../shared/format-errors.ts';
import { observeQuota } from '../shared/observe-quota.ts';
import { setIdentityHeaders } from '../shared/set-identity-headers.ts';
import { stripClientHeaders } from '../shared/strip-client-headers.ts';
import { decodeOpenAIResponsesStream } from '@floway-dev/protocols/openai-responses';
import { httpTerminal, parseSseResponse } from '@floway-dev/provider';

const operation = 'openaiResponses';

export const openaiResponses = copilotOperation<typeof operation>().compose('copilot.openaiResponses', {
  entry: ['request.http', 'provider.upstream', 'provider.model', 'request.openaiResponses'],
  exit: ['response.http', 'response.openaiResponses', 'response.usageModelKey?'],
  stages: [
    stripClientHeaders,
    selectModel,
    setIdentityHeaders,
    normalizeDeepSeek,
    normalizeQwen,
    compressImages(operation),
    fillEmptyNamespaceDescriptions(operation),
    stripServiceTier(operation),
    stripImageGeneration(operation),
    itemIdMembrane,
    guardToolArgumentWhitespace,
    setVisionHeader(operation),
    setInitiatorHeader(operation),
    parseSseResponse(operation, decodeOpenAIResponsesStream, formatOpenAIError),
    authorize(operation, formatOpenAIError),
    dial,
    observeQuota,
  ],
  ending: httpTerminal,
});
