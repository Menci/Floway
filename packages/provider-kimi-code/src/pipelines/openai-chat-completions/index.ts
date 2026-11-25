import { observeProbes } from '../observe-probes.ts';
import { stripOpenAIHeaders } from '../strip-headers.ts';
import { call, compose } from './call.ts';
import { normalizeDeepSeek } from './vendor-deepseek-normalize.ts';
import { normalizeKimi } from './vendor-kimi-normalize.ts';
import { normalizeQwen } from './vendor-qwen-normalize.ts';
import { httpTerminal } from '@floway-dev/provider';

export const openaiChatCompletions = compose('kimi-code.openaiChatCompletions', {
  entry: ['request.http', 'request.openaiChatCompletions', 'provider.upstream', 'provider.model'],
  exit: ['response.http', 'response.modelKey', 'response.openaiChatCompletions'],
  stages: [normalizeDeepSeek, normalizeQwen, normalizeKimi, stripOpenAIHeaders, call, observeProbes],
  ending: httpTerminal,
});
