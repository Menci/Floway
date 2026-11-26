import { encode, jsonResponse, localResponseHead } from '../../../pipeline/encode.ts';

export const encodeOpenAIResponsesCompact = encode(
  'openaiResponsesCompact',
  ({ http, outcome }) => outcome.kind === 'error'
    ? jsonResponse(http ?? localResponseHead(outcome.source === 'local' ? 499 : 502), outcome.error)
    : jsonResponse(http ?? localResponseHead(200), outcome.result),
);
