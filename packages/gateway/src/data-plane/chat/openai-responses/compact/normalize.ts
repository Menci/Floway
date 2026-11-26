import { openAIResponsesUnresolvedNamespaces } from '../function-call-namespace.ts';
import { defineOpenAIResponsesStage } from '../pipeline-facts.ts';
import { rewriteOpenAIResponsesRoles } from '../role-compatibility.ts';
import { toCompactPayloadShape } from '@floway-dev/protocols/openai-responses';

export const normalizeOpenAIResponsesCompact = defineOpenAIResponsesStage({
  name: 'openaiResponsesCompact.normalize',
  through: {
    request: {
      needs: ['request.openaiResponsesCompact', 'provider.model', 'request.aliasRules?'],
      provides: ['request.openaiResponsesCompact'],
      consumes: [],
    },
    response: { needs: [], provides: [], consumes: [] },
  },
  async execute(facts, scope) {
    const payload = facts['request.openaiResponsesCompact'];
    const flags = facts['provider.model'].enabledFlags;
    const withNamespaces = flags.includes('openai-responses-null-unresolved-function-call-namespace')
      ? openAIResponsesUnresolvedNamespaces(payload) : payload.input;
    const input = rewriteOpenAIResponsesRoles(withNamespaces, flags);
    const serviceTier = facts['request.aliasRules']?.serviceTier;
    const request = {
      ...toCompactPayloadShape(payload),
      model: payload.model,
      input,
      ...(serviceTier === undefined ? {} : { service_tier: serviceTier }),
    };
    if (flags.includes('strip-prompt-cache-key')) {
      const { prompt_cache_key: _cacheKey, ...withoutCacheKey } = request;
      return await scope.next({ ...facts, 'request.openaiResponsesCompact': withoutCacheKey });
    }
    return await scope.next({ ...facts, 'request.openaiResponsesCompact': request });
  },
});
