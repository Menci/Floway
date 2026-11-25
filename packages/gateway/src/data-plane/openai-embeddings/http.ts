import { openAIEmbeddingsPipeline } from './pipeline/index.ts';
import type { AuthedContext } from '../../middleware/auth.ts';
import { servePipeline } from '../pipeline/host.ts';
import { createGatewayServices } from '../pipeline/services.ts';

export const openaiEmbeddings = (c: AuthedContext): Promise<Response> =>
  servePipeline(c, openAIEmbeddingsPipeline, createGatewayServices);
