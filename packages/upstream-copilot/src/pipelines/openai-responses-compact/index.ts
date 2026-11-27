import { compressImages } from './compress-images.ts';
import { dial } from './dial.ts';
import { fillEmptyNamespaceDescriptions } from './fill-empty-namespace-descriptions.ts';
import { itemIdMembrane } from './item-id-membrane.ts';
import { parse } from './parse.ts';
import { selectModel } from './select-model.ts';
import { setInitiatorHeader } from './set-initiator-header.ts';
import { setVisionHeader } from './set-vision-header.ts';
import { stripImageGeneration } from './strip-image-generation.ts';
import { stripServiceTier } from './strip-service-tier.ts';
import type { CopilotServices } from '../../service.ts';
import { composeCopilot } from '../facts.ts';
import { authorize } from '../shared/authorize.ts';
import { setIdentityHeaders } from '../shared/set-identity-headers.ts';
import { stripClientHeaders } from '../shared/strip-client-headers.ts';
import { httpTerminal, type UpstreamPipeline } from '@floway-dev/upstream';

export const openaiResponsesCompact: UpstreamPipeline<'openaiResponsesCompact', CopilotServices, 'usageModelKey'> = composeCopilot('copilot.openaiResponsesCompact', {
  entry: ['http', 'upstream', 'model', 'openaiResponsesCompact'],
  exit: ['http', 'openaiResponsesCompact', 'usageModelKey?'],
  stages: [
    stripClientHeaders,
    selectModel,
    setIdentityHeaders,
    compressImages,
    fillEmptyNamespaceDescriptions,
    stripServiceTier,
    stripImageGeneration,
    itemIdMembrane,
    setVisionHeader,
    setInitiatorHeader,
    parse,
    dial,
    authorize,
  ],
  ending: httpTerminal,
});
