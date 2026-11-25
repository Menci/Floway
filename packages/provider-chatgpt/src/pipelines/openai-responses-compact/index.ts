import { call, compose } from './call.ts';
import { injectDefaultInstructions } from '../openai-responses/inject-default-instructions.ts';
import { stripUnsupportedFields } from '../openai-responses/strip-unsupported-fields.ts';
import { stripResponsesHeaders } from '../strip-headers.ts';
import { httpTerminal } from '@floway-dev/provider';

export const openaiResponsesCompact = compose('chatgpt.openaiResponsesCompact', {
  entry: ['request.http', 'request.openaiResponses', 'provider.upstream', 'provider.model'],
  exit: ['response.http', 'response.modelKey', 'response.openaiResponses'],
  stages: [stripResponsesHeaders, injectDefaultInstructions, stripUnsupportedFields, call],
  ending: httpTerminal,
});
