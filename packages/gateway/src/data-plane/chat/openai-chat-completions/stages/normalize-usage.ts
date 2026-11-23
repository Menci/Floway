import { asJsonObject } from '../../../../shared/json-helpers.ts';
import { rewriteChatFrames } from '../../shared/rewrite-stage.ts';
import { eventFrame } from '@floway-dev/protocols/common';
import type { OpenAIChatCompletionsStreamEvent } from '@floway-dev/protocols/openai-chat-completions';

// When upstream combines usage and a finishing choice, emit usage in its own empty-choices chunk.
// https://platform.openai.com/docs/api-reference/chat-streaming
export const normalizeUsage = rewriteChatFrames<'response.openaiChatCompletions', OpenAIChatCompletionsStreamEvent>(
  'normalizeUsage', 'response.openaiChatCompletions', () => async function* (source) {
    for await (const frame of source) {
      if (frame.type === 'done' || !asJsonObject(frame.event.usage) || frame.event.choices.length === 0) {
        yield frame;
      } else {
        const { usage, ...chunk } = frame.event;
        yield eventFrame(chunk);
        yield eventFrame({ ...chunk, choices: [], usage });
      }
    }
  },
);
