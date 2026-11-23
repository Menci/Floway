import type { ResponsesRequest } from './ingress.ts';
import type { ResponsesTurnBack } from './stages/stateful-turn.ts';
import type { WebSocketInterrupt, WebSocketInterruptAccepted } from './websocket-wire.ts';
import { isTransportFailure } from '@floway-dev/http';
import { defineStage, type ManagedStream, type Scope } from '@floway-dev/pipeline';
import { eventFrame } from '@floway-dev/protocols/common';
import {
  isOpenAIResponsesTerminalEvent,
  type OpenAIResponsesOutputItemEx,
  type OpenAIResponsesResultEx,
  type OpenAIResponsesStreamEventEx,
} from '@floway-dev/protocols/openai-responses';
import type { ProviderFrame } from '@floway-dev/provider';

export const INTERRUPT_UPSTREAM_ABORT_WARNING_MS = 5_000;

export interface WebSocketGenerationRequest extends ResponsesRequest {
  readonly 'request.ws.responseId': string;
  readonly 'request.ws.controls': ManagedStream<WebSocketInterrupt>;
}

type Frame = ProviderFrame<OpenAIResponsesStreamEventEx>;
type Read = { readonly kind: 'event'; readonly result: IteratorResult<Frame> }
  | { readonly kind: 'control'; readonly result: IteratorResult<WebSocketInterrupt> }
  | { readonly kind: 'error'; readonly error: unknown };

// Codex expects an acknowledgement, each pending item interrupted, and an
// incomplete response containing only completed items.
// https://github.com/openai/codex/blob/12de0e395d3313bc564190d983cb4f5acf0be713/codex-rs/core/tests/suite/pending_input.rs#L1140-L1168
const mergeGeneration = async function* (
  source: AsyncIterable<Frame>,
  controls: AsyncIterable<WebSocketInterrupt>,
  signal: AbortSignal,
  responseId: string,
  model: string,
  cancelGeneration: () => void,
): AsyncGenerator<Frame | WebSocketInterruptAccepted> {
  const events = source[Symbol.asyncIterator]();
  const control = controls[Symbol.asyncIterator]();
  const completedItems = new Map<number, OpenAIResponsesOutputItemEx>();
  const pendingItems = new Map<number, string>();
  let response: OpenAIResponsesResultEx | undefined;
  let nextSequence = 0;
  let terminal = false;
  let interrupted = false;
  const ready: Read[] = [];
  let wake: (() => void) | undefined;
  const onAbort = () => wake?.();
  const receive = (read: Read) => {
    ready.push(read);
    wake?.();
  };
  const readEvent = () => {
    void events.next().then(
      result => receive({ kind: 'event', result }),
      (error: unknown) => receive({ kind: 'error', error }),
    );
  };
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    readEvent();
    void control.next().then(
      result => receive({ kind: 'control', result }),
      (error: unknown) => receive({ kind: 'error', error }),
    );
    while (!signal.aborted) {
      if (ready.length === 0) {
        await new Promise<void>(resolve => { wake = resolve; });
        wake = undefined;
      }
      const read = ready.shift();
      if (read === undefined || signal.aborted) return;
      if (read.kind === 'control') {
        if (read.result.done || terminal) continue;
        // The socket advances the stream after sending the acknowledgement.
        yield { type: 'control', interrupt: read.result.value };
        if (signal.aborted) return;
        cancelGeneration();
        interrupted = true;
        continue;
      }
      if (interrupted) break;
      if (read.kind === 'error') throw read.error;
      if (read.result.done) return;
      const frame = read.result.value;
      if (isTransportFailure(frame)) {
        yield frame;
        return;
      }
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
        if (isOpenAIResponsesTerminalEvent(event)) terminal = true;
      }
      yield frame;
      readEvent();
    }
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
  if (!interrupted || signal.aborted) return;
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

const cancelGeneration = (
  generation: AbortController, ended: Promise<void>, log: Scope['log'], responseId: string, model: string,
) => {
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
};

export const interruptWebSocketGeneration = defineStage<
  WebSocketGenerationRequest, Omit<WebSocketGenerationRequest, 'request.ws.controls'>, ResponsesTurnBack, ResponsesTurnBack<WebSocketInterruptAccepted>
>({
  name: 'interruptGeneration',
  through: {
    request: {
      needs: ['request.openaiResponses', 'request.ws.controls', 'request.ws.responseId'],
      consumes: ['request.ws.controls'],
      provides: [],
    },
    response: { needs: ['response.openaiResponses'], consumes: [], provides: ['response.openaiResponses'] },
  },
  execute: async ({ 'request.ws.controls': controls, ...facts }, scope) => {
    const generation = new AbortController();
    const response = await scope.next(facts, { signal: generation.signal });
    const outcome = response['response.openaiResponses'];
    if (outcome.kind !== 'stream') {
      await controls.close();
      return response;
    }
    const model = facts['request.openaiResponses'].model;
    const responseId = facts['request.ws.responseId'];
    const ended = Promise.withResolvers<void>();
    return {
      ...response,
      'response.openaiResponses': {
        kind: 'stream',
        events: scope.wrapStream({ events: outcome.events, controls }, {
          label: 'interruptible Responses generation',
          transform: (sources, scope) => mergeGeneration(
            sources.events, sources.controls, scope.signal, responseId, model,
            () => cancelGeneration(generation, ended.promise, scope.log, responseId, model),
          ),
          onClose: () => ended.resolve(),
        }),
      },
    };
  },
});
