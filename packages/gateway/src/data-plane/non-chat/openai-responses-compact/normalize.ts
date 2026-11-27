import { defineStage } from './facts.ts';
import { compactGenerationPayload } from './generation-payload.ts';
import { openAIResponsesUnresolvedNamespaces } from '../../chat/openai-responses/pipeline/function-call-namespace.ts';
import { rewriteOpenAIResponsesRoles } from '../../chat/openai-responses/pipeline/role-compatibility.ts';
import { toCompactPayloadShape } from '@floway-dev/protocols/openai-responses';

export const normalizeOpenAIResponsesCompactRequest = defineStage({
  name: 'openaiResponsesCompact.normalize-request',
  through: {
    request: { needs: ['openaiResponsesCompact', 'model', 'aliasRules'], provides: ['openaiResponsesCompact'], consumes: [] },
    response: { needs: [], provides: [], consumes: [] },
  },
  async execute(facts, scope) {
    const { model, aliasRules, openaiResponsesCompact: payload } = facts;
    const flags = model.enabledFlags;
    const withNamespaces = flags.includes('openai-responses-null-unresolved-function-call-namespace')
      ? openAIResponsesUnresolvedNamespaces(compactGenerationPayload(payload)) : payload.input;
    const request = {
      ...toCompactPayloadShape(payload),
      model: payload.model,
      input: rewriteOpenAIResponsesRoles(withNamespaces, flags),
      ...(aliasRules.serviceTier === undefined ? {} : { service_tier: aliasRules.serviceTier }),
    };
    if (flags.includes('strip-prompt-cache-key')) delete request.prompt_cache_key;
    return await scope.next({ ...facts, openaiResponsesCompact: request });
  },
});
