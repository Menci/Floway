import type { AuthedContext } from '../../middleware/auth.ts';
import { servePipeline } from '../pipeline/host.ts';
import { createGatewayServices } from '../pipeline/services.ts';
import { openAIImagesEditsPipeline } from './pipeline/edits/index.ts';
import { openAIImagesGenerationsPipeline } from './pipeline/generations/index.ts';

export const openaiImagesGenerations = (c: AuthedContext): Promise<Response> =>
  servePipeline(c, openAIImagesGenerationsPipeline, createGatewayServices);

export const openaiImagesEdits = (c: AuthedContext): Promise<Response> =>
  servePipeline(c, openAIImagesEditsPipeline, createGatewayServices);
