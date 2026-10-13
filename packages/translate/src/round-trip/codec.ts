import { decode as decodeCBOR, Tag } from 'cbor-x';

import type { AssistantTurnByProtocol, AssistantTurnFor } from './assistant-turn.ts';
import type { RoundTripReplayCheck } from './replay-check.ts';
import { rawJSON } from '../shared/json/raw-json.ts';
import { decodeForgivingBase64, encodeBase64, encodeBase64url } from '@floway-dev/protocols/common';

export type RoundTripProtocol = keyof AssistantTurnByProtocol;

export type RoundTripSidecar<Target extends RoundTripProtocol> = {
  source: RoundTripProtocol;
  target: Target;
  assistantTurn: AssistantTurnFor<Target>;
  replayCheck: RoundTripReplayCheck;
};

export type RoundTripSidecarByTarget = { [Target in RoundTripProtocol]: RoundTripSidecar<Target> };
export type RoundTripSidecarEnvelope = RoundTripSidecarByTarget[RoundTripProtocol];
export type RoundTripSidecarForTarget<Target extends RoundTripProtocol> = RoundTripSidecarByTarget[Target];

export interface AssistantTurnSidecarCodec {
  decode: (source: RoundTripProtocol, data: string) => Promise<RoundTripSidecarEnvelope | undefined>;
}

const SIGNATURE_LENGTH = 32;
const RAW_JSON_TAG = 65_539;
const key = async (secret: string) => await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);

const verify = async (data: Uint8Array, signature: Uint8Array, cryptoKey: CryptoKey): Promise<boolean> => await crypto.subtle.verify('HMAC', cryptoKey, Uint8Array.from(signature), Uint8Array.from(data));

const mapSidecarValue = (value: unknown, transform: (value: unknown) => unknown): unknown => {
  const mapped = transform(value);
  if (mapped instanceof Tag || mapped instanceof Uint8Array || rawJSON.isRawJSON(mapped)) return mapped;
  if (Array.isArray(mapped)) return mapped.map(child => mapSidecarValue(child, transform));
  if (typeof mapped === 'object' && mapped !== null) {
    return Object.fromEntries(Object.entries(mapped).map(([key, child]) => [key, mapSidecarValue(child, transform)]));
  }
  return mapped;
};

const deserialize = (buffer: Uint8Array): unknown => mapSidecarValue(decodeCBOR(buffer), value => {
  if (value instanceof Tag && value.tag === RAW_JSON_TAG) {
    if (typeof value.value !== 'string') throw new TypeError('Raw JSON sidecar tag requires a string');
    return rawJSON.rawJSON(value.value);
  }
  if (value instanceof Tag && value.tag === 22) {
    if (!(value.value instanceof Uint8Array)) throw new TypeError('Base64 sidecar tag requires bytes');
    return encodeBase64(value.value);
  }
  if (value instanceof Tag && value.tag === 21) {
    if (!(value.value instanceof Uint8Array)) throw new TypeError('Base64URL sidecar tag requires bytes');
    return encodeBase64url(value.value);
  }
  return value;
});

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

function assertSidecarEnvelope(value: Record<string, unknown>): asserts value is RoundTripSidecarEnvelope {
  if (!isRoundTripProtocol(value.source)) throw new TypeError('Assistant-turn sidecar source is invalid');
  if (!isRoundTripProtocol(value.target)) throw new TypeError('Assistant-turn sidecar target is invalid');
  assertAssistantTurn(value.target, value.assistantTurn);
  if (!isRecord(value.replayCheck) || !Number.isInteger(value.replayCheck.version) || !(value.replayCheck.digest instanceof Uint8Array)) throw new TypeError('Assistant-turn sidecar replay check is invalid');
}

const decodeSidecar = async (source: RoundTripProtocol, data: string, cryptoKey: CryptoKey): Promise<RoundTripSidecarEnvelope | undefined> => {
  let buffer: Uint8Array;
  try {
    buffer = decodeForgivingBase64(data);
  } catch {
    return undefined;
  }
  const signature = buffer.subarray(0, SIGNATURE_LENGTH);
  const payload = buffer.subarray(SIGNATURE_LENGTH);
  if (!await verify(payload, signature, cryptoKey)) return undefined;
  const sidecar = deserialize(payload);
  if (!isRecord(sidecar) || typeof sidecar.source !== 'string') throw new TypeError('Authenticated assistant-turn sidecar envelope is invalid');
  if (sidecar.source !== source) return undefined;
  assertSidecarEnvelope(sidecar);
  return sidecar;
};

export const hasRoundTripTarget = <Target extends RoundTripProtocol>(sidecar: RoundTripSidecarEnvelope, target: Target): sidecar is RoundTripSidecarForTarget<Target> => sidecar.target === target;

export const createAssistantTurnSidecarCodec = (serverSecret: string): AssistantTurnSidecarCodec => {
  const cryptoKey = key(serverSecret);
  return {
    decode: async (source, data) => await decodeSidecar(source, data, await cryptoKey),
  };
};
