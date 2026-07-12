// crc-32 ships pure CommonJS without an `exports` map. Cloudflare's bundler
// does CJS named-import interop, but raw Node ESM (and tsx, used by the Node
// platform target) rejects `import { buf } from 'crc-32'` with
// "Named export 'buf' not found". Default-import the namespace and destructure.
import crc32Mod from 'crc-32';

import type { ResponsesInputItem } from '@floway-dev/protocols/responses';

const { buf: crc32 } = crc32Mod;

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
  compaction: 'cmp',
  // `compaction_summary` is the Codex-side wire alias for `compaction` (the
  // protocol declares them as one variant via `#[serde(alias = ...)]`); both
  // mint the same `cmp_` prefix so a row written under either spelling
  // round-trips through `isStoredResponsesItemId`.
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
  // Programmatic Tool Calling output items — persisted for `previous_response_id`
  // snapshot stitching so the model sees its own prior program execution on
  // subsequent turns. See `packages/protocols/src/responses/tool-search-family.ts`
  // for the surrounding tool_search family design.
  program: 'pg',
  program_output: 'pgo',
} as const satisfies Record<string, string>;

const knownPrefixes = new Set<string>(Object.values(itemTypePrefixes));
const bodyPattern = /^[A-Za-z0-9_-]{22}$/;
const checksumPattern = /^[A-Za-z0-9_-]{6}$/;

// Stored ids are `<prefix>_<crc32(body)>_<body>` where `body` is 16 random
// bytes encoded as base64url (22 chars). The body is content-free on purpose:
// uniqueness comes from `crypto.getRandomValues`, and the crc32 prefix lets
// `isStoredResponsesItemId` reject typos and accidental upstream collisions
// without re-hashing the original item.
export const createStoredResponsesItemId = (itemType: string): string => {
  const body = randomBody();
  return `${prefixForItemType(itemType)}_${crc32Checksum(body)}_${body}`;
};

export const isStoredResponsesItemId = (value: string): boolean =>
  isValidStoredId(value, prefix => knownPrefixes.has(prefix));

// Codex and other stateless Responses clients echo reasoning and compaction
// items back with their `encrypted_content` blob but no gateway id (the id is
// stripped client-side). The blob is signed against the producing upstream
// account, so we key such items by its hash to recover the owning upstream for
// affinity routing.
export const responsesItemId = (item: { id?: unknown }): string | null => {
  const id = item.id;
  return typeof id === 'string' && id.length > 0 ? id : null;
};

export const responsesItemEncryptedContent = (item: ResponsesInputItem): string | null => {
  const value = (item as { encrypted_content?: unknown }).encrypted_content;
  return typeof value === 'string' && value.length > 0 ? value : null;
};

export const hashResponsesItemEncryptedContent = async (encryptedContent: string): Promise<string> => {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(encryptedContent));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
};

export const hashResponsesItemContent = async (item: ResponsesInputItem): Promise<string> => {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(sortJson(item))));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
};

export const createTemporaryResponsesItemId = (itemType: string): string => `${prefixForItemType(itemType)}_tmp_${randomBody()}`;

// Gateway-owned response envelope id. A response from this gateway is not
// a 1:1 wrapper for an upstream response — the server-tool runtime can
// drive multiple upstream calls behind a single client-visible response —
// so we always mint our own id and never echo the upstream's. The wrap
// layer is the only place this is generated; everything downstream of
// wrap (the snapshot store key, the SSE/WS frames the client sees) carries
// this id.
const responseEnvelopePrefix = 'resp';
export const createStoredResponseId = (): string => {
  const body = randomBody();
  return `${responseEnvelopePrefix}_${crc32Checksum(body)}_${body}`;
};

export const isStoredResponseId = (value: string): boolean =>
  isValidStoredId(value, prefix => prefix === responseEnvelopePrefix);

// Validates that `value` matches `<prefix>_<crc6>_<body22>`, the prefix
// predicate accepts the prefix, and the crc32 of `body` matches the
// checksum.
const isValidStoredId = (value: string, isPrefixValid: (prefix: string) => boolean): boolean => {
  const firstSeparator = value.indexOf('_');
  if (firstSeparator <= 0) return false;
  const checksumStart = firstSeparator + 1;
  const checksumEnd = checksumStart + 6;
  if (value[checksumEnd] !== '_') return false;
  const prefix = value.slice(0, firstSeparator);
  const checksum = value.slice(checksumStart, checksumEnd);
  const body = value.slice(checksumEnd + 1);
  if (!isPrefixValid(prefix)) return false;
  if (!checksumPattern.test(checksum) || !bodyPattern.test(body)) return false;
  return crc32Checksum(body) === checksum;
};

const prefixForItemType = (itemType: string): string => {
  const prefix = itemTypePrefixes[itemType as keyof typeof itemTypePrefixes];
  if (!prefix) throw new TypeError(`Unknown Responses item type: ${itemType}`);
  return prefix;
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
      .toSorted(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => [key, sortJson(entry)]),
  );
};
