import { defineCopilotStage } from '../facts.ts';
import { checkWhitespaceOverflow } from '../shared/whitespace-overflow.ts';
import type { OpenAIChatCompletionsStreamEvent } from '@floway-dev/protocols/openai-chat-completions';

// Copilot can stream whitespace-only arguments until the token limit.
// https://github.com/caozhiyuan/copilot-api/commit/4c0d775e1dc6b8648c7ad5f21fb783fc3246facf
const exceeded = (chunk: OpenAIChatCompletionsStreamEvent, whitespaceByCall: Map<string, number>): boolean => {
  if (!Array.isArray(chunk.choices)) return false;
  for (const choice of chunk.choices) {
    for (const call of choice.delta.tool_calls ?? []) {
      const args = call.function?.arguments;
      if (!args) continue;
      const key = `${choice.index}:${call.index}`;
      const check = checkWhitespaceOverflow(args, whitespaceByCall.get(key) ?? 0);
      if (check.exceeded) return true;
      whitespaceByCall.set(key, check.count);
    }
  }
  return false;
};

export const guardToolArgumentWhitespace = defineCopilotStage({
  name: 'copilot.openaiChatCompletions.guardToolArgumentWhitespace',
  through: {
    request: { needs: [], provides: [], consumes: [] },
    response: { needs: ['response.openaiChatCompletions'], provides: ['response.openaiChatCompletions'], consumes: [] },
  },
  async execute(facts, scope) {
    const back = await scope.next(facts);
    const outcome = back['response.openaiChatCompletions'];
    if (outcome.kind !== 'stream') return back;

    const stream = scope.wrapStream(outcome.stream, async function* (source, producer) {
      const whitespaceByCall = new Map<string, number>();
      for await (const item of producer.read(source)) {
        if (item.ok && exceeded(item.value, whitespaceByCall)) {
          producer.discard(source);
          yield { ok: false, error: { kind: 'protocol', cause: new Error('Copilot tool call arguments contained excessive consecutive whitespace, indicating a degenerate response.') } } as const;
          return;
        }
        yield item;
      }
    });
    return { ...back, 'response.openaiChatCompletions': { kind: 'stream', stream } };
  },
});
