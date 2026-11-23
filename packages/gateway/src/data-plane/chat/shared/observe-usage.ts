import { firstOutputTokenSignal } from './first-output-token.ts';
import type { ChatEvent } from './route-body.ts';
import { createObserveCall, observedTokenUsage } from '../../pipeline/call-metering.ts';
import { createAnthropicMessagesBillableUsageReader } from '../anthropic-messages/usage.ts';
import { billableUsageFromOpenAIChatCompletionsEvent } from '../openai-chat-completions/usage.ts';
import { billableUsageFromOpenAIResponsesEvent, billableUsageFromOpenAIResponsesResult } from '../openai-responses/usage.ts';
import type { BillableUsage } from '@floway-dev/protocols/common';
import { billableUsageFromGeminiGenerateContentEvent, createGeminiGenerateContentCandidateCompletion, isGeminiGenerateContentErrorEvent, isGeminiGenerateContentTerminalEvent } from '@floway-dev/protocols/gemini-generate-content';
import { openaiChatCompletionsErrorPayloadMessage } from '@floway-dev/protocols/openai-chat-completions';
import { isOpenAIResponsesErrorEvent, isOpenAIResponsesTerminalEvent, type OpenAIResponsesCompactionResultEx } from '@floway-dev/protocols/openai-responses';
import type { ChatTargetApi } from '@floway-dev/provider';

const createChatObserveCall = <Api extends ChatTargetApi, Result = never>(
  api: Api,
  openReader: () => (event: ChatEvent<Api>) => BillableUsage | null,
  isError: (event: ChatEvent<Api>) => boolean,
  isTerminal: (event: ChatEvent<Api>) => boolean,
  scalar?: (result: Result) => BillableUsage | null,
) => createObserveCall<`response.${Api}`, ChatEvent<Api>, Result>(`response.${api}`, {
  open: () => {
    const read = openReader();
    let tokens: BillableUsage | null = null;
    return {
      frame: frame => {
        if (frame.type === 'done') return;
        tokens = read(frame.event) ?? tokens;
        return { output: firstOutputTokenSignal(frame, api) !== null, failed: isError(frame.event), terminal: isTerminal(frame.event) };
      },
      usage: () => observedTokenUsage(tokens),
    };
  },
  ...(scalar === undefined ? {} : { scalar: result => observedTokenUsage(scalar(result)) }),
});

export const observeAnthropicMessagesCall = createChatObserveCall(
  'anthropicMessages', createAnthropicMessagesBillableUsageReader, event => event.type === 'error', event => event.type === 'message_stop',
);

export const observeGeminiGenerateContentCall = createObserveCall<'response.geminiGenerateContent', ChatEvent<'geminiGenerateContent'>>(
  'response.geminiGenerateContent', {
    open: () => {
      const completion = createGeminiGenerateContentCandidateCompletion();
      let tokens: BillableUsage | null = null;
      return {
        frame: frame => {
          if (frame.type === 'done') return;
          const { event } = frame;
          completion.observe(event);
          tokens = billableUsageFromGeminiGenerateContentEvent(event) ?? tokens;
          return {
            output: firstOutputTokenSignal(frame, 'geminiGenerateContent') !== null,
            failed: isGeminiGenerateContentErrorEvent(event),
            terminal: isGeminiGenerateContentTerminalEvent(event),
          };
        },
        usage: () => observedTokenUsage(tokens),
        complete: completion.isComplete,
      };
    },
  },
);

export const observeOpenAIChatCompletionsCall = createChatObserveCall(
  'openaiChatCompletions', () => billableUsageFromOpenAIChatCompletionsEvent,
  event => openaiChatCompletionsErrorPayloadMessage(event) !== null, () => false,
);

export const observeOpenAIResponsesCall = createChatObserveCall<'openaiResponses', OpenAIResponsesCompactionResultEx>(
  'openaiResponses', () => billableUsageFromOpenAIResponsesEvent,
  event => isOpenAIResponsesErrorEvent(event) || event.type === 'response.failed', isOpenAIResponsesTerminalEvent,
  billableUsageFromOpenAIResponsesResult,
);
