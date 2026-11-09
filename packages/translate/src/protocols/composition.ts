import type { IRInputReading } from '../ir/input/reading.ts';
import { readTurns } from '../ir/input/reading.ts';
import type { IRInputResolvedTurn } from '../ir/input/segments.ts';
import type { IRInputRequest, IRInputTurn } from '../ir/input/types.ts';
import type { IRRecord } from '../ir/output/stream.ts';
import type { AssistantTurnByProtocol, AssistantTurnFor } from '../round-trip/assistant-turn.ts';
import type { ReplayContent } from '../round-trip/reference/assistant-turn.ts';
import type { EncodedRoundTripSidecar } from '../round-trip/resolve.ts';
import { roundTripAssistantTurn } from '../round-trip/resolve.ts';
import type { SourceAssistantTurnFor } from '../round-trip/source-assistant-turn.ts';
import type { RoundTripReader, RoundTripWriter } from '../round-trip/stream.ts';
import { createRoundTripStream } from '../round-trip/stream.ts';
import type { RoundTripTurnDigest } from '../round-trip/turn-digest.ts';
import type { SourceProtocolErrorWriter, TranslateContext, TranslateTrip } from '../types.ts';
import type { ProtocolFrame } from '@floway-dev/protocols/common';

type AssistantTurnKey = keyof AssistantTurnByProtocol;

/**
 * How one protocol carries a sidecar on its own assistant turns.
 *
 * These take the structure the source wrote, because that is what a sidecar is
 * computed over: the turn digest hashes it and the references are cut from it,
 * so none of this can work from an IR turn.
 */
export interface SourceRoundTrip<Name extends AssistantTurnKey> {
  readonly inspect: (turn: SourceAssistantTurnFor<Name>) => EncodedRoundTripSidecar<SourceAssistantTurnFor<Name>>[];
  readonly verify: (turn: SourceAssistantTurnFor<Name>, digest: RoundTripTurnDigest, version: number) => Promise<boolean>;
  readonly collectCandidates: (turn: SourceAssistantTurnFor<Name>) => ReplayContent[];
}

/** One protocol as the side a request comes from. */
export interface SourceProtocol<Name extends AssistantTurnKey, Payload, Event> {
  readonly name: Name;
  /** Reads the request into the turns it states, each turn's side already decided. */
  readonly read: (payload: Payload) => IRInputReading<SourceAssistantTurnFor<Name>>;
  readonly roundTrip: SourceRoundTrip<Name>;
  readonly writeError: SourceProtocolErrorWriter;
  /**
   * States the returned stream to this protocol's client.
   *
   * It is handed the reading's request, because what the client sees stated
   * back can depend on what it asked for, and the request is where that lives.
   */
  readonly writeStream: (
    reading: IRInputReading<SourceAssistantTurnFor<Name>>,
    records: AsyncIterable<IRRecord>,
    writer: RoundTripWriter<Name>,
  ) => AsyncIterable<ProtocolFrame<Event>>;
}

/** One protocol as the side a request goes to. */
export interface TargetProtocol<Name extends AssistantTurnKey, Payload, Event> {
  readonly name: Name;
  /**
   * Writes the input IR as this protocol's request.
   *
   * A resolved turn arrives as the structure this protocol states natively, so
   * whatever the writer needs to know about it — which calls it answers, say —
   * it reads from there rather than being told separately.
   */
  readonly write: (
    request: IRInputRequest,
    pieces: readonly (IRInputTurn | IRInputResolvedTurn<AssistantTurnFor<Name>>)[],
    ctx: TranslateContext,
  ) => Promise<Payload>;
  /**
   * Reads this protocol's upstream events into the output IR.
   *
   * It is handed the request the target was written from because reading a
   * stream may need a fact derived from it — which declared tools are freeform,
   * say — and that fact belongs to the request, not to the reader.
   */
  readonly readStream: (
    frames: AsyncIterable<ProtocolFrame<Event>>,
    reader: RoundTripReader<Name>,
    request: IRInputRequest,
  ) => AsyncIterable<IRRecord>;
}

/**
 * Composes one source protocol and one target protocol into a translation trip.
 *
 * This is the only place that names both sides. Everything it calls belongs to
 * one of them, so a route states a pair as two values.
 */
export const composeTranslation = <
  SrcName extends AssistantTurnKey, SrcPayload, SrcEvent,
  TgtName extends AssistantTurnKey, TgtPayload extends { model: string }, TgtEvent,
>(
  source: SourceProtocol<SrcName, SrcPayload, SrcEvent>,
  target: TargetProtocol<TgtName, TgtPayload, TgtEvent>,
): TranslateTrip<SrcPayload, SrcEvent, TgtPayload, TgtEvent> => async (payload, ctx) => {
  const reading = source.read(payload);
  return {
    target: await target.write(reading.request, await settleTurns(source, target, reading, ctx), ctx),
    errorBody: source.writeError,
    events: frames => {
      const stream = createRoundTripStream(source.name, target.name, ctx.sidecarCodec);
      return source.writeStream(reading, target.readStream(frames, stream.reader, reading.request), stream.writer);
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
const settleTurns = async <
  SrcName extends AssistantTurnKey, SrcPayload, SrcEvent,
  TgtName extends AssistantTurnKey, TgtPayload, TgtEvent,
>(
  source: SourceProtocol<SrcName, SrcPayload, SrcEvent>,
  target: TargetProtocol<TgtName, TgtPayload, TgtEvent>,
  reading: IRInputReading<SourceAssistantTurnFor<SrcName>>,
  ctx: TranslateContext,
): Promise<(IRInputTurn | IRInputResolvedTurn<AssistantTurnFor<TgtName>>)[]> =>
  await readTurns(reading, async (turn): Promise<
    { readonly resolved: AssistantTurnFor<TgtName> } | undefined
  > => {
    const roundTrip = await roundTripAssistantTurn(
      source.name, target.name, turn.assistantTurn, ctx.sidecarCodec,
      source.roundTrip.inspect, source.roundTrip.verify, source.roundTrip.collectCandidates,
    );
    if (roundTrip === undefined) return undefined;
    return { resolved: roundTrip.turn };
  });

/**
 * The request half of a composed trip, stated on its own.
 *
 * A pair's request translation is worth testing without the event side, and
 * this states exactly that step. It is the same code `composeTranslation` runs.
 */
export const buildTargetRequestFor = async <
  SrcName extends AssistantTurnKey, SrcPayload, SrcEvent,
  TgtName extends AssistantTurnKey, TgtPayload, TgtEvent,
>(
  source: SourceProtocol<SrcName, SrcPayload, SrcEvent>,
  target: TargetProtocol<TgtName, TgtPayload, TgtEvent>,
  payload: SrcPayload,
  ctx: TranslateContext,
  // Reading is stateful, so a caller that also inspects what it recorded passes
  // the same reading rather than opening a second one.
  reading: IRInputReading<SourceAssistantTurnFor<SrcName>> = source.read(payload),
): Promise<TgtPayload> =>
  await target.write(reading.request, await settleTurns(source, target, reading, ctx), ctx);

/**
 * The event half of a composed trip, stated on its own.
 *
 * It is the same code `composeTranslation` runs, including the reading that the
 * client-side writer may need.
 */
export const translateSourceEventsFor = <
  SrcName extends AssistantTurnKey, SrcPayload, SrcEvent,
  TgtName extends AssistantTurnKey, TgtPayload, TgtEvent,
>(
  source: SourceProtocol<SrcName, SrcPayload, SrcEvent>,
  target: TargetProtocol<TgtName, TgtPayload, TgtEvent>,
  payload: SrcPayload,
  ctx: TranslateContext,
  frames: AsyncIterable<ProtocolFrame<TgtEvent>>,
): AsyncIterable<ProtocolFrame<SrcEvent>> => {
  const reading = source.read(payload);
  const stream = createRoundTripStream(source.name, target.name, ctx.sidecarCodec);
  return source.writeStream(reading, target.readStream(frames, stream.reader, reading.request), stream.writer);
};
