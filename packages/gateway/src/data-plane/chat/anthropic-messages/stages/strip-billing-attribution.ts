import type { AnthropicMessagesCandidateRequest } from './facts.ts';
import { defineStage, transform } from '@floway-dev/pipeline';
import type { AnthropicMessagesPayload } from '@floway-dev/protocols/anthropic-messages';

// The per-turn cch hash defeats prompt-cache reuse on API upstreams. The
// subscription endpoint uses it for plan billing and leaves this flag disabled.
// https://platform.claude.com/docs/en/about-claude/api-credits-for-subscribers#what-the-credits-cover
const BILLING_HEADER_LINE_RE = /x-anthropic-billing-header[^\n]*/g;
const CCH_HASH_RE = /cch=[0-9a-f]{5,};?/gi;
// https://github.com/decolua/9router/issues/4739
const CLAUDE_CODE_BETA = 'claude-code-20250219';

const stripText = (text: string): string => text.replace(BILLING_HEADER_LINE_RE, '').replace(CCH_HASH_RE, '').trim();

const stripSystem = (payload: AnthropicMessagesPayload): AnthropicMessagesPayload => {
  const { system: original, ...rest } = payload;
  if (typeof original === 'string') {
    const system = stripText(original);
    return system.length > 0 ? { ...rest, system } : rest;
  }
  if (Array.isArray(original)) {
    const system = original.map(block => ({ ...block, text: stripText(block.text) })).filter(block => block.text.length > 0);
    return system.length > 0 ? { ...rest, system } : rest;
  }
  return payload;
};

type Request = AnthropicMessagesCandidateRequest & { readonly 'request.anthropicBeta': readonly string[] };

export const stripBillingAttribution = defineStage<Request, Request, object, object>({
  name: 'stripBillingAttribution',
  through: {
    request: {
      needs: ['request.anthropicMessages', 'request.anthropicBeta', 'route.candidate'],
      consumes: [],
      provides: ['request.anthropicMessages', 'request.anthropicBeta'],
    },
    response: { needs: [], consumes: [], provides: [] },
  },
  execute: transform(() => ({
    request: facts => {
      if (!facts['route.candidate'].providerModel.enabledFlags.includes('strip-billing-attribution')) return facts;
      return {
        ...facts,
        'request.anthropicMessages': stripSystem(facts['request.anthropicMessages']),
        'request.anthropicBeta': facts['request.anthropicBeta'].filter(beta => beta !== CLAUDE_CODE_BETA),
      };
    },
  })),
});
