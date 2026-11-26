import { parse } from './parse.ts';
import { COMPACTION_TRIGGER } from '../../compaction.ts';
import { copilotOperation } from '../facts.ts';
import { compressImages } from '../openai-responses/compress-images.ts';
import { fillEmptyNamespaceDescriptions } from '../openai-responses/fill-empty-namespace-descriptions.ts';
import { compactItemIdMembrane } from '../openai-responses/item-id-membrane.ts';
import { setInitiatorHeader } from '../openai-responses/set-initiator-header.ts';
import { setVisionHeader } from '../openai-responses/set-vision-header.ts';
import { stripImageGeneration } from '../openai-responses/strip-image-generation.ts';
import { stripServiceTier } from '../openai-responses/strip-service-tier.ts';
import { authorize } from '../shared/authorize.ts';
import { dial, jsonRequest } from '../shared/dial.ts';
import { formatOpenAIError } from '../shared/format-errors.ts';
import { observeQuota } from '../shared/observe-quota.ts';
import { selectModel } from '../shared/select-model.ts';
import { setIdentityHeaders } from '../shared/set-identity-headers.ts';
import { stripClientHeaders } from '../shared/strip-client-headers.ts';
import { httpTerminal } from '@floway-dev/provider';

const operation = 'openaiResponsesCompact';

export const openaiResponsesCompact = copilotOperation<typeof operation>().compose('copilot.openaiResponsesCompact', {
  entry: ['request.http', 'provider.upstream', 'provider.model', 'request.openaiResponsesCompact'],
  exit: ['response.http', 'response.openaiResponsesCompact', 'response.usageModelKey?'],
  stages: [
    stripClientHeaders,
    selectModel.openaiResponsesCompact,
    setIdentityHeaders,
    compressImages(operation),
    fillEmptyNamespaceDescriptions(operation),
    stripServiceTier(operation),
    stripImageGeneration(operation),
    compactItemIdMembrane,
    setVisionHeader(operation),
    setInitiatorHeader(operation),
    parse,
    authorize(operation, formatOpenAIError),
    dial.openaiResponsesCompact(({ store: _store, ...payload }) =>
      jsonRequest('/responses', { ...payload, input: [...payload.input, COMPACTION_TRIGGER], stream: false }), formatOpenAIError),
    observeQuota,
  ],
  ending: httpTerminal,
});
