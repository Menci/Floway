import { stripOpenAIImagesHeaders } from '../strip-headers.ts';
import { call, compose } from './call.ts';
import { httpTerminal } from '@floway-dev/provider';

export const openaiImagesGenerations = compose('chatgpt.openaiImagesGenerations', {
  entry: ['request.http', 'request.openaiImagesGenerations', 'provider.upstream', 'provider.model'],
  exit: ['response.http', 'response.modelKey', 'response.openaiImagesGenerations'],
  stages: [stripOpenAIImagesHeaders, call],
  ending: httpTerminal,
});
