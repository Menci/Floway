import { analyzeResponsesAffinity, failoverResponses, resolveResponsesCandidates, responsesAffinity, serializeItems } from './ingress.ts';
import { statefulTurn } from './stages/stateful-turn.ts';
import { interruptWebSocketGeneration, type WebSocketGenerationRequest } from './websocket-generation.ts';
import { encodeWebSocketTurn, type WebSocketEncodedTurn } from './websocket-wire.ts';
import { GATEWAY_HTTP_ENTRY } from '../../pipeline/host.ts';
import type { GatewayServices } from '../../pipeline/services.ts';
import { type ChatBodyInput, type ChatBodyOutput, enterChatBody } from '../shared/route-body.ts';
import { compose, type Pipeline } from '@floway-dev/pipeline';

export { INTERRUPT_UPSTREAM_ABORT_WARNING_MS } from './websocket-generation.ts';

export interface WebSocketTurnInput extends WebSocketGenerationRequest {
  readonly 'request.ws.eventId': string | undefined;
}

export type WebSocketTurnOutput = WebSocketEncodedTurn;
export type WebSocketIngress = Pipeline<WebSocketTurnInput, WebSocketTurnOutput, GatewayServices>;

const entry = [...GATEWAY_HTTP_ENTRY, 'request.model', 'request.openaiResponses', 'request.action', 'request.delivery',
  'request.ws.controls', 'request.ws.responseId', 'request.ws.eventId'] as const;
const exit = ['response.http', 'response.render', 'response.delivery'] as const;

export const createOpenAIResponsesWsIngress = (
  body: Pipeline<ChatBodyInput<'openaiResponses'>, ChatBodyOutput<'openaiResponses'>, GatewayServices>,
): WebSocketIngress => compose<WebSocketTurnInput & WebSocketTurnOutput, GatewayServices>()('openai-responses.ws.ingress', {
  entry, exit,
  stages: [
    encodeWebSocketTurn, statefulTurn, interruptWebSocketGeneration,
    analyzeResponsesAffinity, resolveResponsesCandidates, failoverResponses, responsesAffinity, serializeItems,
  ],
  targets: { body },
  ending: enterChatBody('openaiResponses'),
});
