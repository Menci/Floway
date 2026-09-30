
import { checkWhitespaceOverflow } from '../../tool-argument-whitespace.ts';
import { defineStage, move } from '@floway-dev/pipeline';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { OpenAIChatCompletionsStreamEvent } from '@floway-dev/protocols/openai-chat-completions';
import type { ProviderChatResponse, ProviderChatServices } from '@floway-dev/provider';

/**
 * Copilot has been observed to emit only whitespace (`\r`, `\n`, `\t`) inside
 * `function.arguments` deltas until `max_tokens`, never producing valid JSON.
 * Detect that pattern per tool call and abort by throwing, so every source
 * (native OpenAI Chat Completions, plus Anthropic Messages/Gemini generateContent/OpenAI Responses
 * sources translated via OpenAI Chat Completions)
 * sees the gateway's standard upstream-error path.
 *
 * The OpenAI Chat Completions protocol cannot express a stream error in-band: the
 * `finish_reason` enum lacks an 'error' value, and the de-facto
 * `data: {"error":{...}}` chunk pattern is only recognized by some
 * translators (e.g. gemini-generate-content-via-openai-chat-completions calls
 * `openaiChatCompletionsErrorPayloadMessage`) but not others
 * (e.g. anthropic-messages-via-openai-chat-completions iterates `choices[].delta` and would
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

export const copilotOpenAIChatCompletionsAbortToolWhitespace = defineStage<object, object, ProviderChatResponse<'openaiChatCompletions'>, ProviderChatResponse<'openaiChatCompletions'>, ProviderChatServices>({
  name: 'copilotOpenAIChatCompletionsAbortToolWhitespace',
  through: { request: { needs: [], consumes: [], provides: [] }, response: { needs: ['response.provider.output'], consumes: ['response.provider.output'], provides: ['response.provider.output'] } },
  execute: async (facts, next, use) => {
    const back = await next(move({ ...facts }));
    const output = back['response.provider.output'];
    if (output === null || !('kind' in output) || output.kind !== 'stream') return move({ ...back });
    return move({
      ...back, 'response.provider.output': {
        ...output, frames: use.recordProtocolFrames((async function* (): AsyncGenerator<ProtocolFrame<OpenAIChatCompletionsStreamEvent>> {
          const whitespaceByIndex = new Map<number, number>();

          for await (const frame of output.frames) {
            if (frame.type === 'event' && isWhitespaceExceeded(frame.event, whitespaceByIndex)) {
              throw new Error('Copilot tool call arguments contained excessive consecutive whitespace, indicating a degenerate response.');
            }
            yield frame;
          }
        })()),
      },
    });
  },
});
