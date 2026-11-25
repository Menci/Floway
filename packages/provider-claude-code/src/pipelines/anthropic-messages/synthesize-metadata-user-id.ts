import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { v4 } from 'uuid';

import { defineStage } from './facts.ts';
import { move, transform } from '@floway-dev/pipeline';
import type { AnthropicMessagesPayload } from '@floway-dev/protocols/anthropic-messages';

export const synthesizeMetadataUserId = defineStage({
  name: 'claude-code.synthesize-metadata-user-id',
  through: {
    request: {
      needs: ['request.anthropicMessages', 'request.claudeCodeShaped', 'provider.upstream'],
      provides: ['request.anthropicMessages'],
      consumes: [],
    },
    response: { needs: [], provides: [], consumes: [] },
  },
  execute: transform(() => ({
    request: facts => facts['request.claudeCodeShaped'] ? facts : {
      ...facts,
      'request.anthropicMessages': move(addMetadataUserId(facts['request.anthropicMessages'], facts['provider.upstream'].id)),
    },
  })),
});

const encoder = new TextEncoder();

// Claude Code uses a 64-hex device_id and a UUID session_id. Salt each
// identifier by upstream and derive the session from the first user turn,
// before synthetic system turns can change it.
// https://github.com/Wei-Shaw/sub2api/blob/4a5665da5b2c6b83c4597844ea6e573746c821b1/backend/internal/service/metadata_userid.go#L15
export const addMetadataUserId = (payload: AnthropicMessagesPayload, upstreamId: string): AnthropicMessagesPayload => {
  const existing = payload.metadata?.user_id;
  if (typeof existing === 'string' && existing.length > 0) return payload;
  const deviceId = bytesToHex(sha256(encoder.encode(`claude-code-device:${upstreamId}`)));
  const sessionId = v4({ random: sha256(encoder.encode(`claude-code-session:${upstreamId}${firstUserMessageText(payload)}`)) });
  const userId = JSON.stringify({ device_id: deviceId, account_uuid: '', session_id: sessionId });
  return { ...payload, metadata: { ...payload.metadata, user_id: userId } };
};

const firstUserMessageText = ({ messages }: AnthropicMessagesPayload): string => {
  for (const { role, content } of messages) {
    if (role !== 'user') continue;
    if (typeof content === 'string') return content;
    return content.flatMap(part => part.type === 'text' && part.text ? [part.text] : []).join('\n');
  }
  return '';
};
