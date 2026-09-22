import { serverSecretBytes } from '../../../../shared/server-secret.ts';
import { appendOpaqueTrailer, concatBytes, decodeOpaqueValue, encodeOpaqueValue, MAX_OPAQUE_TRAILER_BYTES, splitOpaqueTrailer, uint16be, type AliasRules, type OpaqueBlobCompatibilityIdentity, type OpaqueValueOrigin } from '@floway-dev/protocols/common';

export type { OpaqueBlobCompatibilityIdentity } from '@floway-dev/protocols/common';

export interface AffinityTarget {
  upstreamId: string;
  modelId: string;
  rules?: AliasRules;
}

export interface AffinityIdentity extends AffinityTarget {
  opaqueBlobCompatibilityIdentity: OpaqueBlobCompatibilityIdentity;
}

interface AffinityDataV1 {
  version: 1;
  origin?: OpaqueValueOrigin;
  syntheticItem?: true;
  affinity: AffinityTarget;
}

interface AffinityDataV2 {
  version: 2;
  origin?: OpaqueValueOrigin;
  syntheticItem?: true;
  affinity: AffinityTarget;
  opaqueBlobCompatibilityIdentity: OpaqueBlobCompatibilityIdentity;
}

type AffinityData = AffinityDataV1 | AffinityDataV2;

export type LegacyAffinityIdentityResolver = (
  affinity: AffinityTarget,
) => Promise<OpaqueBlobCompatibilityIdentity | undefined>;

export type DecodedAffinityBlob =
  | { kind: 'foreign'; value: string }
  | ({ kind: 'owned'; value?: string; opaqueBlobCompatibilityIdentity: OpaqueBlobCompatibilityIdentity } & AffinityData);

export const affinityIdentityOf = (
  decoded: Extract<DecodedAffinityBlob, { kind: 'owned' }>,
): AffinityIdentity => ({
  ...decoded.affinity,
  opaqueBlobCompatibilityIdentity: decoded.opaqueBlobCompatibilityIdentity,
});

const IV_BYTES = 12;
const textEncoder = new TextEncoder();
const fatalTextDecoder = new TextDecoder('utf-8', { fatal: true });

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const hasOnlyKeys = (value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean =>
  Object.keys(value).every(key => allowed.has(key));

const AFFINITY_DATA_V1_KEYS = new Set(['version', 'origin', 'syntheticItem', 'affinity']);
const AFFINITY_DATA_V2_KEYS = new Set([...AFFINITY_DATA_V1_KEYS, 'opaqueBlobCompatibilityIdentity']);
const AFFINITY_TARGET_KEYS = new Set(['upstreamId', 'modelId', 'rules']);
const COMPATIBILITY_IDENTITY_KEYS = new Set(['upstreamId', 'key']);

const parseAffinityData = (value: unknown): AffinityData | null => {
  if (
    !isRecord(value)
    || (value.version !== 1 && value.version !== 2)
    || !hasOnlyKeys(value, value.version === 1 ? AFFINITY_DATA_V1_KEYS : AFFINITY_DATA_V2_KEYS)
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
  if (value.version === 2) {
    const identity = value.opaqueBlobCompatibilityIdentity;
    if (
      !isRecord(identity)
      || !hasOnlyKeys(identity, COMPATIBILITY_IDENTITY_KEYS)
      || typeof identity.key !== 'string'
      || identity.key.length === 0
      || (identity.upstreamId !== undefined && typeof identity.upstreamId !== 'string')
    ) return null;
    return {
      version: 2,
      ...(origin !== undefined ? { origin } : {}),
      ...(syntheticItem === true ? { syntheticItem: true } : {}),
      affinity: parsedAffinity,
      opaqueBlobCompatibilityIdentity: {
        ...(identity.upstreamId !== undefined ? { upstreamId: identity.upstreamId } : {}),
        key: identity.key,
      },
    };
  }
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
  readonly #resolveLegacyIdentity: LegacyAffinityIdentityResolver;
  readonly #legacyIdentities = new Map<string, Promise<OpaqueBlobCompatibilityIdentity | undefined>>();

  constructor(serverSecret: string, resolveLegacyIdentity: LegacyAffinityIdentityResolver = async () => undefined) {
    this.#key = deriveAffinityKey(serverSecretBytes(serverSecret));
    this.#resolveLegacyIdentity = resolveLegacyIdentity;
  }

  #legacyIdentity(affinity: AffinityTarget): Promise<OpaqueBlobCompatibilityIdentity | undefined> {
    const key = `${affinity.upstreamId}\0${affinity.modelId}`;
    const existing = this.#legacyIdentities.get(key);
    if (existing !== undefined) return existing;
    const resolving = this.#resolveLegacyIdentity(affinity);
    this.#legacyIdentities.set(key, resolving);
    resolving.catch(() => this.#legacyIdentities.delete(key));
    return resolving;
  }

  async wrap(
    value: string | undefined,
    identity: AffinityIdentity,
    domain: string,
    options: { readonly syntheticItem?: true } = {},
  ): Promise<string> {
    if (options.syntheticItem === true && value !== undefined) {
      throw new TypeError('A synthetic affinity item cannot carry an original value');
    }
    const original = value === undefined ? undefined : decodeOpaqueValue(value);
    const originalBytes = original?.bytes ?? new Uint8Array();
    const { opaqueBlobCompatibilityIdentity, ...affinity } = identity;
    const data: AffinityDataV2 = {
      version: 2,
      ...(original !== undefined ? { origin: original.origin } : {}),
      ...(options.syntheticItem === true ? { syntheticItem: true } : {}),
      affinity,
      opaqueBlobCompatibilityIdentity,
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
    let data: AffinityData;
    try {
      const plaintext = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: ownedBuffer(iv), additionalData },
        key,
        ownedBuffer(ciphertext),
      );
      const parsed = parseAffinityData(JSON.parse(fatalTextDecoder.decode(plaintext)) as unknown);
      if (parsed === null) return { kind: 'foreign', value };
      data = parsed;
    } catch {
      return { kind: 'foreign', value };
    }
    const opaqueBlobCompatibilityIdentity = data.version === 2
      ? data.opaqueBlobCompatibilityIdentity
      : await this.#legacyIdentity(data.affinity) ?? {
        upstreamId: data.affinity.upstreamId,
        key: data.affinity.modelId,
      };
    if (data.origin === undefined) {
      return original.length === 0
        ? { kind: 'owned', ...data, opaqueBlobCompatibilityIdentity }
        : { kind: 'foreign', value };
    }
    return { kind: 'owned', value: encodeOpaqueValue(original, data.origin), ...data, opaqueBlobCompatibilityIdentity };
  }
}
