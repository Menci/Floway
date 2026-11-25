import { stripOpenAIImagesHeaders } from '../strip-headers.ts';
import { call, compose } from './call.ts';
import { httpTerminal } from '@floway-dev/provider';

export const openaiImagesEdits = compose('chatgpt.openaiImagesEdits', {
  entry: ['request.http', 'request.openaiImagesEdits', 'provider.upstream', 'provider.model'],
  exit: ['response.http', 'response.modelKey', 'response.openaiImagesEdits'],
  stages: [stripOpenAIImagesHeaders, call],
  ending: httpTerminal,
});
