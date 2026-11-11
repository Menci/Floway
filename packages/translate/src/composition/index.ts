import type { SourceReading } from './reading.ts';
import { resolveReading } from './reading.ts';
import type { RestoredAssistantTurn } from './segments.ts';
import type { IRInputRequestHeader, IRInputTurn } from '../ir/input/types.ts';
import type { IRRecord } from '../ir/output/stream.ts';
import { createRoundTripCoordinator } from '../round-trip/coordinator.ts';
import type { AssistantTurnProtocol, InputAssistantTurnFor } from '../round-trip/input-assistant-turn.ts';
import type { RoundTripReader } from '../round-trip/reader.ts';
import type { SidecarRecognition } from '../round-trip/resolve.ts';
import { roundTripAssistantTurn } from '../round-trip/resolve.ts';
import type { SourceAssistantTurnFor } from '../round-trip/source-assistant-turn.ts';
import type { RoundTripWriter } from '../round-trip/writer.ts';
import type { ApiErrorTranslator, TranslateOptions, Translator } from '../types.ts';
import { TranslateInputException } from '../types.ts';
import type { ProtocolFrame } from '@floway-dev/protocols/common';

/** One protocol as the side a request comes from. */
export interface SourceProtocol<Name extends AssistantTurnProtocol, Payload, Event> {
  readonly name: Name;
  /** Reads the request into the turns it states, each turn's side already decided. */
  readonly read: (payload: Payload) => SourceReading<SourceAssistantTurnFor<Name>>;
  readonly sidecarRecognition: SidecarRecognition<SourceAssistantTurnFor<Name>>;
  readonly error: ApiErrorTranslator;
  /**
   * States the returned stream to this protocol's client.
   *
   * It is handed the payload the client sent, because what the client sees
   * stated back is what it asked for, and the payload is the only place a
   * spelling the reader normalized away — a declaration group, say — survives.
   */
  readonly writeEvents: (
    payload: Payload,
    records: AsyncIterable<IRRecord>,
    roundTrip: RoundTripWriter<Name>,
  ) => AsyncIterable<ProtocolFrame<Event>>;
}

/** One protocol as the side a request goes to. */
export interface TargetProtocol<Name extends AssistantTurnProtocol, Payload, Event, Context = void> {
  readonly name: Name;
  /**
   * Writes the input IR as this protocol's request.
   *
   * A resolved turn arrives as the structure this protocol states natively, so
   * whatever the writer needs to know about it — which calls it answers, say —
   * it reads from there rather than being told separately.
   */
  readonly write: (
    request: IRInputRequestHeader,
    turns: readonly (IRInputTurn | RestoredAssistantTurn<InputAssistantTurnFor<Name>>)[],
    options: TranslateOptions,
  ) => { readonly payload: Payload; readonly context: Context };
  /**
   * Reads this protocol's upstream events into the output IR.
   *
   * It is handed what `write` recorded beside the payload — the names it asked
   * the upstream with, say — because reading a stream has to state those back
   * the way this protocol's client wrote them, and only the writing side knows
   * what it sent. Neither the input IR nor this target's own reader is here:
   * what comes back is the payload's own answer.
   */
  readonly readEvents: (
    frames: AsyncIterable<ProtocolFrame<Event>>,
    context: Context,
    roundTripReader: RoundTripReader<Name>,
  ) => AsyncIterable<IRRecord>;
}

/**
 * Composes one source protocol and one target protocol into a translation trip.
 *
 * This is the only place that names both sides. Everything it calls belongs to
 * one of them, so a route states a pair as two values.
 */
export const composeTranslation = <
  SrcName extends AssistantTurnProtocol, SrcPayload, SrcEvent,
  TgtName extends AssistantTurnProtocol, TgtPayload extends { model: string }, TgtEvent, Context,
>(
  source: SourceProtocol<SrcName, SrcPayload, SrcEvent>,
  target: TargetProtocol<TgtName, TgtPayload, TgtEvent, Context>,
): Translator<SrcPayload, SrcEvent, TgtPayload, TgtEvent> => async (payload, options) => {
  try {
    const reading = source.read(payload);
    const { payload: targetPayload, context } = target.write(
      reading.request, await resolveReading(reading, turn => roundTripAssistantTurn(
        source.name, target.name, turn.assistantTurn, options.sidecarCodec, source.sidecarRecognition,
      )), options,
    );
    return {
      type: 'trip',
      target: targetPayload,
      error: source.error,
      events: frames => {
        const coordinator = createRoundTripCoordinator(source.name, target.name, options.sidecarCodec);
        return source.writeEvents(payload, target.readEvents(frames, context, coordinator.reader), coordinator.writer);
      },
    };
  } catch (error) {
    if (error instanceof TranslateInputException) return error.failure;
    throw error;
  }
};
