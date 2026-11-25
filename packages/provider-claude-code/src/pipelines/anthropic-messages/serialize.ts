import { defineStage } from './facts.ts';
import { pickClaudeCodeHeaders } from '../../headers.ts';
import { hasHeader, setHeader } from '@floway-dev/http';
import { move, transform } from '@floway-dev/pipeline';

// https://github.com/Wei-Shaw/sub2api/blob/4a5665da5b2c6b83c4597844ea6e573746c821b1/backend/internal/service/gateway_service.go
const ANTHROPIC_MESSAGES_URL = 'https://api.anthropic.com/v1/messages?beta=true';

export const serialize = defineStage({
  name: 'claude-code.serialize',
  through: {
    request: {
      needs: ['request.http', 'request.anthropicMessages', 'request.claudeCodeShaped', 'provider.model'],
      provides: ['request.http'],
      consumes: ['request.claudeCodeShaped'],
    },
    response: { needs: [], provides: [], consumes: [] },
  },
  execute: transform(() => ({
    request: ({ 'request.claudeCodeShaped': shaped, ...facts }) => {
      const request = facts['request.http'];
      const { upstreamModelId: model } = facts['provider.model'];
      let headers = shaped ? request.headers : Object.entries(pickClaudeCodeHeaders(model));
      if (!hasHeader(headers, 'content-type')) headers = setHeader(headers, 'content-type', 'application/json');
      return {
        ...facts,
        'request.http': move({
          ...request,
          method: 'POST',
          url: ANTHROPIC_MESSAGES_URL,
          headers,
          body: JSON.stringify({ ...facts['request.anthropicMessages'], model, stream: true }),
        }),
      };
    },
  })),
});
