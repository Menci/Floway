import { decodeCanonicalBase64, encodeBase64 } from '../common/base-encoding.ts';

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const DATA_FIELDS = {
  'openrouter-reasoning-details': 'reasoning_details',
  'litellm-thinking-blocks': 'thinking_blocks',
  'litellm-reasoning-items': 'reasoning_items',
} as const;

export type StructuredChatCompletionsReasoningDataStandard = keyof typeof DATA_FIELDS;

export interface StructuredChatCompletionsReasoningData {
  readonly type: StructuredChatCompletionsReasoningDataStandard;
  readonly value: unknown;
}

export const encodeChatCompletionsReasoningData = (type: StructuredChatCompletionsReasoningDataStandard, value: readonly unknown[]): string =>
  encodeBase64(encoder.encode(JSON.stringify({ type, [DATA_FIELDS[type]]: value })));

export const decodeChatCompletionsReasoningData = (value: string): StructuredChatCompletionsReasoningData | undefined => {
  const bytes = decodeCanonicalBase64(value);
  if (bytes === null) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoder.decode(bytes));
  } catch {
    // Native opaque strings need not contain JSON or even UTF-8.
    return undefined;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
  const envelope = parsed as Record<string, unknown>;
  if (typeof envelope.type !== 'string' || !Object.hasOwn(DATA_FIELDS, envelope.type)) return undefined;
  const type = envelope.type as StructuredChatCompletionsReasoningDataStandard;
  const field = DATA_FIELDS[type];
  if (!Object.hasOwn(envelope, field) || Object.keys(envelope).some(key => key !== 'type' && key !== field)) return undefined;
  return { type, value: envelope[field] };
};
