import type {
  CanonicalOpenAIResponsesPayload,
  OpenAIResponsesInputAdditionalToolsItem,
  OpenAIResponsesInputItem,
  OpenAIResponsesInputMessage,
  OpenAIResponsesTool,
} from './index.ts';
import type { OpenAIResponsesEndpoint, OpenAIResponsesTransport } from '../common/index.ts';

// Codex selects Responses Lite with this request header. WebSocket requests
// carry the same decision per message because one socket may change models.
// https://github.com/openai/codex/blob/315195492c80fdade38e917c18f9584efd599304/codex-rs/core/src/client.rs#L155-L163
export const OPENAI_RESPONSES_LITE_HEADER = 'x-openai-internal-codex-responses-lite';
export const OPENAI_RESPONSES_LITE_WS_METADATA_KEY = 'ws_request_header_x_openai_internal_codex_responses_lite';

// https://github.com/openai/codex/commit/84c989acf9af93f35c2f3c36b297cd4dc0f830b3
export const OPENAI_RESPONSES_LITE_BASE_INSTRUCTIONS_KIND = 'model.base_instructions';

// UUID namespace constants are defined by RFC 9562. Codex derives a
// thread-scoped UUIDv5 namespace from NAMESPACE_OID, then derives each prefix
// item id from its visible payload inside that namespace.
// https://www.rfc-editor.org/rfc/rfc9562.html#name-name-based-uuid-generation
const UUID_NAMESPACE_OID = '6ba7b812-9dad-11d1-80b4-00c04fd430c8';

const rotateLeft = (value: number, count: number): number => (value << count) | (value >>> (32 - count));

// Small runtime-neutral SHA-1 implementation used solely for UUIDv5 wire ids.
// UUIDv5 mandates SHA-1; this is identity derivation, not a security primitive.
const sha1 = (source: Uint8Array): Uint8Array => {
  const bitLength = source.length * 8;
  const paddedLength = Math.ceil((source.length + 9) / 64) * 64;
  const bytes = new Uint8Array(paddedLength);
  bytes.set(source);
  bytes[source.length] = 0x80;
  const view = new DataView(bytes.buffer);
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x1_0000_0000));
  view.setUint32(paddedLength - 4, bitLength >>> 0);
  let h0 = 0x67452301;
  let h1 = 0xefcdab89;
  let h2 = 0x98badcfe;
  let h3 = 0x10325476;
  let h4 = 0xc3d2e1f0;
  const words = new Uint32Array(80);
  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let i = 0; i < 16; i++) words[i] = view.getUint32(offset + i * 4);
    for (let i = 16; i < 80; i++) words[i] = rotateLeft(words[i - 3] ^ words[i - 8] ^ words[i - 14] ^ words[i - 16], 1) >>> 0;
    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    for (let i = 0; i < 80; i++) {
      const f = i < 20 ? (b & c) | (~b & d) : i < 40 ? b ^ c ^ d : i < 60 ? (b & c) | (b & d) | (c & d) : b ^ c ^ d;
      const k = i < 20 ? 0x5a827999 : i < 40 ? 0x6ed9eba1 : i < 60 ? 0x8f1bbcdc : 0xca62c1d6;
      const temp = (rotateLeft(a, 5) + f + e + k + words[i]) >>> 0;
      e = d;
      d = c;
      c = rotateLeft(b, 30) >>> 0;
      b = a;
      a = temp;
    }
    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
  }
  const digest = new Uint8Array(20);
  const digestView = new DataView(digest.buffer);
  [h0, h1, h2, h3, h4].forEach((word, index) => digestView.setUint32(index * 4, word));
  return digest;
};

const uuidBytes = (uuid: string): Uint8Array => Uint8Array.from(
  uuid.replaceAll('-', '').match(/.{2}/g) ?? [],
  byte => Number.parseInt(byte, 16),
);

const uuidV5 = (value: string, namespace: string): string => {
  const namespaceBytes = uuidBytes(namespace);
  const valueBytes = new TextEncoder().encode(value);
  const source = new Uint8Array(namespaceBytes.length + valueBytes.length);
  source.set(namespaceBytes);
  source.set(valueBytes, namespaceBytes.length);
  const bytes = sha1(source).slice(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

export class OpenAIResponsesLiteInputError extends TypeError {
  readonly param: string | undefined;

  constructor(message: string, param?: string) {
    super(message);
    this.name = 'OpenAIResponsesLiteInputError';
    this.param = param;
  }
}

export interface OpenAIResponsesLiteConversionOptions {
  /** Stable conversation identity used for Codex-compatible prefix item ids. */
  identity?: string;
}

export const openAIResponsesTransportForEndpoint = (
  endpoint: OpenAIResponsesEndpoint | undefined,
): OpenAIResponsesTransport => endpoint?.transport ?? 'standard';

const transportBoolean = (value: unknown, param: string): boolean | undefined => {
  if (value === undefined || value === null) return undefined;
  if (value === true || value === 'true') return true;
  if (value === false || value === 'false') return false;
  throw new OpenAIResponsesLiteInputError('Responses Lite transport marker must be true or false', param);
};

export const openAIResponsesTransportForRequest = (
  payload: CanonicalOpenAIResponsesPayload,
  headers: Headers,
): OpenAIResponsesTransport => {
  const metadataValue = payload.client_metadata?.[OPENAI_RESPONSES_LITE_WS_METADATA_KEY];
  const enabled = transportBoolean(
    metadataValue ?? headers.get(OPENAI_RESPONSES_LITE_HEADER) ?? undefined,
    metadataValue != null ? `client_metadata.${OPENAI_RESPONSES_LITE_WS_METADATA_KEY}` : OPENAI_RESPONSES_LITE_HEADER,
  );
  return enabled ? 'lite' : 'standard';
};

const firstUserPrefix = (payload: CanonicalOpenAIResponsesPayload): OpenAIResponsesInputItem[] => {
  const prefix: OpenAIResponsesInputItem[] = [];
  for (const item of payload.input) {
    prefix.push(item);
    if (item.type === 'message' && item.role === 'user') break;
  }
  return prefix;
};

const nonBlank = (value: string | null | undefined): string | undefined =>
  typeof value === 'string' && value.trim() !== '' ? value : undefined;

const liteIdentity = (
  payload: CanonicalOpenAIResponsesPayload,
  explicit: string | undefined,
): string => nonBlank(explicit)
  ?? nonBlank(payload.client_metadata?.thread_id)
  ?? nonBlank(payload.client_metadata?.session_id)
  ?? nonBlank(payload.prompt_cache_key)
  // Stateless callers append later turns to the same first-user prefix. This
  // fallback therefore remains stable across the conversation while avoiding
  // model-wide id collisions when no Codex identity metadata is present.
  ?? JSON.stringify({ model: payload.model, instructions: payload.instructions ?? '', input: firstUserPrefix(payload) });

// https://github.com/openai/codex/blob/84c989acf9af93f35c2f3c36b297cd4dc0f830b3/codex-rs/core/src/client.rs#L833-L860
const stableItemId = (
  prefix: 'at' | 'msg',
  identity: string,
  visiblePayload: string,
): string => {
  const prefixNamespace = uuidV5(identity, UUID_NAMESPACE_OID);
  return `${prefix}_${uuidV5(visiblePayload, prefixNamespace)}`;
};

// A tool shim changes the visible payload of an existing durable prefix. Scope
// its replacement identity to that original item so retries agree, while
// untouched tool declarations keep the client's identity verbatim.
export const replaceOpenAIResponsesAdditionalTools = (
  item: OpenAIResponsesInputAdditionalToolsItem,
  tools: OpenAIResponsesTool[],
): OpenAIResponsesInputAdditionalToolsItem => {
  const visiblePayload = JSON.stringify(tools);
  if (visiblePayload === JSON.stringify(item.tools)) return item;
  return {
    ...item,
    tools,
    ...(item.id != null ? { id: stableItemId('at', item.id, visiblePayload) } : {}),
  };
};

// The Lite wire omits image detail on messages and client tool outputs. Image
// preparation in the Codex application is separate from this wire conversion;
// preserve every reference and its positional metadata for upstream validation.
// https://github.com/openai/codex/blob/3319d9b296bba4cad340ffa997d216d95f601992/codex-rs/core/src/client_common.rs#L67-L116
const stripLiteImageDetails = <T extends { type: string; detail?: unknown }>(content: T[]): T[] => content.map(part => {
  if (part.type !== 'input_image') return part;
  const prepared = { ...part };
  delete prepared.detail;
  return prepared;
});

const prepareLiteInput = (input: readonly OpenAIResponsesInputItem[]): OpenAIResponsesInputItem[] => input.map(item => {
  if (item.type === 'message' && Array.isArray(item.content)) {
    return { ...item, content: stripLiteImageDetails(item.content) };
  }
  if ((item.type === 'function_call_output' || item.type === 'custom_tool_call_output') && Array.isArray(item.output)) {
    return { ...item, output: stripLiteImageDetails(item.output) };
  }
  return item;
});

const withoutLiteMetadata = (
  metadata: Record<string, string> | null | undefined,
): Record<string, string> | null | undefined => {
  if (!metadata || !(OPENAI_RESPONSES_LITE_WS_METADATA_KEY in metadata)) return metadata;
  const next = { ...metadata };
  delete next[OPENAI_RESPONSES_LITE_WS_METADATA_KEY];
  return Object.keys(next).length > 0 ? next : undefined;
};

export const isOpenAIResponsesLiteBaseInstructionsMessage = (item: OpenAIResponsesInputItem | undefined): boolean => {
  if (item?.type !== 'message' || item.role !== 'developer') return false;
  const kinds = item.internal_chat_message_metadata_passthrough?.content_item_kinds;
  const contentLength = typeof item.content === 'string' ? 1 : item.content.length;
  return Array.isArray(kinds) && kinds.length === contentLength && kinds.length > 0
    && kinds.every(kind => kind === OPENAI_RESPONSES_LITE_BASE_INSTRUCTIONS_KIND);
};

const instructionsFromMessage = (item: OpenAIResponsesInputMessage): string => {
  if (typeof item.content === 'string') return item.content;
  const text: string[] = [];
  for (const part of item.content) {
    if ((part.type !== 'input_text' && part.type !== 'output_text') || typeof part.text !== 'string') {
      throw new OpenAIResponsesLiteInputError('Responses Lite base instructions must contain only text', 'input');
    }
    text.push(part.text);
  }
  return text.join('');
};

export const toStandardOpenAIResponsesPayload = (
  payload: CanonicalOpenAIResponsesPayload,
): CanonicalOpenAIResponsesPayload => {
  if ((payload.instructions != null && payload.instructions !== '') || payload.tools != null) {
    throw new OpenAIResponsesLiteInputError('Responses Lite payload must not declare top-level instructions or tools', 'instructions');
  }
  const input = [...payload.input];
  let tools: OpenAIResponsesTool[] | undefined;
  let instructions: string | undefined;
  const first = input[0];
  if (first?.type === 'additional_tools' && first.role === 'developer') {
    tools = first.tools;
    input.shift();
  }
  const nextFirst = input[0];
  if (nextFirst?.type === 'message' && isOpenAIResponsesLiteBaseInstructionsMessage(nextFirst)) {
    instructions = instructionsFromMessage(nextFirst);
    input.shift();
  }
  const metadata = withoutLiteMetadata(payload.client_metadata);
  const next = { ...payload, input, ...(tools ? { tools } : {}), ...(instructions !== undefined ? { instructions } : {}) };
  delete next.client_metadata;
  if (metadata !== undefined) next.client_metadata = metadata;
  return next;
};

export const toLiteOpenAIResponsesPayload = (
  payload: CanonicalOpenAIResponsesPayload,
  options: OpenAIResponsesLiteConversionOptions = {},
): CanonicalOpenAIResponsesPayload => {
  const input: OpenAIResponsesInputItem[] = [];
  // Namespace wrapping is a Codex provider capability, not a Lite wire rule.
  // Preserve tool identity for forced choices, call outputs and history replay;
  // provider-owned interceptors decide which hosted tools require emulation.
  // https://github.com/openai/codex/blob/3319d9b296bba4cad340ffa997d216d95f601992/codex-rs/core/src/client.rs#L802-L806
  const tools = payload.tools ?? [];
  const identity = liteIdentity(payload, options.identity);
  const additionalTools: OpenAIResponsesInputAdditionalToolsItem = {
    type: 'additional_tools',
    role: 'developer',
    tools,
    id: stableItemId('at', identity, JSON.stringify(tools)),
  };
  input.push(additionalTools);
  if (payload.instructions != null && payload.instructions !== '') {
    input.push({
      type: 'message',
      role: 'developer',
      id: stableItemId('msg', identity, payload.instructions),
      content: [{ type: 'input_text', text: payload.instructions }],
      internal_chat_message_metadata_passthrough: { content_item_kinds: [OPENAI_RESPONSES_LITE_BASE_INSTRUCTIONS_KIND] },
    });
  }
  input.push(...prepareLiteInput(payload.input));
  const next: CanonicalOpenAIResponsesPayload = {
    ...payload,
    input,
    parallel_tool_calls: false,
    reasoning: { ...(payload.reasoning ?? {}), context: 'all_turns' },
  };
  delete next.instructions;
  delete next.tools;
  return next;
};

export const convertOpenAIResponsesTransport = (
  payload: CanonicalOpenAIResponsesPayload,
  source: OpenAIResponsesTransport,
  target: OpenAIResponsesTransport,
  options: OpenAIResponsesLiteConversionOptions = {},
): CanonicalOpenAIResponsesPayload => {
  const metadata = withoutLiteMetadata(payload.client_metadata);
  const normalized = { ...payload };
  delete normalized.client_metadata;
  if (metadata !== undefined) normalized.client_metadata = metadata;
  // A native request already has its own durable prefix identities and input
  // controls. Rebuilding it would change cache identity and chronology.
  if (source === target) return normalized;
  const standard = source === 'lite' ? toStandardOpenAIResponsesPayload(normalized) : normalized;
  return target === 'lite' ? toLiteOpenAIResponsesPayload(standard, options) : standard;
};
