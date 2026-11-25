import { observeProbes } from '../observe-probes.ts';
import { stripOpenAIHeaders } from '../strip-headers.ts';
import { call, compose } from './call.ts';
import { normalizeDeepSeek } from './vendor-deepseek-normalize.ts';
import { normalizeQwen } from './vendor-qwen-normalize.ts';
import { httpTerminal } from '@floway-dev/provider';

export const openaiResponses = compose('kimi-code.openaiResponses', {
  entry: ['request.http', 'request.openaiResponses', 'provider.upstream', 'provider.model'],
  exit: ['response.http', 'response.modelKey', 'response.openaiResponses'],
  stages: [normalizeDeepSeek, normalizeQwen, stripOpenAIHeaders, call, observeProbes],
  ending: httpTerminal,
});
