import { defineCopilotStage } from '../facts.ts';
import { checkWhitespaceOverflow } from '../shared/whitespace-overflow.ts';

// Guard each function call's argument stream independently.
// https://github.com/caozhiyuan/copilot-api/commit/3cdc32c0811469da9eebec5ca3892caf068df542
export const guardToolArgumentWhitespace = defineCopilotStage({
  name: 'copilot.openaiResponses.guardToolArgumentWhitespace',
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
      for await (const item of producer.read(source)) {
        if (item.ok && item.value.type === 'response.function_call_arguments.delta') {
          const { delta, output_index: index } = item.value;
          const check = checkWhitespaceOverflow(delta, whitespaceByIndex.get(index) ?? 0);
          if (check.exceeded) {
            producer.log.withField('outputIndex', index).warn('Copilot OpenAI Responses emitted excessive whitespace in function call arguments');
            producer.discard(source);
            yield { ok: false, error: { kind: 'protocol', cause: new Error('Tool call arguments contained excessive whitespace, indicating a degenerate response.') } } as const;
            return;
          }
          whitespaceByIndex.set(index, check.count);
        }
        yield item;
      }
    });
    return { ...back, 'response.openaiResponses': { kind: 'stream', stream } };
  },
});
