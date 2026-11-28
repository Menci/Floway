import { resolveReading } from './reading.ts';
import type { SourceReading, RestoredAssistantTurn } from './reading.ts';
import type { IRInputRequestHeader, IRInputTurn } from '../ir/input/types.ts';
import type { IRErrorPayload } from '../ir/output/error.ts';
import type { IRRecord } from '../ir/output/records.ts';
import { createRoundTripCoordinator } from '../round-trip/coordinator.ts';
import type { AssistantTurnProtocol, InputAssistantTurnFor } from '../round-trip/input-assistant-turn.ts';
import type { RoundTripReader } from '../round-trip/reader.ts';
import type { SidecarRecognition } from '../round-trip/resolve.ts';
import { roundTripAssistantTurn } from '../round-trip/resolve.ts';
import type { SourceAssistantTurnFor } from '../round-trip/source-assistant-turn.ts';
import type { RoundTripWriter } from '../round-trip/writer.ts';
import { irErrorPayloadFromBody, restateError } from '../shared/api-error.ts';
import { TranslateInputException } from '../shared/input-error.ts';
import type { TranslateOptions, Translator } from '../types.ts';
import type { ProtocolFrame } from '@floway-dev/protocols/common';

export interface SourceProtocol<Name extends AssistantTurnProtocol, Payload, Event> {
  readonly name: Name;
  readonly read: (payload: Payload) => SourceReading<SourceAssistantTurnFor<Name>>;
  readonly sidecarRecognition: SidecarRecognition<SourceAssistantTurnFor<Name>>;
  readonly writeError: (error: IRErrorPayload, status: number) => { readonly body: unknown; readonly status?: number };
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

export interface TargetProtocol<Name extends AssistantTurnProtocol, Payload, Event, Context = void> {
  readonly name: Name;
  /**
   * Writes the input IR as this protocol's request.
   *
   * A resolved turn arrives as the structure this protocol states natively,
   * paired with the authenticated source-side call IDs needed when this target
   * emits id-less calls whose results later arrive addressed by a source ID.
   */
  readonly write: (
    request: IRInputRequestHeader,
    turns: readonly (IRInputTurn | RestoredAssistantTurn<InputAssistantTurnFor<Name>>)[],
    options: TranslateOptions,
  ) => { readonly payload: Payload; readonly context: Context };
  /** Where request writing allocates names, this context preserves their logical identities for event reading. */
  readonly readEvents: (
    frames: AsyncIterable<ProtocolFrame<Event>>,
    context: Context,
    roundTripReader: RoundTripReader<Name>,
  ) => AsyncIterable<IRRecord>;
  /** Overrides `irErrorPayloadFromBody` for non-streaming HTTP error bodies when this target uses protocol-specific envelopes or fields. */
  readonly readError?: (body: Uint8Array) => IRErrorPayload | undefined;
}

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
    const readError = target.readError ?? irErrorPayloadFromBody;
    return {
      type: 'trip',
      target: targetPayload,
      error: (status, headers, body) => {
        const error = readError(body);
        if (error === undefined) return undefined;
        const restated = source.writeError(error, status);
        return restateError(restated.status ?? status, headers, restated.body);
      },
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
