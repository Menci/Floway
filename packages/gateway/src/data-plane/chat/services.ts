import type { GatewayServices } from '../pipeline/services.ts';
import type { ChatGatewayCtx } from './shared/gateway-ctx.ts';
import type { AttemptSelector } from '../pipeline/facts.ts';
import type { ModelCandidate } from '@floway-dev/provider';

/** What a chat family needs beyond the shared services: the affinity selection this run
 *  made, so the stage that dials can ask for the payload the winning candidate is owed. */
export interface ChatServices extends GatewayServices {
  readonly gateway: ChatGatewayCtx;
  readonly rememberChatSelection: (payloadFor: (candidate: ModelCandidate) => unknown) => void;
  readonly chatPayloadFor: (selector: AttemptSelector) => unknown;
  readonly selectAffinity: (candidate: ModelCandidate) => void;
}
