import { defineStage } from './facts.ts';
import { IDENTITY_BLOCK } from './system-blocks.ts';

export const injectIdentityBlock = defineStage({
  name: 'claude-code.anthropic-messages.inject-identity-block',
  through: {
    request: { needs: ['anthropicMessages', 'claudeCode.shaped'], provides: ['anthropicMessages'], consumes: [] },
    response: { needs: [], provides: [], consumes: [] },
  },
  async execute(facts, scope) {
    if (facts['claudeCode.shaped']) return await scope.next(facts);
    const payload = facts.anthropicMessages;
    if (!Array.isArray(payload.system)) throw new TypeError('Claude Code identity requires a system block array');
    return await scope.next({ ...facts, anthropicMessages: { ...payload, system: [...payload.system, IDENTITY_BLOCK] } });
  },
});
