import type { IRInputResolvedTurn } from '../ir/input/segments.ts';
import type { IRInputLayout, IRInputSlot } from '../ir/input/layout.ts';
import type { IRInputRequest, IRInputTurn } from '../ir/input/types.ts';
import { irInputCustomToolNames } from '../ir/input/select-tools.ts';
import { readIRInput } from '../ir/input/read.ts';
import type { IRRecord } from '../ir/output/stream.ts';
import type { AssistantTurnByProtocol, AssistantTurnFor } from '../round-trip/assistant-turn.ts';
import type { SourceAssistantTurnFor } from '../round-trip/source-assistant-turn.ts';
import type { ReplayContent } from '../round-trip/reference/assistant-turn.ts';
import type { EncodedRoundTripSidecar, PendingCall } from '../round-trip/resolve.ts';
import { roundTripAssistantTurn, warnDroppedUnrecognizedAssistantReasoning } from '../round-trip/resolve.ts';
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
export interface SourceProtocol<Name extends AssistantTurnKey, Payload, Event, Extra = undefined> {
  readonly name: Name;
  /** Opens the request into the turns it states, each turn's side already decided. */
  readonly open: (payload: Payload) => IRInputLayout<SourceAssistantTurnFor<Name>, Extra>;
  readonly roundTrip: SourceRoundTrip<Name>;
  /**
   * Whether this turn carries reasoning that only a sidecar could restore.
   *
   * A turn whose sidecar is missing has lost it: the reader states no reasoning
   * item, because which alias a vendor used is not something a target can read.
   */
  readonly dropsReasoning: (turn: SourceAssistantTurnFor<Name>) => boolean;
  readonly writeError: SourceProtocolErrorWriter;
  /**
   * States the returned stream to this protocol's client.
   *
   * It is handed the same layout the request came from, because stating a
   * stream may need a fact the reading produced.
   */
  readonly writeStream: (
    layout: IRInputLayout<SourceAssistantTurnFor<Name>, Extra>,
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
   * Names the calls a restored turn leaves awaiting answers.
   *
   * The restored turn never passed through the source reader, so nothing
   * registered its calls; a later id-less result has to name them, and only
   * this protocol knows where it put them.
   */
  readonly pendingCallIds: (turn: AssistantTurnFor<Name>) => readonly PendingCall[];
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
    /**
     * The names the source declared as freeform.
     *
     * A target that cannot state a freeform declaration writes one as a plain
     * function, so reading its stream has to know which functions were really
     * freeform. That is a fact about the source request, handed across because
     * the reader is the one that sees the calls come back.
     */
    customToolNames: ReadonlySet<string>,
  ) => AsyncIterable<IRRecord>;
}

/**
 * Composes one source protocol and one target protocol into a translation trip.
 *
 * This is the only place that names both sides. Everything it calls belongs to
 * one of them, so a route states a pair as two values.
 */
export const composeTranslation = <
  SrcName extends AssistantTurnKey, SrcPayload, SrcEvent, SrcExtra,
  TgtName extends AssistantTurnKey, TgtPayload extends { model: string }, TgtEvent,
>(
  source: SourceProtocol<SrcName, SrcPayload, SrcEvent, SrcExtra>,
  target: TargetProtocol<TgtName, TgtPayload, TgtEvent>,
): TranslateTrip<SrcPayload, SrcEvent, TgtPayload, TgtEvent> => async (payload, ctx) => {
  const layout = source.open(payload);
  return {
    target: await target.write(layout.request, await settleTurns(source, target, layout, ctx), ctx),
    errorBody: source.writeError,
    events: frames => {
      const stream = createRoundTripStream(source.name, target.name, ctx.sidecarCodec);
      return source.writeStream(layout, target.readStream(frames, stream.reader, layout.request, irInputCustomToolNames(layout.request)), stream.writer);
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
  SrcName extends AssistantTurnKey, SrcPayload, SrcEvent, SrcExtra,
  TgtName extends AssistantTurnKey, TgtPayload, TgtEvent,
>(
  source: SourceProtocol<SrcName, SrcPayload, SrcEvent, SrcExtra>,
  target: TargetProtocol<TgtName, TgtPayload, TgtEvent>,
  layout: IRInputLayout<SourceAssistantTurnFor<SrcName>, SrcExtra>,
  ctx: TranslateContext,
): Promise<(IRInputTurn | IRInputResolvedTurn<AssistantTurnFor<TgtName>>)[]> =>
  await readIRInput(layout, async (slot): Promise<{ readonly resolved: AssistantTurnFor<TgtName> } | undefined> => {
    const roundTrip = await roundTripAssistantTurn(
      source.name, target.name, slot.assistantTurn, ctx.sidecarCodec,
      source.roundTrip.inspect, source.roundTrip.verify, source.roundTrip.collectCandidates,
      target.pendingCallIds,
    );
    if (roundTrip === undefined) {
      if (source.dropsReasoning(slot.assistantTurn)) {
        warnDroppedUnrecognizedAssistantReasoning(source.name, target.name);
      }
      return undefined;
    }
    layout.observePendingCalls?.(roundTrip.pendingCallIds(roundTrip.turn));
    return { resolved: roundTrip.turn };
  });

/**
 * The request half of a composed trip, stated on its own.
 *
 * A pair's request translation is worth testing without the event side, and
 * this states exactly that step. It is the same code `composeTranslation` runs.
 */
export const buildTargetRequestFor = async <
  SrcName extends AssistantTurnKey, SrcPayload, SrcEvent, SrcExtra,
  TgtName extends AssistantTurnKey, TgtPayload, TgtEvent,
>(
  source: SourceProtocol<SrcName, SrcPayload, SrcEvent, SrcExtra>,
  target: TargetProtocol<TgtName, TgtPayload, TgtEvent>,
  payload: SrcPayload,
  ctx: TranslateContext,
  // Reading a request is stateful, so a caller that also inspects what the
  // reading produced passes the same layout rather than opening a second time.
  layout: IRInputLayout<SourceAssistantTurnFor<SrcName>, SrcExtra> = source.open(payload),
): Promise<TgtPayload> =>
  await target.write(layout.request, await settleTurns(source, target, layout, ctx), ctx);

/**
 * The event half of a composed trip, stated on its own.
 *
 * It is the same code `composeTranslation` runs, including the reading that the
 * client-side writer may need.
 */
export const translateSourceEventsFor = <
  SrcName extends AssistantTurnKey, SrcPayload, SrcEvent, SrcExtra,
  TgtName extends AssistantTurnKey, TgtPayload, TgtEvent,
>(
  source: SourceProtocol<SrcName, SrcPayload, SrcEvent, SrcExtra>,
  target: TargetProtocol<TgtName, TgtPayload, TgtEvent>,
  payload: SrcPayload,
  ctx: TranslateContext,
  frames: AsyncIterable<ProtocolFrame<TgtEvent>>,
): AsyncIterable<ProtocolFrame<SrcEvent>> => {
  const layout = source.open(payload);
  const stream = createRoundTripStream(source.name, target.name, ctx.sidecarCodec);
  return source.writeStream(layout, target.readStream(frames, stream.reader, layout.request, irInputCustomToolNames(layout.request)), stream.writer);
};
