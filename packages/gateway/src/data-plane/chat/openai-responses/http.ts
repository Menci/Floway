import { openAIResponsesIngress } from '../pipeline.ts';
import { openAIResponsesCompactIngress } from './compact/pipeline.ts';
import { serveHttp } from '../../pipeline/http.ts';

export const openaiResponsesHttp = {
  generate: serveHttp(openAIResponsesIngress),
  compact: serveHttp(openAIResponsesCompactIngress),
};
