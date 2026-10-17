import type { AssistantTurnByProtocol } from './assistant-turn.ts';
import type { RoundTripReplayCheck } from './replay-check.ts';
import type { TranslateSidecarCodec } from '../types.ts';
import type { ThinAssistantTurnFor, ThinReference } from './thin/assistant-turn.ts';

export type RoundTripProtocol = keyof AssistantTurnByProtocol;

export type RoundTripSidecar<Target extends RoundTripProtocol> = {
  source: RoundTripProtocol;
  target: Target;
  assistantTurn: ThinAssistantTurnFor<Target, ThinReference>;
  referencedContents?: Uint8Array[];
  replayCheck: RoundTripReplayCheck;
};

type RoundTripSidecarByTarget = { [Target in RoundTripProtocol]: RoundTripSidecar<Target> };
export type AnyRoundTripSidecar = RoundTripSidecarByTarget[RoundTripProtocol];

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

const isRoundTripProtocol = (value: unknown): value is RoundTripProtocol =>
  value === 'openaiChatCompletions' || value === 'openaiResponses' || value === 'anthropicMessages' || value === 'geminiGenerateContent';

const assertAssistantTurn = (target: RoundTripProtocol, value: unknown): void => {
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
  if (!isRoundTripProtocol(value.source)) throw new TypeError('Assistant-turn sidecar source is invalid');
  if (!isRoundTripProtocol(value.target)) throw new TypeError('Assistant-turn sidecar target is invalid');
  assertAssistantTurn(value.target, value.assistantTurn);
  if (value.referencedContents !== undefined
    && (!Array.isArray(value.referencedContents) || value.referencedContents.some(hash => !(hash instanceof Uint8Array)))) {
    throw new TypeError('Assistant-turn sidecar referenced contents are invalid');
  }
  if (!isRecord(value.replayCheck) || !Number.isInteger(value.replayCheck.version) || !(value.replayCheck.digest instanceof Uint8Array)) throw new TypeError('Assistant-turn sidecar replay check is invalid');
}

export const decodeRoundTripSidecar = async (codec: TranslateSidecarCodec, source: RoundTripProtocol, data: string): Promise<AnyRoundTripSidecar | undefined> => {
  const sidecar = await codec.decode(data);
  if (sidecar === undefined) return undefined;
  if (!isRecord(sidecar) || typeof sidecar.source !== 'string') throw new TypeError('Authenticated assistant-turn sidecar envelope is invalid');
  if (sidecar.source !== source) return undefined;
  assertRoundTripSidecar(sidecar);
  return sidecar;
};

export const hasRoundTripTarget = <Target extends RoundTripProtocol>(sidecar: AnyRoundTripSidecar, target: Target): sidecar is RoundTripSidecarByTarget[Target] => sidecar.target === target;
