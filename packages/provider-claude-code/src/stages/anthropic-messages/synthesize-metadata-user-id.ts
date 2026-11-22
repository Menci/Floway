import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { v4 } from 'uuid';

import type { AnthropicMessagesMessage, AnthropicMessagesPayload } from '@floway-dev/protocols/anthropic-messages';

type MessagePayload = Omit<AnthropicMessagesPayload, 'model'>;

// Real Claude Code includes a JSON `metadata.user_id` envelope containing a
// stable per-upstream device id and a session id derived from the first user
// message. These deterministic ids preserve prompt-cache routing without
// leaking the operator's account UUID.
//
// https://github.com/Wei-Shaw/sub2api/blob/4a5665da5b2c6b83c4597844ea6e573746c821b1/backend/internal/service/metadata_userid.go#L15
export const synthesizeMetadataUserIdPayload = <P extends MessagePayload>(
  payload: P,
  upstreamId: string,
): P => {
  const existing = payload.metadata?.user_id;
  if (typeof existing === 'string' && existing.length > 0) return payload;

  const userId = JSON.stringify({
    device_id: deviceIdForUpstream(upstreamId),
    account_uuid: '',
    session_id: sessionIdForPayload(upstreamId, payload),
  });
  return { ...payload, metadata: { ...payload.metadata, user_id: userId } };
};

// Real Claude Code emits a 64-hex device id. See
// https://github.com/Wei-Shaw/sub2api/blob/4a5665da5b2c6b83c4597844ea6e573746c821b1/backend/internal/service/gateway_prompt_test.go#L17
const deviceIdForUpstream = (upstreamId: string): string =>
  sha256Hex(`claude-code-device:${upstreamId}`);

const sessionIdForPayload = (upstreamId: string, payload: Pick<AnthropicMessagesPayload, 'messages'>): string =>
  sha256Uuidv4(`claude-code-session:${upstreamId}${firstUserMessageText(payload.messages)}`);

const firstUserMessageText = (messages: AnthropicMessagesMessage[]): string => {
  for (const message of messages) {
    if (message.role !== 'user') continue;
    if (typeof message.content === 'string') return message.content;
    return message.content
      .map(part => part.type === 'text' ? part.text : '')
      .filter(Boolean)
      .join('\n');
  }
  return '';
};

const sha256Hex = (input: string): string => bytesToHex(sha256(new TextEncoder().encode(input)));

const sha256Uuidv4 = (input: string): string => v4({ random: sha256(new TextEncoder().encode(input)) });
