import type { GatewayRequestFacts, GatewayResponseFacts } from '../../pipeline/facts.ts';
import type { GatewayServices } from '../../pipeline/services.ts';
import { factSpace } from '@floway-dev/pipeline';
import type { DecisionProtocol } from '@floway-dev/protocols/common';

export const { compose, defineStage } = factSpace<
  GatewayRequestFacts & { decisionDialect: DecisionProtocol },
  GatewayResponseFacts,
  GatewayServices
>();
