import { defineCopilotStage } from '../facts.ts';
import { parseJsonObject } from '../shared/json.ts';
import { move, transform, type Result } from '@floway-dev/pipeline';
import { formatOpenAIResponsesError, type OpenAIResponsesResultEx } from '@floway-dev/protocols/openai-responses';
import { parseResultBody } from '@floway-dev/provider';

// The /responses trigger returns a generation resource with an output array.
// https://github.com/openai/codex/blob/3d805abdf09093bfa806f359a5adc6514766c420/codex-rs/core/src/compact_remote_v2.rs#L439-L501
const parseGeneratedResponse = (bytes: Uint8Array): Result<OpenAIResponsesResultEx, unknown> => {
  const result = parseJsonObject(bytes);
  if (!result.ok) return result;
  if (!Array.isArray(result.value.output)) return { ok: false, error: new TypeError('Expected output in the Copilot compaction trigger response') };
  return { ok: true, value: result.value as unknown as OpenAIResponsesResultEx };
};

export const parseOpenAIResponsesCompact = defineCopilotStage({
  name: 'copilot.openaiResponsesCompact.parse',
  through: {
    request: { needs: [], provides: [], consumes: [] },
    response: {
      needs: ['response.transport'],
      provides: ['response.http', 'response.openaiResponses'],
      consumes: ['response.transport'],
    },
  },
  execute: transform(() => ({
    async response(facts) {
      const { 'response.transport': _transport, ...rest } = facts;
      const { http, outcome } = await parseResultBody(facts, parseGeneratedResponse, formatOpenAIResponsesError);
      return { ...rest, 'response.http': move(http), 'response.openaiResponses': move(outcome) };
    },
  })),
});
