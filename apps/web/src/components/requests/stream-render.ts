import type { RecordedClientStream } from './run-stream';
import { errorMessage } from '../../lib/error-message';
import { collectAnthropicMessagesProtocolEventsToResult } from '@floway-dev/protocols/anthropic-messages';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import {
  collectGeminiGenerateContentProtocolEventsToResult,
  type GeminiGenerateContentStreamEvent,
} from '@floway-dev/protocols/gemini-generate-content';
import { collectOpenAIChatCompletionsProtocolEventsToResult } from '@floway-dev/protocols/openai-chat-completions';
import {
  reassembleOpenAICompletionsEvents,
  type OpenAICompletionsStreamEvent,
} from '@floway-dev/protocols/openai-completions';
import { collectOpenAIResponsesProtocolEventsToResult } from '@floway-dev/protocols/openai-responses';

export type CollectKind = 'openai-completions' | 'openai-chat-completions' | 'anthropic-messages' | 'openai-responses' | 'gemini-generate-content';

export interface CollectedStream {
  result: unknown | null;
  error: string | null;
  truncated: boolean;
}

export const detectCollectKind = (path: string): CollectKind | null => {
  if (path.includes('/messages')) return 'anthropic-messages';
  if (path.includes('/responses')) return 'openai-responses';
  if (path.includes('/chat/completions')) return 'openai-chat-completions';
  if (path.includes('/completions')) return 'openai-completions';
  if (path.includes('/v1beta/') || path.includes(':generateContent')) return 'gemini-generate-content';
  return null;
};

export const collectStream = async (kind: CollectKind, { frames, ended }: RecordedClientStream): Promise<CollectedStream> => {
  const complete = (result: unknown): CollectedStream => ({ result, error: null, truncated: !ended });
  try {
    switch (kind) {
    case 'openai-chat-completions':
      return complete(await collectOpenAIChatCompletionsProtocolEventsToResult(asIterable(frames) as never));
    case 'anthropic-messages':
      return complete(await collectAnthropicMessagesProtocolEventsToResult(asIterable(frames) as never));
    case 'openai-responses':
      return complete(await collectOpenAIResponsesProtocolEventsToResult(asIterable(frames) as never));
    case 'gemini-generate-content':
      return complete(await collectGeminiGenerateContentProtocolEventsToResult(asIterable(frames) as AsyncIterable<ProtocolFrame<GeminiGenerateContentStreamEvent>>));
    case 'openai-completions': {
      const stream = (async function* () {
        for (const frame of frames) {
          const typed = frame as ProtocolFrame<OpenAICompletionsStreamEvent>;
          if (typed.type === 'event') yield typed.event;
        }
      })();
      return complete(await reassembleOpenAICompletionsEvents(stream));
    }
    }
  } catch (error) {
    return { result: null, error: errorMessage(error), truncated: !ended };
  }
};

async function* asIterable(frames: readonly ProtocolFrame<unknown>[]) {
  yield* frames;
}
