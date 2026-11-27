import { defineStage } from './facts.ts';
import { isClaudeCodeShapedRequest } from '../../detection.ts';

export const detectShape = defineStage({
  name: 'claude-code.anthropic-messages.detect-shape',
  through: {
    request: { needs: ['http', 'anthropicMessages', 'model'], provides: ['claudeCode.shaped'], consumes: [] },
    response: { needs: [], provides: [], consumes: [] },
  },
  async execute(facts, scope) {
    const headers = new Headers();
    for (const [name, value] of facts.http.headers) {
      if (typeof value !== 'string') throw new TypeError(`Claude Code fingerprint requires a plain ${name} header`);
      headers.append(name, value);
    }
    const shaped = isClaudeCodeShapedRequest({
      headers,
      body: { ...facts.anthropicMessages, model: facts.model.id },
    });
    return await scope.next({ ...facts, 'claudeCode.shaped': shaped });
  },
});
