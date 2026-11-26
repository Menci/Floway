import { wrapAnthropicMessagesAffinityEgress } from './affinity/egress.ts';
import { analyzeAnthropicMessagesAffinity } from './affinity/ingress.ts';
import { collectAnthropicMessages, collectAnthropicMessagesStreamError, encodeAnthropicMessages } from './encode.ts';
import { anthropicMessagesLocalError } from './errors.ts';
import { parseAnthropicMessages, type AnthropicMessagesDelivery } from './parse.ts';
import { serializeAnthropicMessagesItems } from './serialize-stream-items.ts';
import { answerClaudeCodeProbe } from './stages/answer-claude-code-probe.ts';
import { applyRoleCompatibility } from './stages/apply-role-compatibility.ts';
import { disableReasoningOnForcedToolChoice } from './stages/disable-reasoning-on-forced-tool-choice.ts';
import { normalizeEmptyToolsToolChoice } from './stages/normalize-empty-tools-tool-choice.ts';
import { stripBillingAttribution } from './stages/strip-billing-attribution.ts';
import { anthropicMessagesWebSearch } from './stages/web-search-shim.ts';
import { createAnthropicMessagesBillableUsageReader } from './usage.ts';
import { defineStage } from '../../pipeline/facts.ts';
import { appendFailedUpstreams } from '../../shared/failed-upstreams.ts';
import { applyRulesToUpstreamAnthropicMessages } from '../shared/alias-rules.ts';
import { inputErrorFields } from '../shared/errors.ts';
import type { ChatProtocolStages } from '../shared/pipeline.ts';
import { chatTokenUsage } from '../shared/usage.ts';

const applyAliasRules = defineStage({
  name: 'anthropicMessages.apply-alias-rules',
  through: {
    request: { needs: ['request.anthropicMessages', 'request.aliasRules?'], provides: ['request.anthropicMessages'], consumes: [] },
    response: { needs: [], provides: [], consumes: [] },
  },
  async execute(facts, scope) {
    const rules = facts['request.aliasRules'];
    if (rules === undefined) return await scope.next(facts);
    const payload = { ...facts['request.anthropicMessages'] };
    applyRulesToUpstreamAnthropicMessages(payload, rules);
    return await scope.next({ ...facts, 'request.anthropicMessages': payload });
  },
});

export const anthropicMessagesChat: ChatProtocolStages<'anthropicMessages', AnthropicMessagesDelivery> = {
  parse: parseAnthropicMessages,
  encode: encodeAnthropicMessages,
  clientEgress: [serializeAnthropicMessagesItems],
  body: [answerClaudeCodeProbe, anthropicMessagesWebSearch, stripBillingAttribution, disableReasoningOnForcedToolChoice, normalizeEmptyToolsToolChoice],
  egress: [applyRoleCompatibility, applyAliasRules],
  collect: collectAnthropicMessages,
  streamError: collectAnthropicMessagesStreamError,
  usage: chatTokenUsage(createAnthropicMessagesBillableUsageReader, event => event.type === 'message_delta' && event.usage !== undefined),
  model: payload => payload.model,
  unavailable({ model, exists, failedUpstreams }) {
    const message = exists
      ? `Model ${model} does not support the /messages endpoint.`
      : `Model ${model} is not available on any configured upstream.`;
    return anthropicMessagesLocalError(exists ? 400 : 404, exists ? 'invalid_request_error' : 'not_found_error', appendFailedUpstreams(message, failedUpstreams));
  },
  affinityUnavailable: message => anthropicMessagesLocalError(400, 'invalid_request_error', message),
  invalidTranslation: error => anthropicMessagesLocalError(400, 'invalid_request_error', error.message, inputErrorFields(error)),
  analyzeAffinity: analyzeAnthropicMessagesAffinity,
  affinityEgress: wrapAnthropicMessagesAffinityEgress,
};
