import { defineStage } from './facts.ts';
import { buildBillingBlock, computeCcVersionFingerprint } from './system-blocks.ts';
import { CLAUDE_CLI_VERSION } from '../../headers.ts';
import { move, transform } from '@floway-dev/pipeline';
import type { AnthropicMessagesPayload } from '@floway-dev/protocols/anthropic-messages';

export const injectBillingBlock = defineStage({
  name: 'claude-code.inject-billing-block',
  through: {
    request: {
      needs: ['request.anthropicMessages', 'request.claudeCodeShaped'],
      provides: ['request.anthropicMessages'],
      consumes: [],
    },
    response: { needs: [], provides: [], consumes: [] },
  },
  execute: transform(() => ({
    request: facts => facts['request.claudeCodeShaped'] ? facts : {
      ...facts,
      'request.anthropicMessages': move(addBillingBlock(facts['request.anthropicMessages'])),
    },
  })),
});

// The fingerprint sees the post-hoist messages that Anthropic will receive.
export const addBillingBlock = (payload: AnthropicMessagesPayload): AnthropicMessagesPayload => {
  const fingerprint = computeCcVersionFingerprint(CLAUDE_CLI_VERSION, payload);
  return { ...payload, system: [buildBillingBlock(CLAUDE_CLI_VERSION, fingerprint)] };
};
