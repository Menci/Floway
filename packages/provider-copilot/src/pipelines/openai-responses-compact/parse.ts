import { defineCopilotStage } from '../facts.ts';
import { parseJsonObject } from '../shared/json.ts';
import { move, transform, type Result } from '@floway-dev/pipeline';
import { formatOpenAIResponsesError, type OpenAIResponsesResultEx } from '@floway-dev/protocols/openai-responses';
import { parseResultBody } from '@floway-dev/provider';

const parseGeneratedResponse = (bytes: Uint8Array): Result<OpenAIResponsesResultEx, unknown> => {
  const result = parseJsonObject(bytes);
  if (!result.ok) return result;
  if (!Array.isArray(result.value.output)) return { ok: false, error: new TypeError('Expected output in the Copilot compaction trigger response') };
  return { ok: true, value: result.value as unknown as OpenAIResponsesResultEx };
};

export const parseOpenAIResponsesCompact = defineCopilotStage({
  name: 'copilot.openaiResponsesCompact.parse',
  through: {
    request: { needs: ['copilot.modelId'], provides: [], consumes: ['copilot.modelId'] },
    response: {
      needs: ['response.transport'],
      provides: ['response.http', 'response.modelKey', 'response.openaiResponses'],
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
        const { http, outcome } = await parseResultBody(facts, parseGeneratedResponse, formatOpenAIResponsesError);
        return { ...rest, 'response.http': move(http), 'response.modelKey': modelKey, 'response.openaiResponses': move(outcome) };
      },
    };
  }),
});
