import { firstOutputTokenSignal } from './first-output-token.ts';
import type { ChatEvent } from './route-body.ts';
import { createObserveUsage, observedTokenUsage } from '../../pipeline/observe-usage.ts';
import { createAnthropicMessagesBillableUsageReader } from '../anthropic-messages/usage.ts';
import { billableUsageFromOpenAIChatCompletionsEvent } from '../openai-chat-completions/usage.ts';
import { billableUsageFromOpenAIResponsesEvent, billableUsageFromOpenAIResponsesResult } from '../openai-responses/usage.ts';
import type { BillableUsage } from '@floway-dev/protocols/common';
import { billableUsageFromGeminiGenerateContentEvent, isGeminiGenerateContentErrorEvent } from '@floway-dev/protocols/gemini-generate-content';
import { openaiChatCompletionsErrorPayloadMessage } from '@floway-dev/protocols/openai-chat-completions';
import { isOpenAIResponsesErrorEvent } from '@floway-dev/protocols/openai-responses';
import type { ChatTargetApi } from '@floway-dev/provider';

const createChatObserveUsage = <Api extends ChatTargetApi, Result = undefined>(
  api: Api,
  openReader: () => (event: ChatEvent<Api>) => BillableUsage | null,
  isError: (event: ChatEvent<Api>) => boolean,
  scalar?: (result: Result) => BillableUsage | null,
) => createObserveUsage<ChatEvent<Api>, Result>({
  open: () => {
    const read = openReader();
    let tokens: BillableUsage | null = null;
    return {
      frame: frame => {
        if (frame.type === 'done') return;
        tokens = read(frame.event) ?? tokens;
        return { output: firstOutputTokenSignal(frame, api) !== null, failed: isError(frame.event) };
      },
      usage: () => observedTokenUsage(tokens),
    };
  },
  ...(scalar === undefined ? {} : { scalar: result => observedTokenUsage(scalar(result)) }),
});

export const observeAnthropicMessagesUsage = createChatObserveUsage(
  'anthropicMessages', createAnthropicMessagesBillableUsageReader, event => event.type === 'error',
);

export const observeGeminiGenerateContentUsage = createChatObserveUsage(
  'geminiGenerateContent', () => billableUsageFromGeminiGenerateContentEvent, isGeminiGenerateContentErrorEvent,
);

export const observeOpenAIChatCompletionsUsage = createChatObserveUsage(
  'openaiChatCompletions', () => billableUsageFromOpenAIChatCompletionsEvent, event => openaiChatCompletionsErrorPayloadMessage(event) !== null,
);

export const observeOpenAIResponsesUsage = createChatObserveUsage(
  'openaiResponses', () => billableUsageFromOpenAIResponsesEvent, event => isOpenAIResponsesErrorEvent(event) || event.type === 'response.failed',
  billableUsageFromOpenAIResponsesResult,
);
