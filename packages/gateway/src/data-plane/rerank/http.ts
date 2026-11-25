import type { AuthedContext } from '../../middleware/auth.ts';
import { servePipeline } from '../pipeline/host.ts';
import { createGatewayServices } from '../pipeline/services.ts';
import { createRerankPipeline } from './pipeline/index.ts';
import type { RerankSourceProtocol } from '@floway-dev/protocols/common';

export const rerank = (protocol: RerankSourceProtocol) => {
  const pipeline = createRerankPipeline(protocol);
  return (c: AuthedContext): Promise<Response> => servePipeline(c, pipeline, createGatewayServices);
};
