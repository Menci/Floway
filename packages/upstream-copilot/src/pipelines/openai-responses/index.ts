import { compressImages } from './compress-images.ts';
import { dial } from './dial.ts';
import { fillEmptyNamespaceDescriptions } from './fill-empty-namespace-descriptions.ts';
import { guardToolArgumentWhitespace } from './guard-tool-argument-whitespace.ts';
import { itemIdMembrane } from './item-id-membrane.ts';
import { parse } from './parse.ts';
import { selectModel } from './select-model.ts';
import { setInitiatorHeader } from './set-initiator-header.ts';
import { setVisionHeader } from './set-vision-header.ts';
import { stripImageGeneration } from './strip-image-generation.ts';
import { stripServiceTier } from './strip-service-tier.ts';
import { normalizeDeepSeek } from './vendor-deepseek-normalize.ts';
import { normalizeQwen } from './vendor-qwen-normalize.ts';
import type { CopilotServices } from '../../service.ts';
import { composeCopilot } from '../facts.ts';
import { authorize } from '../shared/authorize.ts';
import { setIdentityHeaders } from '../shared/set-identity-headers.ts';
import { stripClientHeaders } from '../shared/strip-client-headers.ts';
import { httpTerminal, type UpstreamPipeline } from '@floway-dev/upstream';

export const openaiResponses: UpstreamPipeline<'openaiResponses', CopilotServices, 'usageModelKey'> = composeCopilot('copilot.openaiResponses', {
  entry: ['http', 'upstream', 'model', 'openaiResponses'],
  exit: ['http', 'openaiResponses', 'usageModelKey?'],
  stages: [
    stripClientHeaders,
    selectModel,
    setIdentityHeaders,
    normalizeDeepSeek,
    normalizeQwen,
    compressImages,
    fillEmptyNamespaceDescriptions,
    stripServiceTier,
    stripImageGeneration,
    itemIdMembrane,
    guardToolArgumentWhitespace,
    setVisionHeader,
    setInitiatorHeader,
    parse,
    dial,
    authorize,
  ],
  ending: httpTerminal,
});
