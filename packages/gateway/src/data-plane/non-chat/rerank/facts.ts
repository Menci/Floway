import type { GatewayRequestFacts, GatewayResponseFacts } from '../../pipeline/facts.ts';
import type { GatewayServices } from '../../pipeline/services.ts';
import { factSpace } from '@floway-dev/pipeline';
import type { RerankProtocol, RerankSourceProtocol } from '@floway-dev/protocols/common';

export const { compose, defineStage } = factSpace<
  GatewayRequestFacts & { rerankDialect: RerankSourceProtocol },
  GatewayResponseFacts & { rerankTargetDialect: RerankProtocol },
  GatewayServices
>();
