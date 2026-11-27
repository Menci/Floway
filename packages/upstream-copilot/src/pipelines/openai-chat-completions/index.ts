import { attachCacheControlMarkers } from './attach-cache-control-markers.ts';
import { compressImages } from './compress-images.ts';
import { dial } from './dial.ts';
import { guardToolArgumentWhitespace } from './guard-tool-argument-whitespace.ts';
import { parse } from './parse.ts';
import { selectModel } from './select-model.ts';
import { setInitiatorHeader } from './set-initiator-header.ts';
import { setVisionHeader } from './set-vision-header.ts';
import { normalizeDeepSeek } from './vendor-deepseek-normalize.ts';
import { normalizeKimi } from './vendor-kimi-normalize.ts';
import { normalizeMistral } from './vendor-mistral-normalize.ts';
import { normalizeQwen } from './vendor-qwen-normalize.ts';
import type { CopilotServices } from '../../service.ts';
import { composeCopilot } from '../facts.ts';
import { authorize } from '../shared/authorize.ts';
import { setIdentityHeaders } from '../shared/set-identity-headers.ts';
import { stripClientHeaders } from '../shared/strip-client-headers.ts';
import { httpTerminal, type UpstreamPipeline } from '@floway-dev/upstream';

export const openaiChatCompletions: UpstreamPipeline<'openaiChatCompletions', CopilotServices, 'usageModelKey'> = composeCopilot('copilot.openaiChatCompletions', {
  entry: ['http', 'upstream', 'model', 'openaiChatCompletions'],
  exit: ['http', 'openaiChatCompletions', 'usageModelKey?'],
  stages: [
    stripClientHeaders,
    selectModel,
    setIdentityHeaders,
    normalizeDeepSeek,
    normalizeQwen,
    normalizeKimi,
    normalizeMistral,
    compressImages,
    guardToolArgumentWhitespace,
    attachCacheControlMarkers,
    setInitiatorHeader,
    setVisionHeader,
    parse,
    dial,
    authorize,
  ],
  ending: httpTerminal,
});
