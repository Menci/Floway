import { encode as encodeCBOR, Tag } from 'cbor-x';

import { createAssistantTurnSidecarCodec, type RoundTripProtocol, type RoundTripSidecar } from '../../src/round-trip/codec.ts';
import { rawJSON } from '../../src/shared/json/raw-json.ts';
import { decodeCanonicalBase64, decodeCanonicalBase64url, encodeBase64 } from '@floway-dev/protocols/common';

export type RoundTripSidecarPayload<Target extends RoundTripProtocol = RoundTripProtocol> = Omit<RoundTripSidecar<Target>, 'source'>;

const RAW_JSON_TAG = 65_539;

const key = async (secret: string) => await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);

const sign = async (data: Uint8Array, cryptoKey: CryptoKey): Promise<Uint8Array> => new Uint8Array(await crypto.subtle.sign('HMAC', cryptoKey, Uint8Array.from(data)));

const mapSidecarValue = (value: unknown, transform: (value: unknown) => unknown): unknown => {
  const mapped = transform(value);
  if (mapped instanceof Tag || mapped instanceof Uint8Array || rawJSON.isRawJSON(mapped)) return mapped;
  if (Array.isArray(mapped)) return mapped.map(child => mapSidecarValue(child, transform));
  if (typeof mapped === 'object' && mapped !== null) {
    return Object.fromEntries(Object.entries(mapped).map(([key, child]) => [key, mapSidecarValue(child, transform)]));
  }
  return mapped;
};

const serialize = (obj: unknown): Uint8Array => encodeCBOR(mapSidecarValue(obj, value => {
  if (rawJSON.isRawJSON(value)) return new Tag(value.rawJSON, RAW_JSON_TAG);
  if (typeof value === 'string' && value.length >= 22) {
    const decodedBase64 = decodeCanonicalBase64(value);
    if (decodedBase64) return new Tag(decodedBase64, 22);
    const decodedBase64url = decodeCanonicalBase64url(value);
    if (decodedBase64url) return new Tag(decodedBase64url, 21);
  }
  return value;
}));

const encodeSidecar = async <Target extends RoundTripProtocol>(source: RoundTripProtocol, sidecar: RoundTripSidecarPayload<Target>, cryptoKey: CryptoKey): Promise<string> => {
  const data = serialize({ ...sidecar, source });
  const signature = await sign(data, cryptoKey);
  const combined = new Uint8Array(signature.length + data.length);
  combined.set(signature, 0);
  combined.set(data, signature.length);
  return encodeBase64(combined);
};

export const createTestSidecarCodec = (serverSecret = 'test-server-secret') => {
  const cryptoKey = key(serverSecret);
  return {
    ...createAssistantTurnSidecarCodec(serverSecret),
    encode: async <Target extends RoundTripProtocol>(source: RoundTripProtocol, sidecar: RoundTripSidecarPayload<Target>) => await encodeSidecar(source, sidecar, await cryptoKey),
  };
};
