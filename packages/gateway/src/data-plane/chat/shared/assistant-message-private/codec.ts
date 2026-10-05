import { encode, decode, Tag } from 'cbor-x';
import mapObject from 'map-obj';

import type { ApiKey } from '../../../../repo/types.ts';
import { decodeCanonicalBase64, decodeCanonicalBase64url, decodeForgivingBase64, isCanonicalBase64, encodeBase64, encodeBase64url } from '@floway-dev/protocols/common';
import type { OpenAIChatCompletionsPrivateCodec, OpenAIChatCompletionsAssistantMessagePrivate } from '@floway-dev/protocols/openai-chat-completions';

const SIGNATURE_LENGTH = 32;
const key = async (secret: string) => await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
const sign = async (data: Uint8Array, secret: string): Promise<Uint8Array> => new Uint8Array(await crypto.subtle.sign('HMAC', await key(secret), data as Uint8Array<ArrayBuffer>));
const verify = async (data: Uint8Array, signature: Uint8Array, secret: string): Promise<boolean> => await crypto.subtle.verify('HMAC', await key(secret), signature as Uint8Array<ArrayBuffer>, data as Uint8Array<ArrayBuffer>);

const serialize = (obj: unknown): Uint8Array => encode(mapObject(obj as Record<string, unknown>, (k, v) => {
  if (typeof v === 'string' && v.length >= 22) {
    const decodedBase64 = decodeCanonicalBase64(v);
    if (decodedBase64) return [k, new Tag(decodedBase64, 22), { shouldRecurse: false }];
    const decodedBase64url = decodeCanonicalBase64url(v);
    if (decodedBase64url) return [k, new Tag(decodedBase64url, 21), { shouldRecurse: false }];
  }
  return [k, v];
}, { deep: true }));
const deserialize = (buffer: Uint8Array): unknown => mapObject(decode(buffer), (k, v) => {
  if (v instanceof Tag && v.tag === 22) return [k, encodeBase64(v.value as Uint8Array)];
  if (v instanceof Tag && v.tag === 21) return [k, encodeBase64url(v.value as Uint8Array)];
  return [k, v];
}, { deep: true });

const encapsulate = async (sidecar: OpenAIChatCompletionsAssistantMessagePrivate, apiKey: Pick<ApiKey, 'serverSecret'>): Promise<string> => {
  const data = serialize(sidecar);
  const signature = await sign(data, apiKey.serverSecret);
  const combined = new Uint8Array(signature.length + data.length);
  combined.set(signature, 0);
  combined.set(data, signature.length);
  return encodeBase64(combined);
};

const unencapsulate = async (data: unknown, apiKey: Pick<ApiKey, 'serverSecret'>): Promise<OpenAIChatCompletionsAssistantMessagePrivate | undefined> => {
  if (typeof data !== 'string') return undefined;
  const buffer = decodeForgivingBase64(data);
  const signature = buffer.subarray(0, SIGNATURE_LENGTH);
  const payload = buffer.subarray(SIGNATURE_LENGTH);
  if (!await verify(payload, signature, apiKey.serverSecret)) return undefined;
  try {
    return deserialize(payload) as OpenAIChatCompletionsAssistantMessagePrivate;
  } catch {
    return undefined;
  }
};

export const createOpenAIChatCompletionsPrivateCodec = (apiKey: Pick<ApiKey, 'serverSecret'>): OpenAIChatCompletionsPrivateCodec => ({
  encapsulate: value => encapsulate(value, apiKey),
  unencapsulate: async data => typeof data === 'string' && isCanonicalBase64(data) ? await unencapsulate(data, apiKey) : undefined,
});
