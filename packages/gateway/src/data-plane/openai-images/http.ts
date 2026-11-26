import { openaiImagesEditsPipeline, openaiImagesGenerationsPipeline } from './pipeline.ts';
import { serveHttp } from '../pipeline/http.ts';

export const openaiImagesGenerations = serveHttp(openaiImagesGenerationsPipeline);
export const openaiImagesEdits = serveHttp(openaiImagesEditsPipeline);
