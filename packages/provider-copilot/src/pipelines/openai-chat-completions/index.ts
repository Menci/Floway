import { attachCacheControlMarkers } from './attach-cache-control-markers.ts';
import { compressImages } from './compress-images.ts';
import { dial } from './dial.ts';
import { guardToolArgumentWhitespace } from './guard-tool-argument-whitespace.ts';
import { selectModel } from './select-model.ts';
import { setInitiatorHeader } from './set-initiator-header.ts';
import { setVisionHeader } from './set-vision-header.ts';
import { normalizeDeepSeek } from './vendor-deepseek-normalize.ts';
import { normalizeKimi } from './vendor-kimi-normalize.ts';
import { normalizeQwen } from './vendor-qwen-normalize.ts';
import { copilotOperation } from '../facts.ts';
import { authorize } from '../shared/authorize.ts';
import { formatOpenAIError } from '../shared/format-errors.ts';
import { observeQuota } from '../shared/observe-quota.ts';
import { setIdentityHeaders } from '../shared/set-identity-headers.ts';
import { stripClientHeaders } from '../shared/strip-client-headers.ts';
import { decodeOpenAIChatCompletionsStream } from '@floway-dev/protocols/openai-chat-completions';
import { httpTerminal, parseSseResponse } from '@floway-dev/provider';

const operation = 'openaiChatCompletions';

export const openaiChatCompletions = copilotOperation<typeof operation>().compose('copilot.openaiChatCompletions', {
  entry: ['request.http', 'provider.upstream', 'provider.model', 'request.openaiChatCompletions'],
  exit: ['response.http', 'response.openaiChatCompletions', 'response.usageModelKey?'],
  stages: [
    stripClientHeaders,
    selectModel,
    setIdentityHeaders,
    normalizeDeepSeek,
    normalizeQwen,
    normalizeKimi,
    compressImages,
    guardToolArgumentWhitespace,
    attachCacheControlMarkers,
    setInitiatorHeader,
    setVisionHeader,
    parseSseResponse(operation, decodeOpenAIChatCompletionsStream, formatOpenAIError),
    authorize(operation, formatOpenAIError),
    dial,
    observeQuota,
  ],
  ending: httpTerminal,
});
