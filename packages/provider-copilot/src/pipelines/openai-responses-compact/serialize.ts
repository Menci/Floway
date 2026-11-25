import { COMPACTION_TRIGGER, compactionResponse } from '../../compaction.ts';
import { defineCopilotStage } from '../facts.ts';
import { serializeJsonRequest } from '../shared/json.ts';
import { move, transform } from '@floway-dev/pipeline';
import type { CanonicalOpenAIResponsesInputItem, OpenAIResponsesResultEx } from '@floway-dev/protocols/openai-responses';

// Copilot performs remote compaction with a trigger turn on /responses.
// https://github.com/openai/codex/blob/3d805abdf09093bfa806f359a5adc6514766c420/codex-rs/core/src/compact_remote_v2.rs#L439-L501
export const serializeOpenAIResponsesCompact = defineCopilotStage({
  name: 'copilot.openaiResponsesCompact.serialize',
  through: {
    request: { needs: ['request.openaiResponses', 'request.http', 'copilot.modelId'], provides: ['request.http'], consumes: [] },
    response: { needs: ['response.openaiResponses'], provides: ['response.openaiResponses'], consumes: [] },
  },
  execute: transform(() => {
    let input: CanonicalOpenAIResponsesInputItem[];
    return {
      request(facts) {
        const { store: _store, ...payload } = facts['request.openaiResponses'];
        input = payload.input;
        const body = { ...payload, input: [...input, COMPACTION_TRIGGER], stream: false, model: facts['copilot.modelId'] };
        return { ...facts, 'request.http': serializeJsonRequest(facts['request.http'], '/responses', body) };
      },
      response(facts) {
        const outcome = facts['response.openaiResponses'];
        if (outcome.kind !== 'result') return facts;
        // The trigger turn returns a generation resource, which this stage turns into a compact resource.
        const result = compactionResponse(input, outcome.result as OpenAIResponsesResultEx);
        return { ...facts, 'response.openaiResponses': move({ kind: 'result', result }) };
      },
    };
  }),
});
