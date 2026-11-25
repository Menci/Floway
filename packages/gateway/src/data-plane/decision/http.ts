import type { AuthedContext } from '../../middleware/auth.ts';
import { servePipeline } from '../pipeline/host.ts';
import { createGatewayServices } from '../pipeline/services.ts';
import { createDecisionPipeline } from './pipeline/index.ts';
import type { DecisionProtocol } from '@floway-dev/protocols/common';

export const decision = (protocol: DecisionProtocol) => {
  const pipeline = createDecisionPipeline(protocol);
  return (c: AuthedContext): Promise<Response> => servePipeline(c, pipeline, createGatewayServices);
};
