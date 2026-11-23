import { applyRulesToUpstreamOpenAIResponses } from '../../shared/alias-rules.ts';
import type { ChatEgressInput } from '../../shared/route-body.ts';
import { defineStage } from '@floway-dev/pipeline';
import type { CanonicalOpenAIResponsesPayload } from '@floway-dev/protocols/openai-responses';

type Request = Omit<ChatEgressInput<'openaiResponses'>, 'request.payload'> & {
  readonly 'request.payload': CanonicalOpenAIResponsesPayload;
};

export const applyAliasRules = defineStage<Request, Request, object, object>({
  name: 'applyAliasRules',
  through: {
    request: { needs: ['request.payload', 'route.candidate'], consumes: [], provides: ['request.payload'] },
    response: { needs: [], consumes: [], provides: [] },
  },
  execute: async (facts, next) => {
    const rules = facts['route.candidate'].rules;
    if (rules === undefined) return await next(facts);
    const payload = { ...facts['request.payload'] };
    applyRulesToUpstreamOpenAIResponses(payload, rules);
    return await next({ ...facts, 'request.payload': payload });
  },
});
