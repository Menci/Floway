import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

import type { ClaudeCodeMessagesBoundaryCtx } from './types.ts';
import type { MessagesMessage, MessagesPayload } from '@floway-dev/protocols/messages';

// Real CC includes `metadata.user_id` on every /v1/messages request: a JSON
// envelope `{device_id, account_uuid, session_id}` (v2.1.78+) or the legacy
// underscore-delimited string (pre-2.1.78). Anthropic's detector treats a
// missing user_id as one of several CC-shape failures, and even a third-
// party id seeds the same plan-billing routing key the CLI uses — so we
// always populate it on the re-mimicry path.
//
// Deterministic ids: device_id is per-upstream stable (one CC "device" per
// upstream record), session_id is per-payload (so a multi-turn conversation
// re-uses the same session_id when the prefix repeats — the property
// prompt-cache routing relies on). Stability comes from sha256 over
// (upstream id + nonce / payload prefix); randomness would defeat the
// upstream's cache and burn rate-limit slots faster.
//
// account_uuid is the empty string by convention — real CC uses the empty
// string for personal accounts and a real UUID for org members; sub2api
// observed the upstream accepts an empty string regardless. We always
// emit empty rather than leaking the operator's actual account uuid into
// per-request mimicry.
//
// References:
//   - https://github.com/Wei-Shaw/sub2api/blob/4a5665da5b2c6b83c4597844ea6e573746c821b1/backend/internal/service/metadata_userid.go#L15

export const synthesizeMetadataUserId = async <TResult>(
  ctx: ClaudeCodeMessagesBoundaryCtx,
  _request: object,
  run: () => Promise<TResult>,
): Promise<TResult> => {
  const existing = ctx.payload.metadata?.user_id;
  if (typeof existing === 'string' && existing.length > 0) return await run();

  const deviceId = deviceIdForUpstream(ctx.upstreamId);
  const sessionId = sessionIdForPayload(ctx.upstreamId, ctx.payload);
  const userId = JSON.stringify({ device_id: deviceId, account_uuid: '', session_id: sessionId });

  ctx.payload = { ...ctx.payload, metadata: { ...ctx.payload.metadata, user_id: userId } };
  return await run();
};

// 64-hex (32-byte) device_id, matching the format real CC emits. See
// https://github.com/Wei-Shaw/sub2api/blob/4a5665da5b2c6b83c4597844ea6e573746c821b1/backend/internal/service/gateway_prompt_test.go#L17
const deviceIdForUpstream = (upstreamId: string): string =>
  sha256Hex(`claude-code-device:${upstreamId}`);

// Session id derives from the upstream id plus the first user message text,
// so multi-turn conversations of the same conversation prefix re-use the
// same session id (good for prompt cache) but different conversations get
// different ids. Mirrors the strategy the Codex provider uses for its own
// session-id derivation, with a per-upstream salt so two upstreams running
// the same script don't collide.
const sessionIdForPayload = (upstreamId: string, payload: Pick<MessagesPayload, 'messages'>): string => {
  const firstUser = firstUserMessageText(payload.messages);
  return sha256Uuidv4(`claude-code-session:${upstreamId}${firstUser}`);
};

const firstUserMessageText = (messages: MessagesMessage[]): string => {
  for (const msg of messages) {
    if (msg.role !== 'user') continue;
    if (typeof msg.content === 'string') return msg.content;
    return msg.content
      .map(part => part.type === 'text' ? part.text : '')
      .filter(Boolean)
      .join('\n');
  }
  return '';
};

const sha256Hex = (input: string): string => bytesToHex(sha256(new TextEncoder().encode(input)));

// Same UUIDv4 stamping trick `sha256Uuid` in provider-codex/ids.ts uses:
// stamp the sha256 hex with the version-4 nibble inline and overwrite the
// variant nibble so the output validates as a real UUIDv4.
const sha256Uuidv4 = (input: string): string => {
  const hex = sha256Hex(input);
  const variantNibble = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variantNibble}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};
