import type { RecordedClientStream } from './run-stream';
import { errorMessage } from '../../lib/error-message';
import {
  collectAnthropicMessagesProtocolEventsToResult,
  collectGeminiGenerateContentProtocolEventsToResult,
  collectOpenAIChatCompletionsProtocolEventsToResult,
  collectOpenAIResponsesProtocolEventsToResult,
  reassembleOpenAICompletionsEvents,
  type GeminiGenerateContentStreamEvent,
  type OpenAICompletionsStreamEvent,
  type ProtocolFrame,
} from '@floway-dev/protocols/browser';

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
  // A Gemini turn carries its action in the model path segment
  // (`…:generateContent`), optionally followed by `?alt=sse`. The listing
  // paths end at `/models`, so the action name discriminates regardless of
  // whether the turn arrived under `v1` or `v1beta`.
  if (/:(?:generateContent|streamGenerateContent|countTokens)(?:\?|$)/.test(path)) return 'gemini-generate-content';
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
