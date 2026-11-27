import { defineStage } from '../../pipeline/facts.ts';
import type { HttpRequestFact } from '@floway-dev/http';
import type { AnthropicMessagesPayload } from '@floway-dev/protocols/anthropic-messages';

// Claude Code's rotating billing hash defeats prompt-cache reuse elsewhere.
// https://platform.claude.com/docs/en/about-claude/api-credits-for-subscribers#what-the-credits-cover
const stripText = (text: string): string => text.replace(/x-anthropic-billing-header[^\n]*/g, '').replace(/cch=[0-9a-f]{5,};?/gi, '').trim();

// https://github.com/decolua/9router/issues/4739
const claudeCodeBeta = 'claude-code-20250219';

export const stripAnthropicMessagesBillingAttribution = <Payload extends Pick<AnthropicMessagesPayload, 'system'>>(
  payload: Payload,
  http: HttpRequestFact,
): { payload: Payload; http: HttpRequestFact } => {
  const headers = http.headers.flatMap(([name, value]): HttpRequestFact['headers'] => {
    if (name.toLowerCase() !== 'anthropic-beta' || typeof value !== 'string') return [[name, value]];
    const betas = value.split(',').map(beta => beta.trim()).filter(beta => beta !== claudeCodeBeta && beta !== '');
    return betas.length === 0 ? [] : [[name, betas.join(',')]];
  });
  const cleanPayload = { ...payload };
  if (typeof payload.system === 'string') {
    const system = stripText(payload.system);
    if (system.length > 0) cleanPayload.system = system;
    else delete cleanPayload.system;
  } else if (Array.isArray(payload.system)) {
    const system = payload.system.map(block => ({ ...block, text: stripText(block.text) })).filter(block => block.text.length > 0);
    if (system.length > 0) cleanPayload.system = system;
    else delete cleanPayload.system;
  }
  return { payload: cleanPayload, http: { ...http, headers } };
};

export const stripAnthropicMessagesBilling = defineStage({
  name: 'anthropicMessages.strip-billing-attribution',
  through: {
    request: { needs: ['anthropicMessages', 'http', 'model'], provides: ['anthropicMessages', 'http'], consumes: [] },
    response: { needs: [], provides: [], consumes: [] },
  },
  async execute(facts, scope) {
    if (!facts.model.enabledFlags.includes('strip-billing-attribution')) return await scope.next(facts);
    const { payload, http } = stripAnthropicMessagesBillingAttribution(facts.anthropicMessages, facts.http);
    return await scope.next({ ...facts, anthropicMessages: payload, http });
  },
});
