import type { IRInputResolvedTurn } from '../ir/input/segments.ts';
import type { IRInputSource } from '../ir/input/source.ts';
import { readIRInput } from '../ir/input/source.ts';
import type { IRInputRequest, IRInputTurn } from '../ir/input/types.ts';
import type { IRRecord } from '../ir/output/stream.ts';
import type { AssistantTurnByProtocol, AssistantTurnFor } from '../round-trip/assistant-turn.ts';
import type { ReplayContent } from '../round-trip/reference/assistant-turn.ts';
import type { EncodedRoundTripSidecar } from '../round-trip/resolve.ts';
import { roundTripAssistantTurn, warnDroppedUnrecognizedAssistantReasoning } from '../round-trip/resolve.ts';
import type { RoundTripReader, RoundTripWriter } from '../round-trip/stream.ts';
import { createRoundTripStream } from '../round-trip/stream.ts';
import type { RoundTripTurnDigest } from '../round-trip/turn-digest.ts';
import type { SourceProtocolErrorWriter, TranslateContext, TranslateTrip } from '../types.ts';
import type { ProtocolFrame } from '@floway-dev/protocols/common';

type AssistantTurnKey = keyof AssistantTurnByProtocol;

/**
 * A call a native assistant turn states, in terms every protocol shares.
 *
 * A source reader that correlates a result against the calls it has seen needs
 * to know which of them already have answers. Only the target knows what its
 * own native turn looks like, so it states them here instead of letting the
 * reader parse another protocol's structure.
 */
export interface ResolvedCall {
  readonly callId: string;
  readonly name: string;
}

/**
 * One protocol read as the side a request comes from, for one request.
 *
 * `assistantTurn` is what a source states about its own conversation: the
 * assistant part of a turn, or nothing when the turn is not the model's. The
 * sidecar functions beside it all take that assistant part, which is the unit a
 * native turn round-trips as.
 *
 * `output` is bound to this reading because stating the output IR may need
 * something reading the request produced — a namespace map, a stream
 * preference — and both halves therefore belong to the same request.
 */
export interface SourceReading<Name extends AssistantTurnKey, Turn, AssistantTurn, Event, Extra = unknown> {
  readonly request: IRInputRequest;
  readonly input: IRInputSource<Turn>;
  // Values this protocol derives while reading its request and needs again to
  // state the returned stream — a namespace map, say. Their shape is the
  // protocol's own, so nothing outside its source reads them.
  readonly extra?: Extra;
  readonly assistantTurn: (turn: Turn) => AssistantTurn | undefined;
  /** Whether this turn carries reasoning only a sidecar could restore. */
  readonly dropsReasoning: (turn: Turn) => boolean;
  readonly roundTrip: {
    readonly inspect: (turn: AssistantTurn) => EncodedRoundTripSidecar<AssistantTurn>[];
    readonly verify: (turn: AssistantTurn, digest: RoundTripTurnDigest, version: number) => Promise<boolean>;
    readonly collectCandidates: (turn: AssistantTurn) => ReplayContent[];
  };
  // The request is handed in because stating the output IR may need a fact
  // derived from it, such as which declared tools are freeform.
  readonly output: (records: AsyncIterable<IRRecord>, writer: RoundTripWriter<Name>, request: IRInputRequest) => AsyncIterable<ProtocolFrame<Event>>;
}

/** One protocol as the side a request comes from. */
export interface SourceProtocol<Name extends AssistantTurnKey, Payload, Turn, AssistantTurn, Event, Extra = unknown> {
  readonly name: Name;
  // The context carries the model the caller resolved; a protocol that states
  // it in its request reads it from there rather than from the payload.
  readonly read: (payload: Payload) => SourceReading<Name, Turn, AssistantTurn, Event, Extra>;
  readonly writeError: SourceProtocolErrorWriter;
}

/** One protocol as the side a request goes to. */
export interface TargetProtocol<Name extends AssistantTurnKey, Payload, Event> {
  readonly name: Name;
  /** Which calls a native turn in this protocol states, so a reader can correlate. */
  readonly resolvedCalls: (turn: AssistantTurnFor<Name>) => readonly ResolvedCall[];
  readonly write: (
    request: IRInputRequest,
    pieces: readonly (IRInputTurn | IRInputResolvedTurn<AssistantTurnFor<Name>>)[],
    ctx: TranslateContext,
  ) => Promise<Payload>;
  readonly readStream: (frames: AsyncIterable<ProtocolFrame<Event>>, reader: RoundTripReader<Name>, request: IRInputRequest) => AsyncIterable<IRRecord>;
}

/**
 * Composes one source protocol and one target protocol into a translation trip.
 *
 * This is the only place that names both sides. Everything it calls belongs to
 * one of them, so a route states a pair as two values — the n² paths cost one
 * line each rather than a directory apiece.
 */
export const composeTranslation = <
  SrcName extends AssistantTurnKey, SrcPayload, SrcTurn, SrcAssistantTurn, SrcEvent,
  TgtName extends AssistantTurnKey, TgtPayload extends { model: string }, TgtEvent,
>(
  source: SourceProtocol<SrcName, SrcPayload, SrcTurn, SrcAssistantTurn, SrcEvent>,
  target: TargetProtocol<TgtName, TgtPayload, TgtEvent>,
): TranslateTrip<SrcPayload, SrcEvent, TgtPayload, TgtEvent> => async (payload, ctx) => {
  const reading = source.read(payload);
  const pieces = await readIRInput(reading.input, async turn => {
    const assistantTurn = reading.assistantTurn(turn);
    if (assistantTurn === undefined) return undefined;
    const roundTrip = await roundTripAssistantTurn(
      source.name, target.name, assistantTurn, ctx.sidecarCodec,
      reading.roundTrip.inspect, reading.roundTrip.verify, reading.roundTrip.collectCandidates,
    );
    if (roundTrip !== undefined) return { resolved: roundTrip.turn, calls: target.resolvedCalls(roundTrip.turn) };
    if (reading.dropsReasoning(turn)) warnDroppedUnrecognizedAssistantReasoning(source.name, target.name);
    return undefined;
  });

  return {
    target: await target.write(reading.request, pieces, ctx),
    errorBody: source.writeError,
    events: frames => {
      const stream = createRoundTripStream(source.name, target.name, ctx.sidecarCodec);
      const request = reading.request;
      return reading.output(target.readStream(frames, stream.reader, request), stream.writer, request);
    },
  };
};

/**
 * The request half of a composed trip, stated on its own.
 *
 * A pair's request translation is worth testing without the event side, and
 * this states exactly that step: read the source, settle each turn, write the
 * target. It is the same code `composeTranslation` runs.
 */
export const buildTargetRequestFor = async <
  SrcName extends AssistantTurnKey, SrcPayload, SrcTurn, SrcAssistantTurn, SrcEvent, Extra,
  TgtName extends AssistantTurnKey, TgtPayload, TgtEvent,
>(
  source: SourceProtocol<SrcName, SrcPayload, SrcTurn, SrcAssistantTurn, SrcEvent, Extra>,
  target: TargetProtocol<TgtName, TgtPayload, TgtEvent>,
  payload: SrcPayload,
  ctx: TranslateContext,
  // Reusing a reading is how a caller observes what reading produced (a
  // namespace map, say) beside the request built from it.
  reuse?: SourceReading<SrcName, SrcTurn, SrcAssistantTurn, SrcEvent, Extra>,
): Promise<TgtPayload> => {
  const reading = reuse ?? source.read(payload);
  const pieces = await readIRInput(reading.input, async turn => {
    const assistantTurn = reading.assistantTurn(turn);
    if (assistantTurn === undefined) return undefined;
    const roundTrip = await roundTripAssistantTurn(
      source.name, target.name, assistantTurn, ctx.sidecarCodec,
      reading.roundTrip.inspect, reading.roundTrip.verify, reading.roundTrip.collectCandidates,
    );
    if (roundTrip !== undefined) return { resolved: roundTrip.turn, calls: target.resolvedCalls(roundTrip.turn) };
    if (reading.dropsReasoning(turn)) warnDroppedUnrecognizedAssistantReasoning(source.name, target.name);
    return undefined;
  });
  return await target.write(reading.request, pieces, ctx);
};

/**
 * The event half of a composed trip, stated on its own.
 *
 * A pair's stream translation is worth testing without the request side, and
 * this states exactly that step: read the target's upstream events into the
 * output IR, then state them to the source's client. It is the same code
 * `composeTranslation` runs.
 */
export const translateSourceEventsFor = <
  SrcName extends AssistantTurnKey, SrcPayload, SrcTurn, SrcAssistantTurn, SrcEvent,
  TgtName extends AssistantTurnKey, TgtPayload, TgtEvent,
>(
  source: SourceProtocol<SrcName, SrcPayload, SrcTurn, SrcAssistantTurn, SrcEvent>,
  target: TargetProtocol<TgtName, TgtPayload, TgtEvent>,
  payload: SrcPayload,
  ctx: TranslateContext,
  frames: AsyncIterable<ProtocolFrame<TgtEvent>>,
): AsyncIterable<ProtocolFrame<SrcEvent>> => {
  const reading = source.read(payload);
  const stream = createRoundTripStream(source.name, target.name, ctx.sidecarCodec);
  return reading.output(target.readStream(frames, stream.reader, reading.request), stream.writer, reading.request);
};
