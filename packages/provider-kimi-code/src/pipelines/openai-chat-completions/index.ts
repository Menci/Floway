import { observeProbes } from '../observe-probes.ts';
import { stripOpenAIHeaders } from '../strip-headers.ts';
import { call, compose } from './call.ts';
import { httpTerminal } from '@floway-dev/provider';

export const openaiChatCompletions = compose('kimi-code.openaiChatCompletions', {
  entry: ['request.http', 'request.openaiChatCompletions', 'provider.upstream', 'provider.model'],
  exit: ['response.http', 'response.modelKey', 'response.openaiChatCompletions'],
  stages: [stripOpenAIHeaders, call, observeProbes],
  ending: httpTerminal,
});
