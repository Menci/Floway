import { stripAlphaSearchHeaders } from '../strip-headers.ts';
import { call, compose } from './call.ts';
import { httpTerminal } from '@floway-dev/provider';

export const alphaSearch = compose('chatgpt.alphaSearch', {
  entry: ['request.http', 'request.alphaSearch', 'provider.upstream', 'provider.model'],
  exit: ['response.http', 'response.modelKey', 'response.alphaSearch'],
  stages: [stripAlphaSearchHeaders, call],
  ending: httpTerminal,
});
