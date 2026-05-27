import type { ChatCompletionsInterceptor } from '../../../../llm/interceptors.ts';
import { checkWhitespaceOverflow } from '../shared/whitespace-overflow.ts';
import type { ChatCompletionChunk } from '@floway-dev/protocols/chat-completions';
import type { ProtocolFrame } from '@floway-dev/protocols/common';

/**
 * Copilot has been observed to emit only whitespace (`\r`, `\n`, `\t`) inside
 * `function.arguments` deltas until `max_tokens`, never producing valid JSON.
 * Detect that pattern per tool call and abort by throwing, so every source
 * (native Chat, plus Messages/Gemini/Responses sources translated via Chat)
 * sees the gateway's standard upstream-error path.
 *
 * The Chat Completions protocol cannot express a stream error in-band: the
 * `finish_reason` enum lacks an 'error' value, and the de-facto
 * `data: {"error":{...}}` chunk pattern is only recognized by some
 * translators (e.g. gemini-via-chat-completions calls
 * `chatCompletionsErrorPayloadMessage`) but not others
 * (e.g. messages-via-chat-completions iterates `choices[].delta` and would
 * silently drop an error chunk). Throwing keeps the abort semantics uniform
 * across every consumer; the source layer converts the thrown error into the
 * downstream protocol's native error event.
 *
 * Lives at the Copilot provider boundary so other OpenAI-compatible providers
 * are not slowed by per-delta whitespace inspection.
 *
 * References:
 * - https://github.com/caozhiyuan/copilot-api/commit/4c0d775e1dc6b8648c7ad5f21fb783fc3246facf
 * - https://github.com/caozhiyuan/copilot-api/commit/3cdc32c0811469da9eebec5ca3892caf068df542
 */
const isWhitespaceExceeded = (
  chunk: ChatCompletionChunk,
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

export const withToolArgumentWhitespaceAborted: ChatCompletionsInterceptor = async (_invocation, _request, run) => {
  const result = await run();
  if (result.type !== 'events') return result;

  return {
    ...result,
    events: (async function* (): AsyncGenerator<ProtocolFrame<ChatCompletionChunk>> {
      const whitespaceByIndex = new Map<number, number>();

      for await (const frame of result.events) {
        if (frame.type === 'event' && isWhitespaceExceeded(frame.event, whitespaceByIndex)) {
          throw new Error('Copilot tool call arguments contained excessive consecutive whitespace, indicating a degenerate response.');
        }
        yield frame;
      }
    })(),
  };
};
