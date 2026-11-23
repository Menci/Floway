import { analyzeResponsesAffinity, resolveResponsesCandidates, responsesAffinity, serializeItems } from './ingress.ts';
import { statefulTurn } from './stages/stateful-turn.ts';
import { interruptWebSocketGeneration, type WebSocketGenerationRequest } from './websocket-generation.ts';
import { encodeWebSocketTurn, type WebSocketEncodedTurn } from './websocket-wire.ts';
import { failover } from '../../pipeline/failover.ts';
import type { GatewayServices } from '../../pipeline/services.ts';
import { priceUsage, type SettlementFacts, writeSettlement } from '../../pipeline/settlement.ts';
import { type ChatBodyInput, type ChatBodyOutput, enterChatBody } from '../shared/route-body.ts';
import { compose, type Pipeline, type StaticTarget } from '@floway-dev/pipeline';

export { INTERRUPT_UPSTREAM_ABORT_WARNING_MS } from './websocket-generation.ts';

export interface WebSocketTurnInput extends WebSocketGenerationRequest {
  readonly 'request.ws.eventId': string | undefined;
}

export type WebSocketTurnOutput = WebSocketEncodedTurn & SettlementFacts;
export type WebSocketIngress = Pipeline<WebSocketTurnInput, WebSocketTurnOutput, GatewayServices>;

type Targets = { body: StaticTarget<ChatBodyInput<'openaiResponses'>, ChatBodyOutput<'openaiResponses'>, GatewayServices> };

export const createOpenAIResponsesWsIngress = (
  body: Pipeline<ChatBodyInput<'openaiResponses'>, ChatBodyOutput<'openaiResponses'>, GatewayServices>,
): WebSocketIngress => compose<WebSocketTurnInput, WebSocketTurnOutput, GatewayServices, Targets>('openai-responses.ws.ingress', {
  stages: [
    writeSettlement('chat'), priceUsage, encodeWebSocketTurn, statefulTurn, interruptWebSocketGeneration,
    analyzeResponsesAffinity, resolveResponsesCandidates, failover, responsesAffinity, serializeItems,
  ],
  targets: { body },
  ending: enterChatBody('openaiResponses'),
});
