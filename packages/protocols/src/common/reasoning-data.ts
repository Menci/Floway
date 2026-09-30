import { decodeCanonicalBase64url, encodeBase64url } from './base-encoding.ts';

const PREFIX = 'floway-reasoning-v1:';
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

export interface ReasoningDataEnvelope {
  readonly version: 1;
  readonly type: string;
  readonly value: unknown;
}

export const encodeReasoningData = (type: string, value: unknown): string =>
  PREFIX + encodeBase64url(encoder.encode(JSON.stringify({ version: 1, type, value })));

export const decodeReasoningData = (value: string): ReasoningDataEnvelope | undefined => {
  if (!value.startsWith(PREFIX)) return undefined;
  try {
    const bytes = decodeCanonicalBase64url(value.slice(PREFIX.length));
    if (bytes === null) throw new TypeError('Invalid base64url');
    const parsed: unknown = JSON.parse(decoder.decode(bytes));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new TypeError('Expected an object');
    const envelope = parsed as Record<string, unknown>;
    if (envelope.version !== 1 || typeof envelope.type !== 'string' || !Object.hasOwn(envelope, 'value')) throw new TypeError('Invalid envelope shape');
    if (Object.keys(envelope).some(key => key !== 'version' && key !== 'type' && key !== 'value')) throw new TypeError('Unexpected envelope field');
    return envelope as unknown as ReasoningDataEnvelope;
  } catch (cause) {
    throw new Error('Malformed Floway reasoning data envelope', { cause });
  }
};
