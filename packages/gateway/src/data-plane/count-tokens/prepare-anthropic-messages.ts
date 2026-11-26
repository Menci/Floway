import { applyAnthropicMessagesRoleCompatibility } from '../chat/anthropic-messages/interceptors/apply-role-compatibility.ts';
import { disableAnthropicMessagesReasoningOnForcedToolChoice } from '../chat/anthropic-messages/interceptors/disable-reasoning-on-forced-tool-choice.ts';
import { normalizeAnthropicMessagesEmptyToolsToolChoice } from '../chat/anthropic-messages/interceptors/normalize-empty-tools-tool-choice.ts';
import { normalizeAnthropicMessagesBeta, stripAnthropicMessagesBillingAttribution } from '../chat/anthropic-messages/interceptors/strip-billing-attribution.ts';
import { anthropicMessagesWebSearchInvalidRequestBody, prepareAnthropicMessagesWebSearchShimRequest } from '../chat/anthropic-messages/interceptors/web-search-shim.ts';
import { applyRulesToUpstreamAnthropicMessages } from '../chat/shared/alias-rules.ts';
import { localResponseHead } from '../pipeline/encode.ts';
import { defineStage } from '../pipeline/facts.ts';

export const prepareAnthropicMessagesCountTokens = defineStage({
  name: 'anthropicMessagesCountTokens.prepare',
  through: {
    request: {
      needs: ['request.http', 'request.anthropicMessagesCountTokens', 'provider.model', 'request.aliasRules?'],
      provides: ['request.http', 'request.anthropicMessagesCountTokens'],
      consumes: [],
    },
    response: { needs: [], provides: [], consumes: [] },
  },
  return: { provides: ['response.http', 'response.anthropicMessagesCountTokens'] },
  async execute(facts, scope) {
    const request = facts['request.http'];
    const model = facts['provider.model'];
    const flags = model.enabledFlags;
    let payload = facts['request.anthropicMessagesCountTokens'];
    if (flags.includes('anthropic-messages-web-search-shim')) {
      const prepared = prepareAnthropicMessagesWebSearchShimRequest(payload);
      if (prepared.type !== 'ok') {
        return {
          'response.http': { ...localResponseHead(400), body: null },
          'response.anthropicMessagesCountTokens': {
            kind: 'error',
            source: 'local',
            error: anthropicMessagesWebSearchInvalidRequestBody(prepared.message),
          },
        };
      }
      payload = prepared.payload;
    }

    const stripBilling = flags.includes('strip-billing-attribution');
    if (stripBilling) payload = stripAnthropicMessagesBillingAttribution(payload);
    if (flags.includes('disable-reasoning-on-forced-tool-choice')) payload = disableAnthropicMessagesReasoningOnForcedToolChoice(payload);
    if (flags.includes('empty-tools-tool-choice-none')) payload = normalizeAnthropicMessagesEmptyToolsToolChoice(payload);
    payload = applyAnthropicMessagesRoleCompatibility(payload, flags);
    const rules = facts['request.aliasRules'];
    if (rules !== undefined) {
      payload = { ...payload };
      applyRulesToUpstreamAnthropicMessages(payload, rules);
    }

    return await scope.next({
      ...facts,
      'request.http': { ...request, headers: normalizeAnthropicMessagesBeta(request.headers, stripBilling) },
      'request.anthropicMessagesCountTokens': payload,
    });
  },
});
