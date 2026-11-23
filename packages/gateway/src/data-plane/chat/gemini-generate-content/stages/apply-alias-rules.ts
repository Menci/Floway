import { applyRulesToUpstreamGeminiGenerateContent } from '../../shared/alias-rules.ts';
import { rewriteChatRequest } from '../../shared/rewrite-stage.ts';
import type { GeminiGenerateContentRequest } from '@floway-dev/protocols/gemini-generate-content';

export const applyAliasRules = rewriteChatRequest(
  'applyAliasRules', 'request.payload', (payload: GeminiGenerateContentRequest, candidate) => {
    if (candidate.rules === undefined) return payload;
    const wire = { ...payload };
    applyRulesToUpstreamGeminiGenerateContent(wire, candidate.rules);
    return wire;
  },
);
