import { copilotOperation } from '../facts.ts';
import { abortOnToolArgumentWhitespace } from './abort-on-tool-argument-whitespace.ts';
import { attachCacheControlMarkers } from './attach-cache-control-markers.ts';
import { compressImages } from './compress-images.ts';
import { parseOpenAIChatCompletions } from './parse.ts';
import { selectOpenAIChatCompletionsModel } from './select-model.ts';
import { serializeOpenAIChatCompletions } from './serialize.ts';
import { setInitiatorHeader } from './set-initiator-header.ts';
import { setVisionHeader } from './set-vision-header.ts';
import { normalizeDeepSeek } from './vendor-deepseek-normalize.ts';
import { normalizeKimi } from './vendor-kimi-normalize.ts';
import { normalizeQwen } from './vendor-qwen-normalize.ts';
import { authorize } from '../shared/authorize.ts';
import { observeQuota } from '../shared/observe-quota.ts';
import { setIdentityHeaders } from '../shared/set-identity-headers.ts';
import { stripClientHeaders } from '../shared/strip-client-headers.ts';
import { formatOpenAIChatCompletionsError } from '@floway-dev/protocols/openai-chat-completions';
import { httpTerminal } from '@floway-dev/provider';

export const openaiChatCompletions = copilotOperation<'openaiChatCompletions'>().compose('copilot.openaiChatCompletions', {
  entry: ['request.http', 'provider.upstream', 'provider.model', 'request.openaiChatCompletions'],
  exit: ['response.http', 'response.modelKey', 'response.openaiChatCompletions'],
  stages: [
    normalizeDeepSeek,
    normalizeQwen,
    normalizeKimi,
    stripClientHeaders,
    selectOpenAIChatCompletionsModel,
    setIdentityHeaders,
    compressImages,
    abortOnToolArgumentWhitespace,
    attachCacheControlMarkers,
    setInitiatorHeader,
    setVisionHeader,
    serializeOpenAIChatCompletions,
    observeQuota,
    authorize('response.openaiChatCompletions', formatOpenAIChatCompletionsError),
    parseOpenAIChatCompletions,
  ],
  ending: httpTerminal,
});
