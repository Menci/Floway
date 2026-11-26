import { openaiEmbeddingsPipeline } from './pipeline.ts';
import { serveHttp } from '../pipeline/http.ts';

export const openaiEmbeddings = serveHttp(openaiEmbeddingsPipeline);
