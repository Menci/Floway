import type { SidecarCodec } from './codec.ts';
import type { AssistantTurnProtocol } from './input-assistant-turn.ts';
import type { ReferenceableInputAssistantTurnFor } from './reference/assistant-turn-types.ts';
import { tagContentReferences, untagContentReferences } from './reference/content-reference-tag.ts';
import type { ContentReference } from './reference/types.ts';
import type { RoundTripTurnDigest } from './turn-digest.ts';
import { isJSONRecord } from '../shared/json/object.ts';

const ROUND_TRIP_SIDECAR_VERSION = 1;

// One wire version covers every translation subsystem. A field whose format can
// change derives its own format version from this `v` (currently `v: 1` selects
// the v1 turn-digest material) instead of carrying a second version member, so
// advancing any subsystem advances this single `v`.
export type RoundTripSidecar<Target extends AssistantTurnProtocol> = {
  v: 1;
  source: AssistantTurnProtocol;
  target: Target;
  targetTurn: ReferenceableInputAssistantTurnFor<Target, ContentReference>;
  referencedContentHashes?: Uint8Array[];
  sourceTurnDigest: RoundTripTurnDigest;
};

type RoundTripSidecarByTarget = { [Target in AssistantTurnProtocol]: RoundTripSidecar<Target> };
export type AnyRoundTripSidecar = RoundTripSidecarByTarget[AssistantTurnProtocol];

const isAssistantTurnProtocol = (value: unknown): value is AssistantTurnProtocol =>
  value === 'openaiChatCompletions' || value === 'openaiResponses' || value === 'anthropicMessages' || value === 'geminiGenerateContent';

const assertTargetTurnContainer = (target: AssistantTurnProtocol, value: unknown): void => {
  if (target === 'openaiChatCompletions') {
    if (!isJSONRecord(value) || value.role !== 'assistant') throw new TypeError('Chat Completions assistant turn is invalid');
    return;
  }
  if (target === 'anthropicMessages') {
    if (!isJSONRecord(value) || value.role !== 'assistant' || !Array.isArray(value.content)) throw new TypeError('Messages assistant turn is invalid');
    return;
  }
  if (!Array.isArray(value)) throw new TypeError(`${target} assistant turn is invalid`);
};

function assertRoundTripEnvelope(value: Record<string, unknown>): asserts value is AnyRoundTripSidecar {
  if (value.v !== ROUND_TRIP_SIDECAR_VERSION) throw new TypeError('Assistant-turn sidecar version is unsupported');
  if (!isAssistantTurnProtocol(value.source)) throw new TypeError('Assistant-turn sidecar source is invalid');
  if (!isAssistantTurnProtocol(value.target)) throw new TypeError('Assistant-turn sidecar target is invalid');
  assertTargetTurnContainer(value.target, value.targetTurn);
  if (value.referencedContentHashes !== undefined
    && (!Array.isArray(value.referencedContentHashes) || value.referencedContentHashes.some(hash => !(hash instanceof Uint8Array)))) {
    throw new TypeError('Assistant-turn sidecar referenced contents are invalid');
  }
  if (!(value.sourceTurnDigest instanceof Uint8Array)) throw new TypeError('Assistant-turn sidecar turn digest is invalid');
}

/**
 * Reads the sidecar a carrier holds, when it belongs to the source asking.
 *
 * An envelope naming another source is not this trip's business: it is dropped
 * before its format is checked, because what it states about a different
 * protocol's turn says nothing about this one. What is checked is the envelope
 * a trip would actually use.
 */
export const decodeRoundTripSidecar = async <Source extends AssistantTurnProtocol>(
  codec: SidecarCodec,
  source: Source,
  data: string,
): Promise<AnyRoundTripSidecar | undefined> => {
  const sidecar = untagContentReferences(await codec.decode(data));
  if (sidecar === undefined) return undefined;
  if (!isJSONRecord(sidecar) || typeof sidecar.source !== 'string') throw new TypeError('Authenticated assistant-turn sidecar envelope is invalid');
  if (sidecar.source !== source) return undefined;
  assertRoundTripEnvelope(sidecar);
  return sidecar;
};

export const encodeRoundTripSidecar = async <Target extends AssistantTurnProtocol>(
  codec: SidecarCodec,
  sidecar: RoundTripSidecar<Target>,
): Promise<string> => await codec.encode(encodedRoundTripSidecar(sidecar));

const encodedRoundTripSidecar = <Target extends AssistantTurnProtocol>(sidecar: RoundTripSidecar<Target>): NonNullable<unknown> => {
  const encoded = tagContentReferences(sidecar);
  if (typeof encoded !== 'object' || encoded === null) throw new TypeError('Round-trip sidecar must encode to an object');
  return encoded;
};

// An absent envelope is not this target's: a caller that found no sidecar in a
// turn asks the same question as one whose sidecar names another target.
export const hasRoundTripTarget = <Target extends AssistantTurnProtocol>(sidecar: AnyRoundTripSidecar | undefined, target: Target): sidecar is RoundTripSidecarByTarget[Target] => sidecar?.target === target;
