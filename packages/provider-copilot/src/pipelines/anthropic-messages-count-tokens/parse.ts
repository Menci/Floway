import { defineCopilotStage } from '../facts.ts';
import { parseJsonObject } from '../shared/json.ts';
import { move, transform } from '@floway-dev/pipeline';
import { formatAnthropicMessagesError } from '@floway-dev/protocols/anthropic-messages';
import { parseResultBody } from '@floway-dev/provider';

const parseCountTokens = (bytes: Uint8Array) => {
  const result = parseJsonObject(bytes);
  if (!result.ok) return result;
  const { input_tokens: inputTokens } = result.value;
  if (typeof inputTokens !== 'number') return { ok: false, error: new TypeError('Expected numeric input_tokens in a Copilot count_tokens response') } as const;
  return { ok: true, value: { ...result.value, input_tokens: inputTokens } } as const;
};

export const parseAnthropicMessagesCountTokens = defineCopilotStage({
  name: 'copilot.anthropicMessagesCountTokens.parse',
  through: {
    request: { needs: ['copilot.modelId'], provides: [], consumes: ['copilot.modelId'] },
    response: {
      needs: ['response.transport'],
      provides: ['response.http', 'response.modelKey', 'response.anthropicMessages'],
      consumes: ['response.transport'],
    },
  },
  execute: transform(() => {
    let modelKey: string;
    return {
      request({ 'copilot.modelId': id, ...facts }) {
        modelKey = id;
        return facts;
      },
      async response(facts) {
        const { 'response.transport': _transport, ...rest } = facts;
        const { http, outcome } = await parseResultBody(facts, parseCountTokens, formatAnthropicMessagesError);
        return { ...rest, 'response.http': move(http), 'response.modelKey': modelKey, 'response.anthropicMessages': move(outcome) };
      },
    };
  }),
});
