import { observeProbes } from '../observe-probes.ts';
import { stripAnthropicMessagesHeaders } from '../strip-headers.ts';
import { call, compose } from './call.ts';
import { httpTerminal } from '@floway-dev/provider';

export const anthropicMessages = compose('kimi-code.anthropicMessages', {
  entry: ['request.http', 'request.anthropicMessages', 'provider.upstream', 'provider.model'],
  exit: ['response.http', 'response.modelKey', 'response.anthropicMessages'],
  stages: [stripAnthropicMessagesHeaders, call, observeProbes],
  ending: httpTerminal,
});
