import { defineStage } from './facts.ts';
import { isClaudeCodeShapedRequest } from '../../detection.ts';

export const detectShape = defineStage({
  name: 'claude-code.anthropic-messages.detect-shape',
  through: {
    request: { needs: ['request.http', 'request.anthropicMessages', 'provider.model'], provides: ['request.claudeCodeShaped'], consumes: [] },
    response: { needs: [], provides: [], consumes: [] },
  },
  async execute(facts, scope) {
    const headers = new Headers();
    for (const [name, value] of facts['request.http'].headers) {
      if (typeof value !== 'string') throw new TypeError(`Claude Code fingerprint header ${name} must be a string`);
      headers.append(name, value);
    }
    const body = { ...facts['request.anthropicMessages'], model: facts['provider.model'].id };
    return await scope.next({ ...facts, 'request.claudeCodeShaped': isClaudeCodeShapedRequest({ headers, body }) });
  },
});
