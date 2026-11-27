import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { v4 } from 'uuid';

import { defineStage } from './facts.ts';
import type { AnthropicMessagesMessage, AnthropicMessagesPayload } from '@floway-dev/protocols/anthropic-messages';

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

// Derive the session from the first original user turn, before hoisting the
// system prompt, to keep cached conversation prefixes on the same session.
// Personal accounts can send an empty account UUID without exposing operator identity.
// https://github.com/Wei-Shaw/sub2api/blob/4a5665da5b2c6b83c4597844ea6e573746c821b1/backend/internal/service/metadata_userid.go#L15
const withMetadataUserId = (payload: AnthropicMessagesPayload, upstreamId: string): AnthropicMessagesPayload => {
  const existing = payload.metadata?.user_id;
  if (typeof existing === 'string' && existing.length > 0) return payload;

  const encoder = new TextEncoder();
  const firstUser = firstUserMessageText(payload.messages);
  const deviceId = bytesToHex(sha256(encoder.encode(`claude-code-device:${upstreamId}`)));
  const sessionId = v4({ random: sha256(encoder.encode(`claude-code-session:${upstreamId}${firstUser}`)) });
  const userId = JSON.stringify({ device_id: deviceId, account_uuid: '', session_id: sessionId });
  return { ...payload, metadata: { ...payload.metadata, user_id: userId } };
};

export const synthesizeMetadataUserId = defineStage({
  name: 'claude-code.anthropic-messages.synthesize-metadata-user-id',
  through: {
    request: { needs: ['anthropicMessages', 'claudeCode.shaped', 'upstream'], provides: ['anthropicMessages'], consumes: [] },
    response: { needs: [], provides: [], consumes: [] },
  },
  async execute(facts, scope) {
    if (facts['claudeCode.shaped']) return await scope.next(facts);
    return await scope.next({ ...facts, anthropicMessages: withMetadataUserId(facts.anthropicMessages, facts.upstream.id) });
  },
});
