import type { GatewayServices } from '../pipeline/services.ts';
import type { ChatGatewayCtx } from './shared/gateway-ctx.ts';
import type { ModelCandidate, ProviderChatServices } from '@floway-dev/provider';

export interface ChatServices extends GatewayServices, ProviderChatServices {
  readonly gateway: ChatGatewayCtx;
  readonly selectAffinity: (candidate: ModelCandidate) => void;
}
