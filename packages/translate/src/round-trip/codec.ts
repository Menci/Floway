import { decode as decodeCBOR, Encoder, Tag } from 'cbor-x';

import type { AssistantTurnByProtocol } from './assistant-turn.ts';
import type { RoundTripReplayCheck } from './replay-check.ts';
import type { ThinAssistantTurnFor, ThinReference } from './thin/assistant-turn.ts';
import { rawJSON } from '../shared/json/raw-json.ts';
import { decodeCanonicalBase64, decodeCanonicalBase64url, decodeForgivingBase64, encodeBase64, encodeBase64url } from '@floway-dev/protocols/common';

export type RoundTripProtocol = keyof AssistantTurnByProtocol;

export type RoundTripSidecar<Target extends RoundTripProtocol> = {
  source: RoundTripProtocol;
  target: Target;
  assistantTurn: ThinAssistantTurnFor<Target, ThinReference>;
  referencedContents?: Uint8Array[];
  replayCheck: RoundTripReplayCheck;
};

export type RoundTripSidecarByTarget = { [Target in RoundTripProtocol]: RoundTripSidecar<Target> };
export type RoundTripSidecarEnvelope = RoundTripSidecarByTarget[RoundTripProtocol];
export type RoundTripSidecarForTarget<Target extends RoundTripProtocol> = RoundTripSidecarByTarget[Target];
export type RoundTripSidecarPayload<Target extends RoundTripProtocol = RoundTripProtocol> = {
  target: Target;
  assistantTurn: ThinAssistantTurnFor<Target, ThinReference>;
  referencedContents?: Uint8Array[];
  replayCheck: RoundTripReplayCheck;
};

export interface AssistantTurnSidecarCodec {
  encode: <Target extends RoundTripProtocol>(source: RoundTripProtocol, sidecar: RoundTripSidecarPayload<Target>) => Promise<string>;
  decode: (source: RoundTripProtocol, data: string) => Promise<RoundTripSidecarEnvelope | undefined>;
}

const SIGNATURE_LENGTH = 32;
const RAW_JSON_TAG = 65_539;
const encoder = new Encoder({ useRecords: false, tagUint8Array: false });
const key = async (secret: string) => await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
const sign = async (data: Uint8Array, cryptoKey: CryptoKey): Promise<Uint8Array> => new Uint8Array(await crypto.subtle.sign('HMAC', cryptoKey, Uint8Array.from(data)));
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

export const encodeSidecarValue = (obj: unknown): Uint8Array => encoder.encode(mapSidecarValue(obj, value => {
  if (rawJSON.isRawJSON(value)) return new Tag(value.rawJSON, RAW_JSON_TAG);
  if (typeof value === 'string' && value.length >= 22) {
    const decodedBase64 = decodeCanonicalBase64(value);
    if (decodedBase64) return new Tag(decodedBase64, 22);
    const decodedBase64url = decodeCanonicalBase64url(value);
    if (decodedBase64url) return new Tag(decodedBase64url, 21);
  }
  return value;
}));
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

const encodeSidecar = async <Target extends RoundTripProtocol>(source: RoundTripProtocol, sidecar: RoundTripSidecarPayload<Target>, cryptoKey: CryptoKey): Promise<string> => {
  const data = encodeSidecarValue({ ...sidecar, source });
  const signature = await sign(data, cryptoKey);
  const combined = new Uint8Array(signature.length + data.length);
  combined.set(signature, 0);
  combined.set(data, signature.length);
  return encodeBase64(combined);
};

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
  if (value.referencedContents !== undefined
    && (!Array.isArray(value.referencedContents) || value.referencedContents.some(hash => !(hash instanceof Uint8Array)))) {
    throw new TypeError('Assistant-turn sidecar referenced contents are invalid');
  }
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
    encode: async (source, value) => await encodeSidecar(source, value, await cryptoKey),
    decode: async (source, data) => await decodeSidecar(source, data, await cryptoKey),
  };
};
