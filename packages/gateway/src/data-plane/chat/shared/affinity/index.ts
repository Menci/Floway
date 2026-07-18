import { isEqual } from 'es-toolkit';

import { serverSecretBytes } from '../../../../shared/server-secret.ts';
import type { ChatGatewayCtx, GatewayCtx } from '../gateway-ctx.ts';
import type { RoutingDecision } from '../routing.ts';
import type { AliasRules } from '@floway-dev/protocols/common';
import type { ModelCandidate } from '@floway-dev/provider';

type AffinityOrigin = 'raw' | 'base64' | 'base64url';

export interface AffinityTarget {
  upstreamId: string;
  modelId: string;
  rules?: AliasRules;
}

export interface AffinityEvidence {
  readonly target: AffinityTarget;
  readonly mode: 'prefer' | 'force';
}

interface AffinityData {
  version: 1;
  origin?: AffinityOrigin;
  affinity: AffinityTarget;
}

export type DecodedAffinityBlob =
  | { kind: 'foreign'; value: string }
  | ({ kind: 'owned'; value?: string } & AffinityData);

export interface PreparedAffinityPayload<T> {
  readonly routingEvidence: readonly AffinityEvidence[];
  readonly payloadForCandidate: (candidate: ModelCandidate) => T;
}

const IV_BYTES = 12;
const LENGTH_MARKER_BYTES = 2;
const MAX_UINT16 = 0xffff;
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

const rawStringToBytes = (value: string): Uint8Array => {
  const bytes = new Uint8Array(value.length * 2);
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    bytes[index * 2] = codeUnit >>> 8;
    bytes[index * 2 + 1] = codeUnit & 0xff;
  }
  return bytes;
};

const rawStringFromBytes = (bytes: Uint8Array): string => {
  if (bytes.length % 2 !== 0) throw new TypeError('Raw affinity value has an odd byte length');
  let value = '';
  for (let offset = 0; offset < bytes.length; offset += 2) {
    value += String.fromCharCode((bytes[offset] << 8) | bytes[offset + 1]);
  }
  return value;
};

const decodeOriginal = (value: string): { bytes: Uint8Array; origin: AffinityOrigin } => {
  if (value.length > 0) {
    const base64 = decodeCanonicalBase64(value);
    if (base64 !== null) return { bytes: base64, origin: 'base64' };
    const base64url = decodeCanonicalBase64url(value);
    if (base64url !== null) return { bytes: base64url, origin: 'base64url' };
  }
  return { bytes: rawStringToBytes(value), origin: 'raw' };
};

const encodeOriginal = (bytes: Uint8Array, origin: AffinityOrigin): string => {
  switch (origin) {
  case 'base64': return bytesToBase64(bytes);
  case 'base64url': return bytesToBase64url(bytes);
  case 'raw': return rawStringFromBytes(bytes);
  }
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const hasOnlyKeys = (value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean =>
  Object.keys(value).every(key => allowed.has(key));

const AFFINITY_DATA_KEYS = new Set(['version', 'origin', 'affinity']);
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

const uint16be = (length: number): Uint8Array =>
  new Uint8Array([length >>> 8, length & 0xff]);

const readTrailingUint16be = (bytes: Uint8Array): number =>
  (bytes[bytes.length - 2] << 8) | bytes[bytes.length - 1];

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
  if (domainBytes.length > MAX_UINT16) throw new RangeError('Affinity carrier domain exceeds the 2-byte length marker');
  return concatBytes(uint16be(domainBytes.length), domainBytes, original);
};

export class AffinityCodec {
  readonly #key: Promise<CryptoKey>;

  constructor(serverSecret: string) {
    this.#key = deriveAffinityKey(serverSecretBytes(serverSecret));
  }

  async wrap(value: string | undefined, affinity: AffinityTarget, domain: string): Promise<string> {
    const original = value === undefined ? undefined : decodeOriginal(value);
    const originalBytes = original?.bytes ?? new Uint8Array();
    const data: AffinityData = {
      version: 1,
      ...(original !== undefined ? { origin: original.origin } : {}),
      affinity,
    };
    const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
    const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: ownedBuffer(authenticatedCarrierData(domain, originalBytes)) },
      await this.#key,
      textEncoder.encode(JSON.stringify(data)),
    ));
    const encrypted = concatBytes(iv, ciphertext);
    if (encrypted.length > MAX_UINT16) throw new RangeError('Encrypted affinity data exceeds the 2-byte length marker');
    const framed = concatBytes(originalBytes, encrypted, uint16be(encrypted.length));
    return original?.origin === 'base64url' ? bytesToBase64url(framed) : bytesToBase64(framed);
  }

  async unwrap(value: string, domain: string): Promise<DecodedAffinityBlob> {
    const framed = decodeCanonicalBase64(value) ?? decodeCanonicalBase64url(value);
    if (framed === null || framed.length < LENGTH_MARKER_BYTES + IV_BYTES + 16) return { kind: 'foreign', value };

    const encryptedLength = readTrailingUint16be(framed);
    const originalLength = framed.length - LENGTH_MARKER_BYTES - encryptedLength;
    if (encryptedLength < IV_BYTES + 16 || originalLength < 0) return { kind: 'foreign', value };

    const encrypted = framed.subarray(originalLength, framed.length - LENGTH_MARKER_BYTES);
    const original = framed.subarray(0, originalLength);
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
      return { kind: 'owned', value: encodeOriginal(original, data.origin), ...data };
    } catch {
      return { kind: 'foreign', value };
    }
  }
}

export interface AffinityEgressOptions {
  readonly codec: Pick<AffinityCodec, 'wrap'>;
  readonly affinity: AffinityTarget;
}

const sameForcedTarget = (left: AffinityTarget, right: AffinityTarget): boolean =>
  left.upstreamId === right.upstreamId && left.modelId === right.modelId;

const affinityTargetForCandidate = (candidate: ModelCandidate): AffinityTarget => ({
  upstreamId: candidate.provider.upstream,
  modelId: candidate.model.id,
  ...(candidate.rules !== undefined ? { rules: candidate.rules } : {}),
});

const candidateMatchesExactTarget = (candidate: ModelCandidate, affinity: AffinityTarget): boolean =>
  candidate.provider.upstream === affinity.upstreamId
  && candidate.model.id === affinity.modelId
  // Alias targets always carry a rules object, while direct candidates omit
  // it. Both shapes describe the same no-overlay variant when the object is
  // empty, which lets a pre-alias session follow its real binding after a
  // same-name alias starts shadowing that model.
  && isEqual(candidate.rules ?? {}, affinity.rules ?? {});

const candidateMatchesForcedTarget = (candidate: ModelCandidate, affinity: AffinityTarget): boolean =>
  candidate.provider.upstream === affinity.upstreamId && candidate.model.id === affinity.modelId;

const reorderByLatestAvailablePreference = <T extends ModelCandidate>(
  candidates: readonly T[],
  evidence: readonly AffinityEvidence[],
): readonly T[] => {
  for (let index = evidence.length - 1; index >= 0; index -= 1) {
    if (evidence[index].mode !== 'prefer') continue;
    const preferred = evidence[index].target;
    const matching = candidates.filter(candidate => candidateMatchesExactTarget(candidate, preferred));
    if (matching.length === 0) continue;
    return [
      ...matching,
      ...candidates.filter(candidate => !candidateMatchesExactTarget(candidate, preferred)),
    ];
  }
  return candidates;
};

export const routeCandidatesByAffinity = <T extends ModelCandidate>(
  candidates: readonly T[],
  evidence: readonly AffinityEvidence[],
): RoutingDecision<T> => {
  const forcing: AffinityTarget[] = [];
  for (const item of evidence) {
    if (item.mode === 'force' && !forcing.some(existing => sameForcedTarget(existing, item.target))) forcing.push(item.target);
  }
  if (forcing.length > 1) {
    return {
      kind: 'failure',
      failure: {
        kind: 'routing-unavailable',
        message: `Client-carried state requires multiple incompatible targets: ${forcing.map(target => `'${target.upstreamId}/${target.modelId}'`).join(', ')}.`,
      },
    };
  }

  const narrowed = forcing.length === 0
    ? candidates
    : candidates.filter(candidate => candidateMatchesForcedTarget(candidate, forcing[0]));
  if (forcing.length === 1 && narrowed.length === 0) {
    return {
      kind: 'failure',
      failure: {
        kind: 'routing-unavailable',
        message: `Client-carried state requires unavailable target '${forcing[0].upstreamId}/${forcing[0].modelId}'.`,
      },
    };
  }

  return { kind: 'success', candidates: reorderByLatestAvailablePreference(narrowed, evidence) as readonly T[] };
};

type CandidateBlob =
  | { readonly present: false }
  | { readonly present: true; readonly value: string };

const blobForCompatibility = (decoded: DecodedAffinityBlob, compatible: boolean): CandidateBlob => {
  if (decoded.kind === 'foreign') return { present: true, value: decoded.value };
  if (!compatible || decoded.value === undefined) return { present: false };
  return { present: true, value: decoded.value };
};

export const blobForExactCandidate = (decoded: DecodedAffinityBlob, candidate: ModelCandidate): CandidateBlob =>
  blobForCompatibility(
    decoded,
    decoded.kind === 'owned' && candidateMatchesExactTarget(candidate, decoded.affinity),
  );

export const blobForForcedCandidate = (decoded: DecodedAffinityBlob, candidate: ModelCandidate): CandidateBlob =>
  blobForCompatibility(
    decoded,
    decoded.kind === 'owned' && candidateMatchesForcedTarget(candidate, decoded.affinity),
  );

export const preferredAffinityEvidence = (decoded: Iterable<DecodedAffinityBlob>): AffinityEvidence[] =>
  [...decoded].flatMap(blob => blob.kind === 'owned' ? [{ target: blob.affinity, mode: 'prefer' }] : []);

export class AffinityRequestContext {
  readonly codec: AffinityCodec;
  #selectedCandidate: ModelCandidate | undefined;

  constructor(secret: string) {
    this.codec = new AffinityCodec(secret);
  }

  select(candidate: ModelCandidate): void {
    this.#selectedCandidate = candidate;
  }

  selectedTarget(): AffinityTarget {
    if (this.#selectedCandidate === undefined) throw new Error('Affinity target requested before a candidate was selected');
    return affinityTargetForCandidate(this.#selectedCandidate);
  }
}

export const affinityEgressOptions = (ctx: GatewayCtx): AffinityEgressOptions => {
  if (!('affinity' in ctx)) throw new Error('Chat event result reached responder without affinity context');
  const chatCtx = ctx as ChatGatewayCtx;
  return { codec: chatCtx.affinity.codec, affinity: chatCtx.affinity.selectedTarget() };
};
