import type { Chat } from '../facts.ts';
import { withoutKeys } from '../shared/structural.ts';
import { defineStage, transform, move } from '@floway-dev/pipeline';
import type { AnthropicMessagesPayload } from '@floway-dev/protocols/anthropic-messages';

/**
 * Scrubs Claude Code's billing-attribution block out of the system prompt.
 *
 * The block leads every Claude Code turn as `system[0]`:
 * `x-anthropic-billing-header: cc_version=<version>.<fingerprint>; cc_entrypoint=<entrypoint>;`
 * with optional `cch=`, `cc_workload=` and `cc_prev_req=` segments after it. Two of those parts
 * vary per call — the version's trailing fingerprint is derived from the first user message,
 * and `cch=` was a per-request nonce on builds through 2.1.177 — so an upstream reading the
 * block as ordinary prompt text sees a different prompt every turn and reuses nothing. One
 * report measured stripping the line as taking the prefix cache from 0% to ~99.7%.
 * https://github.com/anthropics/claude-code/issues/68900
 * https://github.com/anthropics/claude-code/issues/50085
 *
 * Anthropic's own endpoint wants it intact, which is what the flag is for: it is on for the
 * upstreams that treat the block as text and off for the one that reads it. What that endpoint
 * does with it is not documented anywhere primary — the observable part is that the CLI adds
 * *more* of these fields on its first-party path, so it reads as a client-attribution signal.
 */
export const stripBillingAttributionFromAnthropicMessages = defineStage<
  Chat<'request.chat.anthropicMessages' | 'route.attempt'>,
  Chat<'request.chat.anthropicMessages'>,
  Chat<'response.chat.anthropicMessages'>,
  Chat<'response.chat.anthropicMessages'>
>({
  name: 'stripBillingAttribution',
  through: {
    request: {
      needs: ['request.chat.anthropicMessages', 'route.attempt'],
      consumes: [],
      provides: ['request.chat.anthropicMessages'],
    },
    response: { needs: ['response.chat.anthropicMessages'], consumes: [], provides: [] },
  },
  execute: transform<
    Chat<'request.chat.anthropicMessages' | 'route.attempt'>,
    Chat<'request.chat.anthropicMessages'>,
    Chat<'response.chat.anthropicMessages'>,
    Chat<'response.chat.anthropicMessages'>
  >(() => ({
    request: facts => {
      if (!facts['route.attempt'].flags.includes('strip-billing-attribution')) return facts;
      const payload = facts['request.chat.anthropicMessages'];
      const system = scrubbedSystemPrompt(payload.system);
      if (system === payload.system) return facts;
      const withoutSystem = withoutKeys(payload, ['system']);
      return {
        ...facts,
        'request.chat.anthropicMessages': move(system === undefined ? withoutSystem : { ...withoutSystem, system }),
      };
    },
  })),
});

const BILLING_HEADER_LINE = /x-anthropic-billing-header[^\n]*/g;

// Swept separately from the line because a `cch=` also reaches the prompt replayed inside
// message content, where the line pattern cannot see it. Every value captured in the wild is
// five hex digits with a trailing semicolon.
// https://github.com/anthropics/claude-code/issues/40652
const BILLING_CACHE_HASH = /cch=[0-9a-f]{5,};?/gi;

const scrubText = (text: string): string =>
  text.replace(BILLING_HEADER_LINE, '').replace(BILLING_CACHE_HASH, '').trim();

/** What is left of the system prompt once the block is out of it: the value that came in when
 *  there was nothing to scrub, and `undefined` when nothing at all is left — an empty system
 *  prompt is not a system prompt, so the field goes rather than riding on empty. */
const scrubbedSystemPrompt = (system: AnthropicMessagesPayload['system']): AnthropicMessagesPayload['system'] => {
  if (system === undefined) return undefined;
  if (typeof system === 'string') {
    const scrubbed = scrubText(system);
    if (scrubbed.length === 0) return undefined;
    return scrubbed === system ? system : scrubbed;
  }
  let changed = false;
  const blocks = system.flatMap(block => {
    const text = scrubText(block.text);
    if (text.length === 0) { changed = true; return []; }
    if (text === block.text) return [block];
    changed = true;
    return [{ ...block, text }];
  });
  if (!changed) return system;
  return blocks.length > 0 ? blocks : undefined;
};
