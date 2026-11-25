import { defineCopilotStage } from '../facts.ts';
import { decisionTarget } from './target.ts';
import { parseJsonObject } from '../shared/json.ts';
import { move, transform } from '@floway-dev/pipeline';
import { parseDecisionResponse } from '@floway-dev/protocols/decision';
import { formatOpenAIChatCompletionsError } from '@floway-dev/protocols/openai-chat-completions';
import { parseResultBody } from '@floway-dev/provider';

export const parseDecision = defineCopilotStage({
  name: 'copilot.decision.parse',
  through: {
    request: { needs: ['copilot.modelId', 'provider.model'], provides: [], consumes: ['copilot.modelId'] },
    response: {
      needs: ['response.transport'],
      provides: ['response.http', 'response.modelKey', 'response.decision'],
      consumes: ['response.transport'],
    },
  },
  execute: transform(() => {
    let modelKey: string;
    let target: ReturnType<typeof decisionTarget>;
    return {
      request({ 'copilot.modelId': id, ...facts }) {
        modelKey = id;
        target = decisionTarget(facts['provider.model']);
        return facts;
      },
      async response(facts) {
        let invalidBody: Record<string, unknown> | undefined;
        const parse = (bytes: Uint8Array) => {
          const json = parseJsonObject(bytes);
          if (!json.ok) return json;
          const parsed = parseDecisionResponse(target.protocol, json.value);
          if (!parsed.ok) invalidBody = json.value;
          return parsed;
        };
        const { 'response.transport': _transport, ...rest } = facts;
        const { http, outcome } = await parseResultBody(facts, parse, formatOpenAIChatCompletionsError);
        return {
          ...rest,
          'response.http': move(http),
          'response.modelKey': modelKey,
          'response.decision': move(outcome.kind === 'error' && invalidBody !== undefined ? { ...outcome, error: invalidBody } : outcome),
        };
      },
    };
  }),
});
