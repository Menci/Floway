import { stripAnthropicMessagesHeaders } from '../strip-headers.ts';
import { call, compose } from './call.ts';
import { httpTerminal } from '@floway-dev/provider';

export const anthropicMessagesCountTokens = compose('kimi-code.anthropicMessagesCountTokens', {
  entry: ['request.http', 'request.anthropicMessages', 'provider.upstream', 'provider.model'],
  exit: ['response.http', 'response.modelKey', 'response.anthropicMessages'],
  stages: [stripAnthropicMessagesHeaders, call],
  ending: httpTerminal,
});
