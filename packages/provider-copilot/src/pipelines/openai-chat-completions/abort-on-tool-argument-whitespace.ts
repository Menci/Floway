import { defineCopilotStage } from '../facts.ts';
import { checkWhitespaceOverflow } from '../shared/whitespace-overflow.ts';
import { move } from '@floway-dev/pipeline';
import type { OpenAIChatCompletionsStreamEvent } from '@floway-dev/protocols/openai-chat-completions';

export const abortOnToolArgumentWhitespace = defineCopilotStage({
  name: 'copilot.openaiChatCompletions.abortOnToolArgumentWhitespace',
  through: {
    request: { needs: [], provides: [], consumes: [] },
    response: { needs: ['response.openaiChatCompletions'], provides: ['response.openaiChatCompletions'], consumes: [] },
  },
  async execute(facts, scope) {
    const back = await scope.next(facts);
    const outcome = back['response.openaiChatCompletions'];
    if (outcome.kind !== 'stream') return back;

    const stream = scope.wrapStream(outcome.stream, async function* (source, producer) {
      const whitespaceByIndex = new Map<number, number>();
      let stopped = false;
      for await (const item of source) {
        if (stopped) continue;
        if (item.ok && isWhitespaceExceeded(item.value, whitespaceByIndex)) {
          stopped = true;
          yield {
            ok: false,
            error: {
              kind: 'protocol',
              cause: new Error('Copilot tool call arguments contained excessive consecutive whitespace, indicating a degenerate response.'),
            },
          } as const;
          producer.abort(back);
        } else {
          yield item;
        }
      }
    });
    return { ...back, 'response.openaiChatCompletions': move({ kind: 'stream', stream }) };
  },
});

// https://github.com/caozhiyuan/copilot-api/commit/4c0d775e1dc6b8648c7ad5f21fb783fc3246facf
// https://github.com/caozhiyuan/copilot-api/commit/3cdc32c0811469da9eebec5ca3892caf068df542
const isWhitespaceExceeded = (
  chunk: OpenAIChatCompletionsStreamEvent,
  whitespaceByIndex: Map<number, number>,
): boolean => {
  for (const choice of chunk.choices) {
    const toolCalls = choice.delta.tool_calls;
    if (!toolCalls) continue;

    for (const toolCall of toolCalls) {
      const args = toolCall.function?.arguments;
      if (!args) continue;

      const current = whitespaceByIndex.get(toolCall.index) ?? 0;
      const { count, exceeded } = checkWhitespaceOverflow(args, current);
      whitespaceByIndex.set(toolCall.index, count);
      if (exceeded) return true;
    }
  }
  return false;
};
