// crc-32 ships pure CommonJS without an `exports` map. Cloudflare's bundler
// does CJS named-import interop, but raw Node ESM (and tsx, used by the Node
// platform target) rejects `import { buf } from 'crc-32'` with
// "Named export 'buf' not found". Default-import the namespace and destructure.
import crc32Mod from 'crc-32';

import type { ResponsesInputItem, ResponsesOutputItem } from '@floway-dev/protocols/responses';

const { buf: crc32 } = crc32Mod;

type ResponsesItemType = ResponsesInputItem['type'] | ResponsesOutputItem['type'];
type StorableResponsesItemType = Exclude<ResponsesItemType, 'item_reference' | 'compaction_trigger'> | 'compaction_summary';

const itemTypePrefixes = {
  message: 'msg',
  reasoning: 'rs',
  web_search_call: 'ws',
  function_call: 'fc',
  function_call_output: 'fco',
  custom_tool_call: 'ctc',
  custom_tool_call_output: 'ctco',
  file_search_call: 'fs',
  computer_call: 'cc',
  computer_call_output: 'cco',
  tool_search_call: 'ts',
  tool_search_output: 'tso',
  // OpenAI's Programmatic Tool Calling guide uses `prog_` and `prog_out_`
  // for these item ids. Codex independently uses `at_` for additional-tools
  // items in its durable history. These are gateway-generated storage ids,
  // not validation rules for opaque upstream ids.
  // https://github.com/stavarengo/claude-code-docs/blob/9cbe34a5c6cab42f9242395186b035f6b352b8c7/content/docs/openai/developers.openai.com/api/docs/guides/tools-programmatic-tool-calling.md#L139-L203
  // https://github.com/openai/codex/blob/385c0a9351e2199929e01f7864ec78a8f7d5e580/codex-rs/protocol/src/models.rs#L1216-L1234
  additional_tools: 'at',
  program: 'prog',
  program_output: 'prog_out',
  // OpenAI beta fixtures use `mac_` / `maco_`; Codex uses `amsg_` for its
  // Responses inter-agent envelope. `context_compaction` shares `cmp_` with
  // the distinct `compaction` variant.
  // https://github.com/openai/openai-java/blob/46917cce69b57721187b50313256488ed81bb023/openai-java-core/src/test/kotlin/com/openai/models/beta/responses/BetaResponseInputItemTest.kt#L1001-L1110
  // https://github.com/openai/codex/blob/9e552e9d15ba52bed7077d5357f3e18e330f8f38/codex-rs/protocol/src/models.rs#L1217-L1233
  agent_message: 'amsg',
  multi_agent_call: 'mac',
  multi_agent_call_output: 'maco',
  compaction: 'cmp',
  context_compaction: 'cmp',
  // `compaction_summary` is the Codex-side wire alias for `compaction` (the
  // protocol declares them as one variant via `#[serde(alias = ...)]`); both
  // mint the same `cmp_` prefix so a row written under either spelling
  // round-trips through `isResponsesItemId`.
  compaction_summary: 'cmp',
  image_generation_call: 'ig',
  code_interpreter_call: 'ci',
  local_shell_call: 'lsh',
  local_shell_call_output: 'lsho',
  shell_call: 'sh',
  shell_call_output: 'sho',
  apply_patch_call: 'ap',
  apply_patch_call_output: 'apo',
  mcp_call: 'mcp',
  mcp_list_tools: 'mcpl',
  mcp_approval_request: 'mcpar',
  mcp_approval_response: 'mcpa',
} as const satisfies Record<StorableResponsesItemType, string>;

const knownPrefixes = new Set<string>(Object.values(itemTypePrefixes));
const responsesIdPattern = /^(.+)_([A-Za-z0-9_-]{6})_([A-Za-z0-9_-]{22})$/;

// Client item ids are `<prefix>_<crc32(body)>_<body>` where `body` is 16 random
// bytes encoded as base64url (22 chars). The body is content-free on purpose:
// uniqueness comes from `crypto.getRandomValues`, and the crc32 prefix lets
// `isResponsesItemId` reject typos and accidental upstream collisions
// without re-hashing the original item.
export const createResponsesItemId = (itemType: string): string => {
  const body = randomBody();
  return `${prefixForItemType(itemType)}_${crc32Checksum(body)}_${body}`;
};

export const isResponsesItemId = (value: string): boolean =>
  isValidResponsesId(value, prefix => knownPrefixes.has(prefix));

export const responsesItemId = (item: object): string | null => {
  const id = 'id' in item ? item.id : undefined;
  return typeof id === 'string' && id.length > 0 ? id : null;
};

export const canonicalResponsesItemType = (itemType: string): string =>
  itemType === 'compaction_summary' ? 'compaction' : itemType;

export const hashResponsesItemContent = async (item: unknown): Promise<string> =>
  await sha256Hex(JSON.stringify(sortJson(item)));

export const createTemporaryResponsesItemId = (itemType: string): string => `${prefixForItemType(itemType)}_tmp_${randomBody()}`;

export const isTemporaryResponsesItemId = (value: string): boolean => /_tmp_[A-Za-z0-9_-]{22}$/.test(value);

// Gateway-owned response envelope id. A response from this gateway is not
// a 1:1 wrapper for an upstream response — the server-tool runtime can
// drive multiple upstream calls behind a single client-visible response —
// so we always mint our own id and never echo the upstream's. Each source
// response boundary mints one id and passes it to the client-output wrapper;
// the snapshot key and every downstream SSE/WS envelope then share it.
const responseEnvelopePrefix = 'resp';
export const createResponsesResponseId = (): string => {
  const body = randomBody();
  return `${responseEnvelopePrefix}_${crc32Checksum(body)}_${body}`;
};

export const isResponsesResponseId = (value: string): boolean =>
  isValidResponsesId(value, prefix => prefix === responseEnvelopePrefix);

// Validates that `value` matches `<prefix>_<crc6>_<body22>`, the prefix
// predicate accepts the prefix, and the crc32 of `body` matches the
// checksum.
const isValidResponsesId = (value: string, isPrefixValid: (prefix: string) => boolean): boolean => {
  const match = responsesIdPattern.exec(value);
  if (match === null) return false;
  const [, prefix, checksum, body] = match;
  return isPrefixValid(prefix) && crc32Checksum(body) === checksum;
};

const prefixForItemType = (itemType: string): string => {
  if (!Object.hasOwn(itemTypePrefixes, itemType)) throw new TypeError(`Unknown Responses item type: ${itemType}`);
  return itemTypePrefixes[itemType as keyof typeof itemTypePrefixes];
};

const sha256Hex = async (value: string): Promise<string> => {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
};

const randomBody = (): string => {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
};

const base64UrlEncode = (bytes: Uint8Array): string => {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/u, '');
};

const crc32Checksum = (input: string): string => {
  const crc = crc32(new TextEncoder().encode(input)) >>> 0;
  return base64UrlEncode(new Uint8Array([(crc >>> 24) & 0xff, (crc >>> 16) & 0xff, (crc >>> 8) & 0xff, crc & 0xff]));
};

const sortJson = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .toSorted(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([key, entry]) => [key, sortJson(entry)]),
  );
};
