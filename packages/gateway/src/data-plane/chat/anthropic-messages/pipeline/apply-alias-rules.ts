import { gatewayFactSpace } from '../../../pipeline/facts.ts';
import { applyRulesToUpstreamAnthropicMessages } from '../../shared/alias-rules.ts';
import { move, transform } from '@floway-dev/pipeline';
import type { AnthropicMessagesPayload } from '@floway-dev/protocols/anthropic-messages';

const { defineStage } = gatewayFactSpace<{}>();
const key = 'request.anthropicMessages';

export const applyAliasRules = defineStage({
  name: 'anthropicMessages.apply-alias-rules',
  through: {
    request: { needs: [key, 'serve.candidate'], provides: [key], consumes: [] },
    response: { needs: [], provides: [], consumes: [] },
  },
  execute: transform(() => ({
    request: facts => {
      const { rules } = facts['serve.candidate'];
      if (rules === undefined) return facts;
      const payload = { ...facts[key] };
      applyRulesToUpstreamAnthropicMessages(payload as AnthropicMessagesPayload, rules);
      return { ...facts, [key]: move(payload) };
    },
  })),
});
