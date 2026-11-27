import type { SidecarCodec } from './codec.ts';
import type { AssistantTurnProtocol } from './input-assistant-turn.ts';
import type { ReferenceableInputAssistantTurnFor } from './reference/assistant-turn-types.ts';
import { tagContentReferences, untagContentReferences } from './reference/content-reference-tag.ts';
import type { ContentReference } from './reference/types.ts';
import type { RoundTripTurnDigest } from './turn-digest.ts';

export const ROUND_TRIP_SIDECAR_VERSION = 3;
const SUPPORTED_SIDECAR_VERSIONS = [1, 2, ROUND_TRIP_SIDECAR_VERSION] as const;
export type RoundTripSidecarVersion = (typeof SUPPORTED_SIDECAR_VERSIONS)[number];

export const isSupportedSidecarVersion = (value: unknown): value is RoundTripSidecarVersion =>
  SUPPORTED_SIDECAR_VERSIONS.some(supported => supported === value);

// One wire version covers every translation subsystem. Each subsystem derives
// its format rules from this `v` (`v >= 2` selects the v2 Chat Completions
// turn-digest material and `v >= 3` orders Responses `function_call` and
// `custom_tool_call` together, while retaining older verification) without
// per-subsystem version members, so advancing any subsystem advances this
// single `v`.
export type RoundTripSidecar<Target extends AssistantTurnProtocol> = {
  v: RoundTripSidecarVersion;
  source: AssistantTurnProtocol;
  target: Target;
  targetTurn: ReferenceableInputAssistantTurnFor<Target, ContentReference>;
  referencedContentHashes?: Uint8Array[];
  sourceTurnDigest: RoundTripTurnDigest;
};

type RoundTripSidecarByTarget = { [Target in AssistantTurnProtocol]: RoundTripSidecar<Target> };
export type AnyRoundTripSidecar = RoundTripSidecarByTarget[AssistantTurnProtocol];

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

const isAssistantTurnProtocol = (value: unknown): value is AssistantTurnProtocol =>
  value === 'openaiChatCompletions' || value === 'openaiResponses' || value === 'anthropicMessages' || value === 'geminiGenerateContent';

const assertTargetTurnContainer = (target: AssistantTurnProtocol, value: unknown): void => {
  if (target === 'openaiChatCompletions') {
    if (!isRecord(value) || value.role !== 'assistant') throw new TypeError('Chat Completions assistant turn is invalid');
    return;
  }
  if (target === 'anthropicMessages') {
    if (!isRecord(value) || value.role !== 'assistant' || !Array.isArray(value.content)) throw new TypeError('Messages assistant turn is invalid');
    return;
  }
  if (!Array.isArray(value)) throw new TypeError(`${target} assistant turn is invalid`);
};

function assertRoundTripEnvelope(value: Record<string, unknown>): asserts value is AnyRoundTripSidecar {
  if (!isSupportedSidecarVersion(value.v)) throw new TypeError('Assistant-turn sidecar version is unsupported');
  if (!isAssistantTurnProtocol(value.source)) throw new TypeError('Assistant-turn sidecar source is invalid');
  if (!isAssistantTurnProtocol(value.target)) throw new TypeError('Assistant-turn sidecar target is invalid');
  assertTargetTurnContainer(value.target, value.targetTurn);
  if (value.referencedContentHashes !== undefined
    && (!Array.isArray(value.referencedContentHashes) || value.referencedContentHashes.some(hash => !(hash instanceof Uint8Array)))) {
    throw new TypeError('Assistant-turn sidecar referenced contents are invalid');
  }
  if (!(value.sourceTurnDigest instanceof Uint8Array)) throw new TypeError('Assistant-turn sidecar turn digest is invalid');
}

export const decodeRoundTripSidecar = async (codec: SidecarCodec, source: AssistantTurnProtocol, data: string): Promise<AnyRoundTripSidecar | undefined> => {
  const sidecar = untagContentReferences(await codec.decode(data));
  if (sidecar === undefined) return undefined;
  if (!isRecord(sidecar) || typeof sidecar.source !== 'string') throw new TypeError('Authenticated assistant-turn sidecar envelope is invalid');
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

export const hasRoundTripTarget = <Target extends AssistantTurnProtocol>(sidecar: AnyRoundTripSidecar, target: Target): sidecar is RoundTripSidecarByTarget[Target] => sidecar.target === target;
