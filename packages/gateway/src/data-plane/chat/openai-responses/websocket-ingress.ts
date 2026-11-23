import { analyzeResponsesAffinity, type ResponsesRequest, resolveResponsesCandidates, responsesAffinity, serializeItems } from './ingress.ts';
import { persistResponsesEvents, prepareResponsesTurn, type ResponsesTurnBack } from './stages/stateful-turn.ts';
import { encodeWebSocketTurn, type WebSocketEncodedTurn, type WebSocketInterrupt } from './websocket-wire.ts';
import { answerKeys } from '../../pipeline/answer.ts';
import { failover } from '../../pipeline/failover.ts';
import type { GatewayServices } from '../../pipeline/services.ts';
import { priceUsage, type SettlementFacts, writeSettlement } from '../../pipeline/settlement.ts';
import { type ChatBodyInput, type ChatBodyOutput, enterChatBody } from '../shared/route-body.ts';
import { compose, defineStage, type ManagedStream, type Pipeline, type StageEnv, type StaticTarget } from '@floway-dev/pipeline';
import { eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import {
  isOpenAIResponsesTerminalEvent,
  type OpenAIResponsesOutputItemEx,
  type OpenAIResponsesResultEx,
  type OpenAIResponsesStreamEventEx,
} from '@floway-dev/protocols/openai-responses';

export const INTERRUPT_UPSTREAM_ABORT_WARNING_MS = 5_000;

export interface WebSocketTurnInput extends ResponsesRequest {
  readonly 'request.ws.responseId': string;
  readonly 'request.ws.controls': ManagedStream<WebSocketInterrupt>;
  readonly 'request.ws.eventId': string | undefined;
}

export type WebSocketTurnOutput = WebSocketEncodedTurn & SettlementFacts;
export type WebSocketIngress = Pipeline<WebSocketTurnInput, WebSocketTurnOutput, GatewayServices>;

type GenerationRequest = Omit<WebSocketTurnInput, 'request.ws.controls' | 'request.ws.responseId' | 'request.ws.eventId'>;

// Codex expects an acknowledgement, each pending item interrupted, and an
// incomplete response containing only completed items.
// https://github.com/openai/codex/blob/12de0e395d3313bc564190d983cb4f5acf0be713/codex-rs/core/tests/suite/pending_input.rs#L1140-L1168
const interruptibleGeneration = (
  responseId: string, model: string, generation: AbortController, ended: Promise<number | null>, log: StageEnv['log'],
) => {
  let state: 'generating' | 'interrupting' | 'terminal' = 'generating';
  const interrupted = Promise.withResolvers<void>();
  const startInterrupt = () => {
    if (state !== 'generating') return false;
    state = 'interrupting';
    return true;
  };
  const cancelGeneration = () => {
    const requestedAt = Date.now();
    const warning = setTimeout(() => {
      const message = 'Floway: Responses WebSocket interrupt is still waiting for the upstream stream to stop after abort';
      const fields = { responseId, model, waitedMs: Date.now() - requestedAt };
      console.warn(message, fields);
      log.warn(message, fields);
    }, INTERRUPT_UPSTREAM_ABORT_WARNING_MS);
    const clearWarning = () => clearTimeout(warning);
    void ended.then(clearWarning, clearWarning);
    generation.abort(new Error('Responses generation interrupted by the client.'));
    interrupted.resolve();
  };
  const frames = async function* (
    source: AsyncIterable<ProtocolFrame<OpenAIResponsesStreamEventEx>>, signal: AbortSignal,
  ): AsyncGenerator<ProtocolFrame<OpenAIResponsesStreamEventEx>> {
    const completedItems = new Map<number, OpenAIResponsesOutputItemEx>();
    const pendingItems = new Map<number, string>();
    let response: OpenAIResponsesResultEx | undefined;
    let nextSequence = 0;
    try {
      for await (const frame of source) {
        if (state === 'interrupting') break;
        if (frame.type === 'event') {
          const event = frame.event;
          if (typeof event.sequence_number === 'number') nextSequence = Math.max(nextSequence, event.sequence_number + 1);
          if ('response' in event) response = event.response;
          if (event.type === 'response.output_item.added' && typeof event.item.id === 'string') {
            pendingItems.set(event.output_index, event.item.id);
          }
          if (event.type === 'response.output_item.done') {
            pendingItems.delete(event.output_index);
            completedItems.set(event.output_index, event.item);
          }
          if (isOpenAIResponsesTerminalEvent(event)) state = 'terminal';
        }
        yield frame;
      }
    } catch (error) {
      if (state !== 'interrupting') {
        state = 'terminal';
        throw error;
      }
    }
    if (state !== 'interrupting' || signal.aborted) {
      state = 'terminal';
      return;
    }
    // The encoder signals cancellation on the pull after acknowledgement.
    // Release also wakes this wait when sending that acknowledgement failed.
    const wake = () => interrupted.resolve();
    signal.addEventListener('abort', wake, { once: true });
    try {
      await interrupted.promise;
    } finally {
      signal.removeEventListener('abort', wake);
    }
    if (signal.aborted) return;
    state = 'terminal';
    for (const [outputIndex, itemId] of [...pendingItems].sort(([left], [right]) => left - right)) {
      yield eventFrame<OpenAIResponsesStreamEventEx>({
        type: 'response.output_item.interrupted',
        response_id: responseId,
        item_id: itemId,
        output_index: outputIndex,
        sequence_number: nextSequence++,
      });
    }
    yield eventFrame<OpenAIResponsesStreamEventEx>({
      type: 'response.incomplete',
      sequence_number: nextSequence,
      response: {
        ...response,
        id: responseId,
        object: 'response',
        model: response?.model ?? model,
        status: 'incomplete',
        output: [...completedItems].sort(([left], [right]) => left - right).map(([, item]) => item),
        error: null,
        incomplete_details: { reason: 'interrupted' },
      },
    });
  };
  return { startInterrupt, cancelGeneration, frames };
};

type EncodedTurn = Omit<ResponsesTurnBack, 'response.openaiResponses'> & WebSocketEncodedTurn;
const encodedKeys = ['response.http', 'response.render', 'response.delivery'];

const serveWebSocketTurn = defineStage<WebSocketTurnInput, GenerationRequest, ResponsesTurnBack, EncodedTurn, Pick<GatewayServices, 'responsesStore'>>({
  name: 'encode',
  through: {
    request: {
      needs: ['request.openaiResponses', 'request.delivery', 'request.ws.controls', 'request.ws.responseId', 'request.ws.eventId'],
      consumes: ['request.ws.controls', 'request.ws.responseId', 'request.ws.eventId'],
      provides: ['request.openaiResponses'],
    },
    response: { needs: ['response.http'], consumes: ['response.openaiResponses'], provides: encodedKeys },
  },
  return: { provides: [...answerKeys, 'response.delivery'] },
  execute: async (input, next, env) => {
    const {
      'request.ws.controls': controls, 'request.ws.responseId': responseId, 'request.ws.eventId': eventId, ...facts
    } = input;
    const original = input['request.openaiResponses'];
    const store = env.services.responsesStore({ kind: 'http', store: original.store ?? undefined });
    const generation = new AbortController();
    let response: ResponsesTurnBack;
    try {
      const prepared = await prepareResponsesTurn(original, store, env);
      response = 'failure' in prepared ? prepared.failure
        : await next({ ...facts, 'request.openaiResponses': prepared.payload }, { signal: generation.signal });
    } catch (error) {
      if (!env.signal.aborted) await controls.close();
      throw error;
    }
    const { 'response.openaiResponses': events, ...back } = response;
    if (events === undefined) {
      if (!env.signal.aborted) await controls.close();
      return { ...back, ...await encodeWebSocketTurn(env, back['response.http'], eventId) };
    }

    const interrupt = interruptibleGeneration(responseId, original.model, generation, back['response.timing.streamEndedAt'].promise, env.log);
    const encoded = await encodeWebSocketTurn(env, back['response.http'], eventId, {
      events,
      controls,
      startInterrupt: interrupt.startInterrupt,
      cancelGeneration: interrupt.cancelGeneration,
      persist: (source, signal) => persistResponsesEvents(interrupt.frames(source, signal), store, responseId, original, facts['request.delivery']),
    });
    return { ...back, ...encoded };
  },
});

type Targets = { body: StaticTarget<ChatBodyInput<'openaiResponses'>, ChatBodyOutput<'openaiResponses'>, GatewayServices> };

export const createOpenAIResponsesWsIngress = (
  body: Pipeline<ChatBodyInput<'openaiResponses'>, ChatBodyOutput<'openaiResponses'>, GatewayServices>,
): WebSocketIngress => compose<WebSocketTurnInput, WebSocketTurnOutput, GatewayServices, Targets>('openai-responses.ws.ingress', {
  stages: [
    writeSettlement('chat'), priceUsage, serveWebSocketTurn,
    analyzeResponsesAffinity, resolveResponsesCandidates, failover, responsesAffinity, serializeItems,
  ],
  targets: { body },
  ending: enterChatBody('openaiResponses'),
});
