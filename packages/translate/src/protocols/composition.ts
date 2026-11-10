import type { Reading } from './composition/reading.ts';
import { resolveReading } from './composition/reading.ts';
import type { ResolvedTurn } from './composition/segments.ts';
import type { IRInputRequestHeader, IRInputTurn } from '../ir/input/types.ts';
import type { IRRecord } from '../ir/output/stream.ts';
import type { AssistantTurnProtocol, InputAssistantTurnFor } from '../round-trip/assistant-turn.ts';
import type { ReplayContent } from '../round-trip/reference/assistant-turn.ts';
import type { SidecarCarrier } from '../round-trip/resolve.ts';
import { roundTripAssistantTurn } from '../round-trip/resolve.ts';
import type { SourceAssistantTurnFor } from '../round-trip/source-assistant-turn.ts';
import type { RoundTripReader, RoundTripWriter } from '../round-trip/stream.ts';
import { createRoundTripStream } from '../round-trip/stream.ts';
import type { RoundTripTurnDigest } from '../round-trip/turn-digest.ts';
import type { RestateSourceError, TranslateOptions, TranslateTrip } from '../types.ts';
import type { FlatCallContext } from './composition/flatten-request.ts';
import type { ProtocolFrame } from '@floway-dev/protocols/common';

/**
 * How one protocol carries a sidecar on its own assistant turns.
 *
 * These take the structure the source wrote, because that is what a sidecar is
 * computed over: the turn digest hashes it and the references are cut from it,
 * so none of this can work from an IR turn.
 */
export interface SidecarRecognition<Name extends AssistantTurnProtocol> {
  readonly inspect: (turn: SourceAssistantTurnFor<Name>) => SidecarCarrier<SourceAssistantTurnFor<Name>>[];
  readonly verify: (turn: SourceAssistantTurnFor<Name>, digest: RoundTripTurnDigest, version: number) => Promise<boolean>;
  readonly collectCandidates: (turn: SourceAssistantTurnFor<Name>) => ReplayContent[];
}

/** One protocol as the side a request comes from. */
export interface SourceProtocol<Name extends AssistantTurnProtocol, Payload, Event> {
  readonly name: Name;
  /** Reads the request into the turns it states, each turn's side already decided. */
  readonly read: (payload: Payload) => Reading<SourceAssistantTurnFor<Name>>;
  readonly sidecarRecognition: SidecarRecognition<Name>;
  readonly restateUpstreamError: RestateSourceError;
  /**
   * States the returned stream to this protocol's client.
   *
   * It is handed the payload the client sent, because what the client sees
   * stated back is what it asked for, and the payload is the only place a
   * spelling the reader normalized away — a declaration group, say — survives.
   */
  readonly writeStream: (
    payload: Payload,
    records: AsyncIterable<IRRecord>,
    roundTrip: RoundTripWriter<Name>,
  ) => AsyncIterable<ProtocolFrame<Event>>;
}

/** What a target recorded while writing, for the reader of its own stream. */
export type TargetReadState<Name extends keyof TargetReadStateByProtocol> = TargetReadStateByProtocol[Name];

/** Each target's own context shape; a protocol that needs none states `void`. */
export interface TargetReadStateByProtocol {
  readonly anthropicMessages: FlatCallContext;
  readonly openaiChatCompletions: FlatCallContext;
  readonly openaiResponses: void;
  // GenerateContent is a source only, so it never states a target context.
  readonly geminiGenerateContent: void;
}

/**
 * What writing a request produced.
 *
 * The payload is what the upstream is asked; the context is what reading its
 * answer needs, and only this target knows what that is.
 */
export interface TargetWriteResult<Payload, Name extends keyof TargetReadStateByProtocol> {
  readonly payload: Payload;
  readonly context: TargetReadState<Name>;
}

/** One protocol as the side a request goes to. */
export interface TargetProtocol<Name extends AssistantTurnProtocol, Payload, Event> {
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
    turns: readonly (IRInputTurn | ResolvedTurn<InputAssistantTurnFor<Name>>)[],
    options: TranslateOptions,
  ) => TargetWriteResult<Payload, Name>;
  /**
   * Reads this protocol's upstream events into the output IR.
   *
   * It is handed what `write` recorded beside the payload — the names it asked
   * the upstream with, say — because reading a stream has to state those back
   * the way this protocol's client wrote them, and only the writing side knows
   * what it sent. Neither the input IR nor this target's own reader is here:
   * what comes back is the payload's own answer.
   */
  readonly readStream: (
    frames: AsyncIterable<ProtocolFrame<Event>>,
    context: TargetReadState<Name>,
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
  TgtName extends AssistantTurnProtocol, TgtPayload extends { model: string }, TgtEvent,
>(
  source: SourceProtocol<SrcName, SrcPayload, SrcEvent>,
  target: TargetProtocol<TgtName, TgtPayload, TgtEvent>,
): TranslateTrip<SrcPayload, SrcEvent, TgtPayload, TgtEvent> => async (payload, options) => {
  const reading = source.read(payload);
  const { payload: targetPayload, context } = target.write(
    reading.request, await resolveReadingTurns(source, target, reading, options), options,
  );
  return {
    target: targetPayload,
    restateUpstreamError: source.restateUpstreamError,
    events: frames => {
      const stream = createRoundTripStream(source.name, target.name, options.sidecarCodec);
      return source.writeStream(payload, target.readStream(frames, context, stream.reader), stream.writer);
    },
  };
};

/**
 * Settles every assistant slot that carries a sidecar this target can restore.
 *
 * A slot whose sidecar was recognised is written natively by the target; one
 * that carries no sidecar for this target falls back to the IR its own thunk
 * builds. The two paths are exclusive, which is why the thunk is only called on
 * the second.
 */
const resolveReadingTurns = async <
  SrcName extends AssistantTurnProtocol, SrcPayload, SrcEvent,
  TgtName extends AssistantTurnProtocol, TgtPayload, TgtEvent,
>(
  source: SourceProtocol<SrcName, SrcPayload, SrcEvent>,
  target: TargetProtocol<TgtName, TgtPayload, TgtEvent>,
  reading: Reading<SourceAssistantTurnFor<SrcName>>,
  options: TranslateOptions,
): Promise<(IRInputTurn | ResolvedTurn<InputAssistantTurnFor<TgtName>>)[]> =>
  await resolveReading(reading, async (turn): Promise<
    { readonly resolved: InputAssistantTurnFor<TgtName> } | undefined
  > => {
    const resolved = await roundTripAssistantTurn(
      source.name, target.name, turn.assistantTurn, options.sidecarCodec, source.sidecarRecognition,
    );
    return resolved === undefined ? undefined : { resolved };
  });

/**
 * The request half of a composed trip, stated on its own.
 *
 * A pair's request translation is worth testing without the event side, and
 * this states exactly that step. It is the same code `composeTranslation` runs.
 */
export const buildTargetPayloadFor = async <
  SrcName extends AssistantTurnProtocol, SrcPayload, SrcEvent,
  TgtName extends AssistantTurnProtocol, TgtPayload, TgtEvent,
>(
  source: SourceProtocol<SrcName, SrcPayload, SrcEvent>,
  target: TargetProtocol<TgtName, TgtPayload, TgtEvent>,
  payload: SrcPayload,
  options: TranslateOptions,
  // Reading is stateful, so a caller that also inspects what it recorded passes
  // the same reading rather than opening a second one.
  reading: Reading<SourceAssistantTurnFor<SrcName>> = source.read(payload),
): Promise<TgtPayload> =>
  target.write(reading.request, await resolveReadingTurns(source, target, reading, options), options).payload;

/**
 * The event half of a composed trip, stated on its own.
 *
 * It is the same code `composeTranslation` runs, including the reading that the
 * client-side writer may need.
 */
export const buildSourceEventsFor = <
  SrcName extends AssistantTurnProtocol, SrcPayload, SrcEvent,
  TgtName extends AssistantTurnProtocol, TgtPayload, TgtEvent,
>(
  source: SourceProtocol<SrcName, SrcPayload, SrcEvent>,
  target: TargetProtocol<TgtName, TgtPayload, TgtEvent>,
  payload: SrcPayload,
  options: TranslateOptions,
  frames: AsyncIterable<ProtocolFrame<TgtEvent>>,
): AsyncIterable<ProtocolFrame<SrcEvent>> => {
  const reading = source.read(payload);
  const stream = createRoundTripStream(source.name, target.name, options.sidecarCodec);
  // Stating the answer needs what writing the request recorded, so this walks
  // the same writing step the composed trip does.
  return (async function* () {
    const { context } = target.write(reading.request, await resolveReadingTurns(source, target, reading, options), options);
    yield* source.writeStream(payload, target.readStream(frames, context, stream.reader), stream.writer);
  })();
};
