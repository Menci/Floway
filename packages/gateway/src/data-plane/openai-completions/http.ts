import type { AuthedContext } from '../../middleware/auth.ts';
import { servePipeline } from '../pipeline/host.ts';
import { createGatewayServices } from '../pipeline/services.ts';
import { openAICompletionsPipeline } from './pipeline/index.ts';

export const openaiCompletions = (c: AuthedContext): Promise<Response> =>
  servePipeline(c, openAICompletionsPipeline, createGatewayServices);
