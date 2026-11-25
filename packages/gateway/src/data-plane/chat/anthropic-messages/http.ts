import { anthropicMessagesCountTokensPipeline } from './pipeline/count-tokens.ts';
import { anthropicMessagesPipeline } from './pipeline/index.ts';
import type { AuthedContext } from '../../../middleware/auth.ts';
import { servePipeline } from '../../pipeline/host.ts';
import { createGatewayServices } from '../../pipeline/services.ts';

export const anthropicMessagesHttp = {
  generate: (c: AuthedContext): Promise<Response> => servePipeline(c, anthropicMessagesPipeline, createGatewayServices),
  countTokens: (c: AuthedContext): Promise<Response> => servePipeline(c, anthropicMessagesCountTokensPipeline, createGatewayServices),
};
