import type { AffinityEnvelope, AffinityOrigin, AffinityTarget, DecodedAffinityBlob } from './types.ts';
import type { AliasRules } from '@floway-dev/protocols/common';

const IV_BYTES = 12;
const LENGTH_BYTES = 2;
const MAX_ENCRYPTED_BYTES = 0xffff;
const textEncoder = new TextEncoder();
const fatalTextDecoder = new TextDecoder('utf-8', { fatal: true });

const bytesToBase64 = (bytes: Uint8Array): string => {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
};

const base64ToBytes = (value: string): Uint8Array => {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
};

const bytesToBase64url = (bytes: Uint8Array): string =>
  bytesToBase64(bytes).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');

const base64urlToBytes = (value: string): Uint8Array => {
  const standard = value.replaceAll('-', '+').replaceAll('_', '/');
  const padding = (4 - standard.length % 4) % 4;
  return base64ToBytes(`${standard}${'='.repeat(padding)}`);
};

const decodeCanonicalBase64 = (value: string): Uint8Array | null => {
  try {
    const bytes = base64ToBytes(value);
    return bytesToBase64(bytes) === value ? bytes : null;
  } catch {
    return null;
  }
};

const decodeCanonicalBase64url = (value: string): Uint8Array | null => {
  try {
    const bytes = base64urlToBytes(value);
    return bytesToBase64url(bytes) === value ? bytes : null;
  } catch {
    return null;
  }
};

const decodeOriginal = (value: string): { bytes: Uint8Array; origin: AffinityOrigin } => {
  if (value.length > 0) {
    const base64 = decodeCanonicalBase64(value);
    if (base64 !== null) return { bytes: base64, origin: 'base64' };
    const base64url = decodeCanonicalBase64url(value);
    if (base64url !== null) return { bytes: base64url, origin: 'base64url' };
  }
  return { bytes: textEncoder.encode(value), origin: 'raw' };
};

const encodeOriginal = (bytes: Uint8Array, origin: AffinityOrigin): string => {
  switch (origin) {
  case 'base64': return bytesToBase64(bytes);
  case 'base64url': return bytesToBase64url(bytes);
  case 'raw': return fatalTextDecoder.decode(bytes);
  }
};

const parseServerSecretBytes = (secret: string): Uint8Array => {
  if (!/^[0-9a-f]{64}$/.test(secret)) throw new TypeError('Server secret must be 64 lowercase hexadecimal characters');
  const bytes = new Uint8Array(32);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(secret.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const parseEnvelope = (value: unknown): AffinityEnvelope | null => {
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.affinity)) return null;
  const origin = value.origin;
  if (origin !== undefined && origin !== 'raw' && origin !== 'base64' && origin !== 'base64url') return null;

  const affinity = value.affinity;
  if (
    (affinity.mode !== 'prefer' && affinity.mode !== 'force')
    || typeof affinity.upstreamId !== 'string'
    || typeof affinity.modelId !== 'string'
    || typeof affinity.rulesPresent !== 'boolean'
    || (affinity.upstreamItemId !== undefined && typeof affinity.upstreamItemId !== 'string')
    || (affinity.syntheticItem !== undefined && affinity.syntheticItem !== true)
    || (affinity.geminiPartFromEnd !== undefined && (typeof affinity.geminiPartFromEnd !== 'number' || !Number.isInteger(affinity.geminiPartFromEnd) || affinity.geminiPartFromEnd <= 0))
    || (affinity.rulesPresent && !isRecord(affinity.rules))
    || (!affinity.rulesPresent && affinity.rules !== undefined)
  ) return null;

  const parsedAffinity: AffinityTarget = {
    mode: affinity.mode,
    upstreamId: affinity.upstreamId,
    modelId: affinity.modelId,
    rulesPresent: affinity.rulesPresent,
    ...(affinity.rulesPresent ? { rules: affinity.rules as AliasRules } : {}),
    ...(affinity.upstreamItemId !== undefined ? { upstreamItemId: affinity.upstreamItemId } : {}),
    ...(affinity.syntheticItem === true ? { syntheticItem: true } : {}),
    ...(affinity.geminiPartFromEnd !== undefined ? { geminiPartFromEnd: affinity.geminiPartFromEnd } : {}),
  };
  return {
    version: 1,
    ...(origin !== undefined ? { origin } : {}),
    affinity: parsedAffinity,
  };
};

const concatBytes = (...parts: readonly Uint8Array[]): Uint8Array => {
  const result = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
};

const encryptedLengthMarker = (length: number): Uint8Array =>
  new Uint8Array([length >>> 8, length & 0xff]);

const encryptedLengthFrom = (bytes: Uint8Array): number =>
  (bytes[bytes.length - 2] << 8) | bytes[bytes.length - 1];

const ownedBuffer = (bytes: Uint8Array): ArrayBuffer => new Uint8Array(bytes).buffer;

const deriveAffinityKey = async (serverSecret: string): Promise<CryptoKey> => {
  const root = await crypto.subtle.importKey(
    'raw',
    ownedBuffer(parseServerSecretBytes(serverSecret)),
    'HKDF',
    false,
    ['deriveKey'],
  );
  return await crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: ownedBuffer(textEncoder.encode('Floway server secret v1')),
      info: ownedBuffer(textEncoder.encode('client-carried affinity v1')),
    },
    root,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
};

const authenticatedCarrierData = (domain: string, original: Uint8Array): Uint8Array => {
  const domainBytes = textEncoder.encode(domain);
  if (domainBytes.length > MAX_ENCRYPTED_BYTES) throw new RangeError('Affinity carrier domain exceeds the 2-byte length marker');
  return concatBytes(encryptedLengthMarker(domainBytes.length), domainBytes, original);
};

export class AffinityCodec {
  readonly #key: Promise<CryptoKey>;

  constructor(serverSecret: string) {
    this.#key = deriveAffinityKey(serverSecret);
  }

  async wrap(value: string | undefined, affinity: AffinityTarget, domain: string): Promise<string> {
    const original = value === undefined ? undefined : decodeOriginal(value);
    const originalBytes = original?.bytes ?? new Uint8Array();
    const envelope: AffinityEnvelope = {
      version: 1,
      ...(original !== undefined ? { origin: original.origin } : {}),
      affinity,
    };
    const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
    const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: ownedBuffer(authenticatedCarrierData(domain, originalBytes)) },
      await this.#key,
      textEncoder.encode(JSON.stringify(envelope)),
    ));
    const encrypted = concatBytes(iv, ciphertext);
    if (encrypted.length > MAX_ENCRYPTED_BYTES) throw new RangeError('Encrypted affinity envelope exceeds the 2-byte length marker');
    const framed = concatBytes(originalBytes, encrypted, encryptedLengthMarker(encrypted.length));
    return original?.origin === 'base64url' ? bytesToBase64url(framed) : bytesToBase64(framed);
  }

  async unwrap(value: string, domain: string): Promise<DecodedAffinityBlob> {
    const framed = decodeCanonicalBase64(value) ?? decodeCanonicalBase64url(value);
    if (framed === null || framed.length < LENGTH_BYTES + IV_BYTES + 16) return { kind: 'foreign', value };

    const encryptedLength = encryptedLengthFrom(framed);
    const originalLength = framed.length - LENGTH_BYTES - encryptedLength;
    if (encryptedLength < IV_BYTES + 16 || originalLength < 0) return { kind: 'foreign', value };

    const encrypted = framed.subarray(originalLength, framed.length - LENGTH_BYTES);
    const original = framed.subarray(0, originalLength);
    const iv = encrypted.subarray(0, IV_BYTES);
    const ciphertext = encrypted.subarray(IV_BYTES);
    try {
      const plaintext = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: ownedBuffer(iv), additionalData: ownedBuffer(authenticatedCarrierData(domain, original)) },
        await this.#key,
        ownedBuffer(ciphertext),
      );
      const envelope = parseEnvelope(JSON.parse(fatalTextDecoder.decode(plaintext)) as unknown);
      if (envelope === null) return { kind: 'foreign', value };
      if (envelope.origin === undefined) {
        return original.length === 0
          ? { kind: 'owned', envelope }
          : { kind: 'foreign', value };
      }
      return { kind: 'owned', value: encodeOriginal(original, envelope.origin), envelope };
    } catch {
      return { kind: 'foreign', value };
    }
  }
}
