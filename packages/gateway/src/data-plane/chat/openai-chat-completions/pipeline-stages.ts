import { wrapOpenAIChatCompletionsAffinityEgress } from './affinity/egress.ts';
import { analyzeOpenAIChatCompletionsAffinity } from './affinity/ingress.ts';
import { collectOpenAIChatCompletions, collectOpenAIChatCompletionsStreamError, encodeOpenAIChatCompletions } from './encode.ts';
import { openAIChatCompletionsLocalError } from './errors.ts';
import { applyRoleCompatibility } from './interceptors/apply-role-compatibility.ts';
import { disableReasoningOnForcedToolChoice } from './interceptors/disable-reasoning-on-forced-tool-choice.ts';
import { includeUsageStreamOptions } from './interceptors/include-usage-stream-options.ts';
import { normalizeEmptyToolsToolChoice } from './interceptors/normalize-empty-tools-tool-choice.ts';
import { normalizeExclusiveCachedTokens } from './interceptors/normalize-exclusive-cached-tokens.ts';
import { normalizeUsage } from './interceptors/normalize-usage.ts';
import { stripPromptCacheKey } from './interceptors/strip-prompt-cache-key.ts';
import { parseOpenAIChatCompletions, type OpenAIChatCompletionsDelivery } from './parse.ts';
import { billableUsageFromOpenAIChatCompletionsEvent } from './usage.ts';
import { defineStage } from '../../pipeline/facts.ts';
import { appendFailedUpstreams } from '../../shared/failed-upstreams.ts';
import { applyRulesToUpstreamOpenAIChatCompletions } from '../shared/alias-rules.ts';
import type { ChatProtocolStages } from '../shared/pipeline.ts';
import { chatTokenUsage } from '../shared/usage.ts';

const applyAliasRules = defineStage({
  name: 'openaiChatCompletions.apply-alias-rules',
  through: {
    request: { needs: ['request.openaiChatCompletions', 'request.aliasRules?'], provides: ['request.openaiChatCompletions'], consumes: [] },
    response: { needs: [], provides: [], consumes: [] },
  },
  async execute(facts, scope) {
    const rules = facts['request.aliasRules'];
    if (rules === undefined) return await scope.next(facts);
    const payload = { ...facts['request.openaiChatCompletions'] };
    applyRulesToUpstreamOpenAIChatCompletions(payload, rules);
    return await scope.next({ ...facts, 'request.openaiChatCompletions': payload });
  },
});

export const openAIChatCompletionsChat: ChatProtocolStages<'openaiChatCompletions', OpenAIChatCompletionsDelivery> = {
  parse: parseOpenAIChatCompletions,
  encode: encodeOpenAIChatCompletions,
  body: [includeUsageStreamOptions, disableReasoningOnForcedToolChoice, normalizeEmptyToolsToolChoice, stripPromptCacheKey],
  egress: [applyRoleCompatibility, applyAliasRules, normalizeUsage, normalizeExclusiveCachedTokens],
  collect: collectOpenAIChatCompletions,
  streamError: collectOpenAIChatCompletionsStreamError,
  usage: chatTokenUsage(() => billableUsageFromOpenAIChatCompletionsEvent),
  model: payload => payload.model,
  unavailable({ model, exists, failedUpstreams }) {
    const message = exists
      ? `Model ${model} does not support the /chat/completions endpoint.`
      : `Model ${model} is not available on any configured upstream.`;
    return openAIChatCompletionsLocalError(exists ? 400 : 404, appendFailedUpstreams(message, failedUpstreams));
  },
  affinityUnavailable: message => openAIChatCompletionsLocalError(400, message, { param: 'input', code: 'responses_item_routing_unavailable' }),
  invalidTranslation: error => openAIChatCompletionsLocalError(400, error.message, { param: error.param ?? 'messages', code: null }),
  analyzeAffinity: analyzeOpenAIChatCompletionsAffinity,
  affinityEgress: wrapOpenAIChatCompletionsAffinityEgress,
};
