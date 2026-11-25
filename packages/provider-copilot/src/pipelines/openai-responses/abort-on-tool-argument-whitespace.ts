import { defineCopilotStage } from '../facts.ts';
import { checkWhitespaceOverflow } from '../shared/whitespace-overflow.ts';
import { move } from '@floway-dev/pipeline';
import { formatOpenAIResponsesError, type OpenAIResponsesStreamEventEx } from '@floway-dev/protocols/openai-responses';

// https://github.com/caozhiyuan/copilot-api/commit/4c0d775e1dc6b8648c7ad5f21fb783fc3246facf
// https://github.com/caozhiyuan/copilot-api/commit/3cdc32c0811469da9eebec5ca3892caf068df542
const ABORT_MESSAGE = 'Tool call arguments contained excessive whitespace, indicating a degenerate response.';

export const abortOnToolArgumentWhitespace = defineCopilotStage({
  name: 'copilot.openaiResponses.abortOnToolArgumentWhitespace',
  through: {
    request: { needs: [], provides: [], consumes: [] },
    response: { needs: ['response.openaiResponses'], provides: ['response.openaiResponses'], consumes: [] },
  },
  async execute(facts, scope) {
    const back = await scope.next(facts);
    const outcome = back['response.openaiResponses'];
    if (outcome.kind !== 'stream') return back;

    const stream = scope.wrapStream(outcome.stream, async function* (source, producer) {
      const whitespaceByIndex = new Map<number, number>();
      let stopped = false;
      for await (const item of source) {
        if (stopped) continue;
        if (!item.ok || !isArgumentsDelta(item.value)) {
          yield item;
          continue;
        }

        const event = item.value;
        const { count, exceeded } = checkWhitespaceOverflow(event.delta, whitespaceByIndex.get(event.output_index) ?? 0);
        whitespaceByIndex.set(event.output_index, count);
        if (!exceeded) {
          yield item;
          continue;
        }

        stopped = true;
        producer.log.warn('Aborting Copilot OpenAI Responses stream with excessive tool argument whitespace');
        yield { ok: true, value: formatOpenAIResponsesError(null, ABORT_MESSAGE, { code: 'api_error' }) } as const;
        producer.abort(back);
      }
    });
    return { ...back, 'response.openaiResponses': move({ kind: 'stream', stream }) };
  },
});

const isArgumentsDelta = (event: OpenAIResponsesStreamEventEx): event is OpenAIResponsesStreamEventEx & {
  type: 'response.function_call_arguments.delta';
  output_index: number;
  delta: string;
} => event.type === 'response.function_call_arguments.delta';
