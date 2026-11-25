import { defineStage } from './facts.ts';
import { isClaudeCodeShapedRequest } from '../../detection.ts';
import { getHeaders } from '@floway-dev/http';
import { transform } from '@floway-dev/pipeline';

export const detectClaudeCodeShape = defineStage({
  name: 'claude-code.detect-claude-code-shape',
  through: {
    request: {
      needs: ['request.http', 'request.anthropicMessages', 'provider.model'],
      provides: ['request.claudeCodeShaped'],
      consumes: [],
    },
    response: { needs: [], provides: [], consumes: [] },
  },
  execute: transform(() => ({
    request: facts => ({
      ...facts,
      'request.claudeCodeShaped': isClaudeCodeShapedRequest({
        headers: {
          get(name) {
            const values = getHeaders(facts['request.http'].headers, name).filter(value => typeof value === 'string');
            return values.length === 0 ? null : values.join(', ');
          },
        },
        body: { ...facts['request.anthropicMessages'], model: facts['provider.model'].id },
      }),
    }),
  })),
});
