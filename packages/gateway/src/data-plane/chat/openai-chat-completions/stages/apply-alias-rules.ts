import { applyRulesToUpstreamOpenAIChatCompletions } from '../../shared/alias-rules.ts';
import { rewriteChatRequest } from '../../shared/rewrite-stage.ts';
import type { OpenAIChatCompletionsPayloadEx } from '@floway-dev/protocols/openai-chat-completions';

export const applyAliasRules = rewriteChatRequest(
  'applyAliasRules', 'request.payload', (payload: OpenAIChatCompletionsPayloadEx, candidate) => {
    if (candidate.rules === undefined) return payload;
    const wire = { ...payload };
    applyRulesToUpstreamOpenAIChatCompletions(wire, candidate.rules);
    return wire;
  },
);
