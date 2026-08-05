import { serverSecretBytes } from '../../../../shared/server-secret.ts';
import { appendOpaqueTrailer, concatBytes, decodeOpaqueValue, encodeOpaqueValue, MAX_OPAQUE_TRAILER_BYTES, splitOpaqueTrailer, uint16be, type AliasRules, type OpaqueValueOrigin } from '@floway-dev/protocols/common';

export interface AffinityTarget {
  upstreamId: string;
  modelId: string;
  rules?: AliasRules;
}

interface AffinityData {
  version: 1;
  origin?: OpaqueValueOrigin;
  syntheticItem?: true;
  affinity: AffinityTarget;
}

export type DecodedAffinityBlob =
  | { kind: 'foreign'; value: string }
  | ({ kind: 'owned'; value?: string } & AffinityData);

const IV_BYTES = 12;
const textEncoder = new TextEncoder();
const fatalTextDecoder = new TextDecoder('utf-8', { fatal: true });

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const hasOnlyKeys = (value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean =>
  Object.keys(value).every(key => allowed.has(key));

const AFFINITY_DATA_KEYS = new Set(['version', 'origin', 'syntheticItem', 'affinity']);
const AFFINITY_TARGET_KEYS = new Set(['upstreamId', 'modelId', 'rules']);

const parseAffinityData = (value: unknown): AffinityData | null => {
  if (
    !isRecord(value)
    || !hasOnlyKeys(value, AFFINITY_DATA_KEYS)
    || value.version !== 1
    || !isRecord(value.affinity)
    || !hasOnlyKeys(value.affinity, AFFINITY_TARGET_KEYS)
  ) return null;
  const origin = value.origin;
  if (origin !== undefined && origin !== 'raw' && origin !== 'base64' && origin !== 'base64url') return null;
  const syntheticItem = value.syntheticItem;
  if (
    (syntheticItem !== undefined && syntheticItem !== true)
    || (syntheticItem === true && origin !== undefined)
  ) return null;

  const affinity = value.affinity;
  if (
    typeof affinity.upstreamId !== 'string'
    || typeof affinity.modelId !== 'string'
    || (affinity.rules !== undefined && !isRecord(affinity.rules))
  ) return null;

  const parsedAffinity: AffinityTarget = {
    upstreamId: affinity.upstreamId,
    modelId: affinity.modelId,
    ...(affinity.rules !== undefined ? { rules: affinity.rules as AliasRules } : {}),
  };
  return {
    version: 1,
    ...(origin !== undefined ? { origin } : {}),
    ...(syntheticItem === true ? { syntheticItem: true } : {}),
    affinity: parsedAffinity,
  };
};

const ownedBuffer = (bytes: Uint8Array): ArrayBuffer => new Uint8Array(bytes).buffer;

const deriveAffinityKey = async (serverSecret: Uint8Array): Promise<CryptoKey> => {
  const root = await crypto.subtle.importKey(
    'raw',
    ownedBuffer(serverSecret),
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
  if (domainBytes.length > MAX_OPAQUE_TRAILER_BYTES) throw new RangeError('Affinity carrier domain exceeds the 2-byte length marker');
  return concatBytes(uint16be(domainBytes.length), domainBytes, original);
};

export class AffinityCodec {
  readonly #key: Promise<CryptoKey>;

  constructor(serverSecret: string) {
    this.#key = deriveAffinityKey(serverSecretBytes(serverSecret));
  }

  async wrap(
    value: string | undefined,
    affinity: AffinityTarget,
    domain: string,
    options: { readonly syntheticItem?: true } = {},
  ): Promise<string> {
    if (options.syntheticItem === true && value !== undefined) {
      throw new TypeError('A synthetic affinity item cannot carry an original value');
    }
    const original = value === undefined ? undefined : decodeOpaqueValue(value);
    const originalBytes = original?.bytes ?? new Uint8Array();
    const data: AffinityData = {
      version: 1,
      ...(original !== undefined ? { origin: original.origin } : {}),
      ...(options.syntheticItem === true ? { syntheticItem: true } : {}),
      affinity,
    };
    const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
    const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: ownedBuffer(authenticatedCarrierData(domain, originalBytes)) },
      await this.#key,
      textEncoder.encode(JSON.stringify(data)),
    ));
    const encrypted = concatBytes(iv, ciphertext);
    if (encrypted.length > MAX_OPAQUE_TRAILER_BYTES) throw new RangeError('Encrypted affinity data exceeds the 2-byte length marker');
    return appendOpaqueTrailer(original, encrypted);
  }

  async unwrap(value: string, domain: string): Promise<DecodedAffinityBlob> {
    const framed = splitOpaqueTrailer(value, IV_BYTES + 16);
    if (framed === null) return { kind: 'foreign', value };

    const encrypted = framed.trailer;
    const original = framed.original;
    const iv = encrypted.subarray(0, IV_BYTES);
    const ciphertext = encrypted.subarray(IV_BYTES);
    const key = await this.#key;
    const additionalData = ownedBuffer(authenticatedCarrierData(domain, original));
    try {
      const plaintext = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: ownedBuffer(iv), additionalData },
        key,
        ownedBuffer(ciphertext),
      );
      const data = parseAffinityData(JSON.parse(fatalTextDecoder.decode(plaintext)) as unknown);
      if (data === null) return { kind: 'foreign', value };
      if (data.origin === undefined) {
        return original.length === 0
          ? { kind: 'owned', ...data }
          : { kind: 'foreign', value };
      }
      return { kind: 'owned', value: encodeOpaqueValue(original, data.origin), ...data };
    } catch {
      return { kind: 'foreign', value };
    }
  }
}
