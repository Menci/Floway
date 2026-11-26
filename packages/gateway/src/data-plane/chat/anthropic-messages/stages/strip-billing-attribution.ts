import { defineStage } from '../../../pipeline/facts.ts';
import { deleteHeader, getHeaders, setHeader, type HttpHeaders } from '@floway-dev/http';
import { parseAnthropicBetaHeader, type AnthropicMessagesPayload } from '@floway-dev/protocols/anthropic-messages';

// Claude Code clients seed every Anthropic Messages request with an
// `x-anthropic-billing-header: …` line carrying a per-turn `cch=<hash>` value,
// and with the `claude-code-20250219` `anthropic-beta` flag. Two upstreams
// want opposite things from those markers:
//
//   - The Claude Code subscription endpoint (provider kind `claude-code`)
//     reads them to bill the request against the user's plan tier. If
//     we strip them, the request silently falls off plan billing.
//   - Every other upstream (copilot, azure, custom) bills the request as
//     ordinary API traffic. The system-prompt block is ordinary prompt text
//     there: the `cch=` hash flips per call, so the upstream's prompt-cache
//     layer sees a "different" prompt every turn and never reuses its cache,
//     even when the real conversation prefix hasn't changed. On the official
//     Anthropic API with an API key, the markers also classify the request
//     as Claude Code usage, which the monthly API credits bundled with
//     Max/Team plans do not cover, so a credits-only organization answers
//     "Your credit balance is too low" although the same request without
//     the markers succeeds.
//     https://platform.claude.com/docs/en/about-claude/api-credits-for-subscribers#what-the-credits-cover
//
// Gating is owned by the `strip-billing-attribution` flag in the provider
// flag catalog; defaults are wired there per kind.
const BILLING_HEADER_LINE_RE = /x-anthropic-billing-header[^\n]*/g;
const CCH_HASH_RE = /cch=[0-9a-f]{5,};?/gi;
// https://github.com/decolua/9router/issues/4739
const CLAUDE_CODE_BETA = 'claude-code-20250219';

const stripText = (text: string): string => text.replace(BILLING_HEADER_LINE_RE, '').replace(CCH_HASH_RE, '').trim();

export const stripAnthropicMessagesBillingAttribution = <Payload extends Pick<AnthropicMessagesPayload, 'system'>>(payload: Payload): Payload => {
  const { system } = payload;
  if (system === undefined) return payload;
  const stripped = typeof system === 'string'
    ? stripText(system)
    : system.map(block => ({ ...block, text: stripText(block.text) })).filter(block => block.text.length > 0);
  const shaped = { ...payload };
  if (stripped.length > 0) shaped.system = stripped;
  else delete shaped.system;
  return shaped;
};

export const normalizeAnthropicMessagesBeta = (headers: HttpHeaders, stripBillingAttribution: boolean, native = true): HttpHeaders => {
  if (!native) return deleteHeader(headers, 'anthropic-beta');
  const betas = getHeaders(headers, 'anthropic-beta').flatMap(value => {
    if (typeof value !== 'string') throw new TypeError('Expected an ordinary Anthropic beta header');
    return parseAnthropicBetaHeader(value);
  }).filter(beta => !stripBillingAttribution || beta !== CLAUDE_CODE_BETA);
  return betas.length ? setHeader(headers, 'anthropic-beta', betas.join(',')) : deleteHeader(headers, 'anthropic-beta');
};

export const stripBillingAttribution = defineStage({
  name: 'anthropicMessages.strip-billing-attribution',
  through: {
    request: { needs: ['request.http', 'request.anthropicMessages', 'provider.model'], provides: ['request.http', 'request.anthropicMessages'], consumes: [] },
    response: { needs: [], provides: [], consumes: [] },
  },
  async execute(facts, scope) {
    const request = facts['request.http'];
    const model = facts['provider.model'];
    const strip = model.enabledFlags.includes('strip-billing-attribution');
    const payload = facts['request.anthropicMessages'];
    return await scope.next({
      ...facts,
      'request.http': { ...request, headers: normalizeAnthropicMessagesBeta(request.headers, strip, model.endpoints.anthropicMessages !== undefined) },
      'request.anthropicMessages': strip ? stripAnthropicMessagesBillingAttribution(payload) : payload,
    });
  },
});
