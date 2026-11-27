import { defineStage } from './facts.ts';
import { buildBillingBlock, computeCcVersionFingerprint } from './system-blocks.ts';
import { CLAUDE_CLI_VERSION } from '../../headers.ts';

export const injectBillingBlock = defineStage({
  name: 'claude-code.anthropic-messages.inject-billing-block',
  through: {
    request: { needs: ['anthropicMessages', 'claudeCode.shaped'], provides: ['anthropicMessages'], consumes: [] },
    response: { needs: [], provides: [], consumes: [] },
  },
  async execute(facts, scope) {
    if (facts['claudeCode.shaped']) return await scope.next(facts);
    const payload = facts.anthropicMessages;
    // The fingerprint must reflect the post-hoist messages Anthropic receives.
    const fingerprint = computeCcVersionFingerprint(CLAUDE_CLI_VERSION, payload);
    const system = [buildBillingBlock(CLAUDE_CLI_VERSION, fingerprint)];
    return await scope.next({ ...facts, anthropicMessages: { ...payload, system } });
  },
});
