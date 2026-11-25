import { stripResponsesHeaders } from '../strip-headers.ts';
import { call } from './call.ts';
import { ensureSseContentType } from './ensure-sse-content-type.ts';
import { compose } from './facts.ts';
import { injectDefaultInstructions } from './inject-default-instructions.ts';
import { stripUnsupportedFields } from './strip-unsupported-fields.ts';
import { httpTerminal } from '@floway-dev/provider';

export const openaiResponses = compose('chatgpt.openaiResponses', {
  entry: ['request.http', 'request.openaiResponses', 'provider.upstream', 'provider.model'],
  exit: ['response.http', 'response.modelKey', 'response.openaiResponses'],
  stages: [stripResponsesHeaders, injectDefaultInstructions, stripUnsupportedFields, call, ensureSseContentType],
  ending: httpTerminal,
});
