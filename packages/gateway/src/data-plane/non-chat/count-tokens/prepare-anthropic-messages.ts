import { defineStage } from './facts.ts';
import { stripAnthropicMessagesBillingAttribution } from '../../chat/anthropic-messages/pipeline/billing-attribution.ts';
import { normalizeAnthropicMessagesEmptyToolsToolChoice } from '../../chat/anthropic-messages/pipeline/empty-tools-tool-choice.ts';
import { prepareAnthropicMessagesWebSearchShimRequest } from '../../chat/anthropic-messages/pipeline/hosted-tools.ts';
import { disableAnthropicMessagesReasoningOnForcedToolChoice } from '../../chat/anthropic-messages/pipeline/reasoning-tool-choice.ts';
import { applyAnthropicMessagesRoleCompatibility } from '../../chat/anthropic-messages/pipeline/role-compatibility.ts';
import { applyRulesToUpstreamAnthropicMessages } from '../../chat/shared/alias-rules.ts';
import { localHead } from '../shared/http.ts';

export const prepareAnthropicMessagesCountTokens = defineStage({
  name: 'anthropicMessagesCountTokens.prepare',
  through: {
    request: {
      needs: ['http', 'anthropicMessagesCountTokens', 'model', 'aliasRules'],
      provides: ['http', 'anthropicMessagesCountTokens'], consumes: [],
    },
    response: { needs: [], provides: [], consumes: [] },
  },
  return: { provides: ['http', 'anthropicMessagesCountTokens'] },
  async execute(facts, scope) {
    const flags = facts.model.enabledFlags;
    let { http, anthropicMessagesCountTokens: payload } = facts;
    if (flags.includes('anthropic-messages-web-search-shim')) {
      const prepared = prepareAnthropicMessagesWebSearchShimRequest(payload);
      if (prepared.type !== 'ok') {
        return {
          http: localHead(400),
          anthropicMessagesCountTokens: {
            kind: 'error', source: 'local', error: {
              type: 'error', error: { type: 'invalid_request_error', message: prepared.message },
            },
          },
        };
      }
      payload = prepared.payload;
    }
    if (flags.includes('strip-billing-attribution')) ({ payload, http } = stripAnthropicMessagesBillingAttribution(payload, http));
    if (flags.includes('disable-reasoning-on-forced-tool-choice')) payload = disableAnthropicMessagesReasoningOnForcedToolChoice(payload);
    if (flags.includes('empty-tools-tool-choice-none')) payload = normalizeAnthropicMessagesEmptyToolsToolChoice(payload);
    const shaped = applyAnthropicMessagesRoleCompatibility(payload, flags);
    const anthropicMessagesCountTokens = { ...shaped };
    applyRulesToUpstreamAnthropicMessages(anthropicMessagesCountTokens, facts.aliasRules);
    return await scope.next({ ...facts, http, anthropicMessagesCountTokens });
  },
});
