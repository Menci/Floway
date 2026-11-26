import { openaiCompletionsPipeline } from './pipeline.ts';
import { serveHttp } from '../pipeline/http.ts';

export const openaiCompletions = serveHttp(openaiCompletionsPipeline);
