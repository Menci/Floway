import { wrapOpenAIChatCompletionsAffinityEgress } from './affinity/egress.ts';
import { analyzeOpenAIChatCompletionsAffinity } from './affinity/ingress.ts';
import { collectOpenAIChatCompletions, collectOpenAIChatCompletionsStreamError, encodeOpenAIChatCompletions } from './encode.ts';
import { openAIChatCompletionsLocalError } from './errors.ts';
import { parseOpenAIChatCompletions, type OpenAIChatCompletionsDelivery } from './parse.ts';
import { applyRoleCompatibility } from './stages/apply-role-compatibility.ts';
import { disableReasoningOnForcedToolChoice } from './stages/disable-reasoning-on-forced-tool-choice.ts';
import { includeUsageStreamOptions } from './stages/include-usage-stream-options.ts';
import { normalizeEmptyToolsToolChoice } from './stages/normalize-empty-tools-tool-choice.ts';
import { normalizeExclusiveCachedTokens } from './stages/normalize-exclusive-cached-tokens.ts';
import { normalizeUsage } from './stages/normalize-usage.ts';
import { stripPromptCacheKey } from './stages/strip-prompt-cache-key.ts';
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
  body: [includeUsageStreamOptions, disableReasoningOnForcedToolChoice, normalizeEmptyToolsToolChoice, stripPromptCacheKey, normalizeUsage],
  egress: [applyRoleCompatibility, applyAliasRules, normalizeExclusiveCachedTokens],
  collect: collectOpenAIChatCompletions,
  streamError: collectOpenAIChatCompletionsStreamError,
  // The usage-only tail carries the complete request totals before [DONE].
  // https://github.com/openai/openai-node/blob/b579bcb3e586d22269ffe6fe504653a0e05acbe8/src/resources/chat/completions/completions.ts#L2155-L2162
  usage: chatTokenUsage(() => billableUsageFromOpenAIChatCompletionsEvent, event => event.usage != null && event.choices.length === 0),
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
