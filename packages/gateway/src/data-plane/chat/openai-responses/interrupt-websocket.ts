import { OPENAI_RESPONSES_STREAMED_USAGE, type Fields } from './facts.ts';
import type { ChatServices } from '../services.ts';
import { answerWithFrames } from '../shared/frames.ts';
import { defer, defineStage, move } from '@floway-dev/pipeline';
import { eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import { isOpenAIResponsesTerminalEvent, type CanonicalOpenAIResponsesPayload, type OpenAIResponsesOutputItemEx, type OpenAIResponsesResultEx, type OpenAIResponsesStreamEventEx } from '@floway-dev/protocols/openai-responses';

export const INTERRUPT_UPSTREAM_ABORT_WARNING_MS = 5_000;

export interface OpenAIResponsesWebSocketInterruption {
  readonly responseId: string;
  readonly eventId: string | undefined;
}

/**
 * The connection's handle on the turn it is running. The connection routes a client's
 * `response.interrupt` to it, the projection names the response the client was told about and
 * acknowledges the interrupt in its own sequence space, and the stage below the egress stops the
 * upstream and closes the turn with what had completed.
 */
export interface OpenAIResponsesWebSocketTurn {
  /** The id `response.created` gave the client, once it has gone out. */
  readonly responseId: string | undefined;
  readonly interruption: OpenAIResponsesWebSocketInterruption | undefined;
  /** The turn reached its terminal event, or ended on a standalone `error` event, so an
   *  interrupt can no longer change it. */
  readonly ended: boolean;
  readonly interrupted: Promise<OpenAIResponsesWebSocketInterruption>;
  announce(responseId: string): void;
  /** Records the interrupt and cancels the upstream through the turn's abort controller. */
  interrupt(interruption: OpenAIResponsesWebSocketInterruption): void;
  end(): void;
}

export interface OpenAIResponsesWebSocketServices extends ChatServices {
  readonly openaiResponsesWebSocketTurn: OpenAIResponsesWebSocketTurn;
}

export const createOpenAIResponsesWebSocketTurn = (abortController: AbortController): OpenAIResponsesWebSocketTurn => {
  let responseId: string | undefined;
  let interruption: OpenAIResponsesWebSocketInterruption | undefined;
  let ended = false;
  const requested = Promise.withResolvers<OpenAIResponsesWebSocketInterruption>();
  return {
    get responseId() { return responseId; },
    get interruption() { return interruption; },
    get ended() { return ended; },
    interrupted: requested.promise,
    announce: id => { responseId = id; },
    interrupt: value => {
      interruption = value;
      requested.resolve(value);
      abortController.abort(new Error('Responses generation interrupted by the client.'));
    },
    end: () => { ended = true; },
  };
};

/**
 * Below the egress, so what an interrupted turn keeps passes through the same persistence as a
 * finished one: every item that reached `output_item.done` is stored, the snapshot a
 * continuation reads commits with exactly those items, and the response id the client was given
 * applies to the closing resource.
 *
 * An interrupted turn is the client's decision rather than a failure of the upstream it stopped,
 * so the abort that stopped the upstream does not mark its usage failed.
 */
export const interruptOpenAIResponsesWebSocket = defineStage<
  Fields<'request.chat.openaiResponses'>,
  Fields<'request.chat.openaiResponses'>,
  Fields<'response.chat.openaiResponses' | 'response.chat.openaiResponses.streamedUsage'>,
  Fields<'response.chat.openaiResponses' | 'response.chat.openaiResponses.streamedUsage'>,
  OpenAIResponsesWebSocketServices
>({
  name: 'interruptOpenAIResponsesWebSocket',
  through: {
    request: { needs: ['request.chat.openaiResponses'], consumes: [], provides: [] },
    response: {
      needs: ['response.chat.openaiResponses', OPENAI_RESPONSES_STREAMED_USAGE],
      consumes: [],
      provides: ['response.chat.openaiResponses', OPENAI_RESPONSES_STREAMED_USAGE],
    },
  },
  execute: async (facts, next, use) => {
    const { model } = facts['request.chat.openaiResponses'] as CanonicalOpenAIResponsesPayload;
    const turn = use.openaiResponsesWebSocketTurn;
    const back = await next(facts);
    const answer = answerWithFrames<OpenAIResponsesStreamEventEx>(
      back['response.chat.openaiResponses'],
      frames => interruptibleFrames(frames, turn, model),
    );
    if (answer === null) return back;
    const reading = back[OPENAI_RESPONSES_STREAMED_USAGE];
    return {
      ...back,
      'response.chat.openaiResponses': move(answer),
      [OPENAI_RESPONSES_STREAMED_USAGE]: reading === null
        ? null
        : move(defer(reading.then(outcome => turn.interruption === undefined ? outcome : { ...outcome, failed: false }))),
    };
  },
});

const interruptibleFrames = async function* (
  frames: AsyncIterable<ProtocolFrame<OpenAIResponsesStreamEventEx>>,
  turn: OpenAIResponsesWebSocketTurn,
  model: string,
): AsyncGenerator<ProtocolFrame<OpenAIResponsesStreamEventEx>> {
  const completedItems = new Map<number, OpenAIResponsesOutputItemEx>();
  const pendingItems = new Map<number, string>();
  let response: OpenAIResponsesResultEx | undefined;
  let nextSequence = 0;
  let upstreamStopped = false;
  let stopWarning: ReturnType<typeof setTimeout> | undefined;
  // The abort is cooperative: the upstream iterator still has to unwind before the turn can
  // close, and a provider that takes long to do so is worth hearing about.
  void turn.interrupted.then(({ responseId }) => {
    if (upstreamStopped) return;
    const requestedAt = Date.now();
    stopWarning = setTimeout(() => {
      console.warn('Floway: Responses WebSocket interrupt is still waiting for the upstream stream to stop after abort', {
        responseId,
        model,
        waitedMs: Date.now() - requestedAt,
      });
    }, INTERRUPT_UPSTREAM_ABORT_WARNING_MS);
  });

  try {
    for await (const frame of frames) {
      if (turn.interruption !== undefined) break;
      if (frame.type !== 'event') {
        yield frame;
        continue;
      }
      const event = frame.event;
      if (typeof event.sequence_number === 'number') nextSequence = Math.max(nextSequence, event.sequence_number + 1);
      if ('response' in event) response = event.response;
      if (event.type === 'response.output_item.added' && typeof event.item.id === 'string') pendingItems.set(event.output_index, event.item.id);
      if (event.type === 'response.output_item.done') {
        pendingItems.delete(event.output_index);
        completedItems.set(event.output_index, event.item);
      }
      if (isOpenAIResponsesTerminalEvent(event)) turn.end();
      yield frame;
    }
  } catch (error) {
    if (turn.interruption === undefined) throw error;
  } finally {
    upstreamStopped = true;
    clearTimeout(stopWarning);
  }

  const interruption = turn.interruption;
  if (interruption === undefined) return;
  // The client is told about a response only through `response.created`, which carried the
  // resource through here before the interrupt that names it could arrive.
  if (response === undefined) throw new Error('OpenAI Responses WebSocket interrupt arrived before the response was announced');

  // The server acknowledges the control, terminates each pending item, then closes the turn
  // with `response.incomplete` and reason `interrupted`.
  // https://github.com/openai/codex/blob/12de0e395d3313bc564190d983cb4f5acf0be713/codex-rs/core/tests/suite/pending_input.rs#L1140-L1168
  for (const [outputIndex, itemId] of [...pendingItems].sort(([left], [right]) => left - right)) {
    yield eventFrame({
      type: 'response.output_item.interrupted',
      response_id: interruption.responseId,
      item_id: itemId,
      output_index: outputIndex,
      sequence_number: nextSequence++,
    });
  }
  turn.end();
  yield eventFrame({
    type: 'response.incomplete',
    sequence_number: nextSequence,
    response: {
      ...response,
      status: 'incomplete',
      output: [...completedItems].sort(([left], [right]) => left - right).map(([, item]) => item),
      error: null,
      incomplete_details: { reason: 'interrupted' },
    },
  });
};
