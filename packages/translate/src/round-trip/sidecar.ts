import type { AssistantTurnByProtocol } from './assistant-turn.ts';
import type { RoundTripTurnDigest } from './turn-digest.ts';
import type { SidecarCodec } from '../types.ts';
import type { ReferenceableAssistantTurnFor, ContentReference } from './reference/assistant-turn.ts';
import { encodeSidecarTaggedValues, restoreSidecarTaggedValues } from './reference/tagged-value.ts';

export type RoundTripProtocol = keyof AssistantTurnByProtocol;

const ROUND_TRIP_SIDECAR_VERSION = 1;

// One wire version covers every translation subsystem. A field whose format can
// change derives its own format version from this `v` (currently `v: 1` selects
// the v1 turn-digest material) instead of carrying a second version member, so
// advancing any subsystem advances this single `v`.
export type RoundTripSidecar<Target extends RoundTripProtocol> = {
  v: 1;
  source: RoundTripProtocol;
  target: Target;
  targetTurn: ReferenceableAssistantTurnFor<Target, ContentReference>;
  referencedContentHashes?: Uint8Array[];
  sourceTurnDigest: RoundTripTurnDigest;
};

type RoundTripSidecarByTarget = { [Target in RoundTripProtocol]: RoundTripSidecar<Target> };
export type AnyRoundTripSidecar = RoundTripSidecarByTarget[RoundTripProtocol];

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

const isRoundTripProtocol = (value: unknown): value is RoundTripProtocol =>
  value === 'openaiChatCompletions' || value === 'openaiResponses' || value === 'anthropicMessages' || value === 'geminiGenerateContent';

const assertTargetTurn = (target: RoundTripProtocol, value: unknown): void => {
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

function assertRoundTripSidecar(value: Record<string, unknown>): asserts value is AnyRoundTripSidecar {
  if (value.v !== ROUND_TRIP_SIDECAR_VERSION) throw new TypeError('Assistant-turn sidecar version is unsupported');
  if (!isRoundTripProtocol(value.source)) throw new TypeError('Assistant-turn sidecar source is invalid');
  if (!isRoundTripProtocol(value.target)) throw new TypeError('Assistant-turn sidecar target is invalid');
  assertTargetTurn(value.target, value.targetTurn);
  if (value.referencedContentHashes !== undefined
    && (!Array.isArray(value.referencedContentHashes) || value.referencedContentHashes.some(hash => !(hash instanceof Uint8Array)))) {
    throw new TypeError('Assistant-turn sidecar referenced contents are invalid');
  }
  if (!(value.sourceTurnDigest instanceof Uint8Array)) throw new TypeError('Assistant-turn sidecar turn digest is invalid');
}

export const decodeRoundTripSidecar = async (codec: SidecarCodec, source: RoundTripProtocol, data: string): Promise<AnyRoundTripSidecar | undefined> => {
  const sidecar = restoreSidecarTaggedValues(await codec.decode(data));
  if (sidecar === undefined) return undefined;
  if (!isRecord(sidecar) || typeof sidecar.source !== 'string') throw new TypeError('Authenticated assistant-turn sidecar envelope is invalid');
  if (sidecar.source !== source) return undefined;
  assertRoundTripSidecar(sidecar);
  return sidecar;
};

export const encodeRoundTripSidecar = async <Target extends RoundTripProtocol>(
  codec: SidecarCodec,
  sidecar: RoundTripSidecar<Target>,
): Promise<string> => await codec.encode(encodedRoundTripSidecar(sidecar));

const encodedRoundTripSidecar = <Target extends RoundTripProtocol>(sidecar: RoundTripSidecar<Target>): NonNullable<unknown> => {
  const encoded = encodeSidecarTaggedValues(sidecar);
  if (typeof encoded !== 'object' || encoded === null) throw new TypeError('Round-trip sidecar must encode to an object');
  return encoded;
};

export const hasRoundTripTarget = <Target extends RoundTripProtocol>(sidecar: AnyRoundTripSidecar, target: Target): sidecar is RoundTripSidecarByTarget[Target] => sidecar.target === target;
