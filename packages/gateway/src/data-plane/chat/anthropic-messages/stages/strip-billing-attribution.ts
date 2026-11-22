import { withoutSystem } from './request.ts';
import type { AnthropicMessagesRequestFacts } from './types.ts';
import type { ChatPipelineServices } from '../../pipeline/index.ts';
import { defineRequestStage } from '@floway-dev/pipeline';
import type { AnthropicMessagesPayload } from '@floway-dev/protocols/anthropic-messages';
import { hasEnabledFlag } from '@floway-dev/provider';

// Claude Code seeds each turn with an `x-anthropic-billing-header` carrying a
// per-turn `cch=` value. Non-Claude-Code upstreams treat the block as ordinary
// prompt text and lose prefix-cache reuse when the value changes.
// https://platform.claude.com/docs/en/about-claude/api-credits-for-subscribers#what-the-credits-cover
const BILLING_HEADER_LINE = /x-anthropic-billing-header[^\n]*/g;
const BILLING_CACHE_HASH = /cch=[0-9a-f]{5,};?/gi;
const CLAUDE_CODE_BETA = 'claude-code-20250219';

const scrubText = (text: string): string =>
  text.replace(BILLING_HEADER_LINE, '').replace(BILLING_CACHE_HASH, '').trim();

const scrubbedSystem = (system: AnthropicMessagesPayload['system']): AnthropicMessagesPayload['system'] => {
  if (system === undefined) return undefined;
  if (typeof system === 'string') {
    const text = scrubText(system);
    return text.length === 0 ? undefined : text;
  }
  const blocks = system.flatMap(block => {
    const text = scrubText(block.text);
    return text.length === 0 ? [] : [{ ...block, text }];
  });
  return blocks.length === 0 ? undefined : blocks;
};

export const stripBillingAttribution = defineRequestStage<
  AnthropicMessagesRequestFacts,
  Pick<AnthropicMessagesRequestFacts, 'request.payload' | 'request.anthropicBeta'>,
  never,
  ChatPipelineServices
>({
  name: 'stripBillingAttribution',
  provides: ['request.payload', 'request.anthropicBeta'],
  execute: async (facts, next) => {
    const candidate = facts['route.candidate'];
    if (!hasEnabledFlag(candidate.providerModel, 'strip-billing-attribution')) {
      return await next({
        'request.payload': facts['request.payload'],
        'request.anthropicBeta': facts['request.anthropicBeta'],
      });
    }

    const payload = facts['request.payload'];
    const system = scrubbedSystem(payload.system);
    const nextPayload = system === payload.system
      ? payload
      : system === undefined
        ? withoutSystem(payload)
        : { ...payload, system };
    const anthropicBeta = facts['request.anthropicBeta'].filter(beta => beta !== CLAUDE_CODE_BETA);
    return await next({
      'request.payload': nextPayload,
      'request.anthropicBeta': anthropicBeta.length === facts['request.anthropicBeta'].length
        ? facts['request.anthropicBeta']
        : anthropicBeta,
    });
  },
});
