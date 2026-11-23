import { rewriteChatRequest } from '../../shared/rewrite-stage.ts';
import type { OpenAIChatCompletionsPayloadEx } from '@floway-dev/protocols/openai-chat-completions';

const hasForcedToolChoice = ({ tool_choice: choice }: OpenAIChatCompletionsPayloadEx): boolean =>
  choice != null && (typeof choice !== 'string' || choice === 'required');

export const disableReasoningOnForcedToolChoice = rewriteChatRequest(
  'disableReasoningOnForcedToolChoice', 'request.openaiChatCompletions',
  (payload: OpenAIChatCompletionsPayloadEx, { providerModel }) =>
    providerModel.enabledFlags.includes('disable-reasoning-on-forced-tool-choice') && hasForcedToolChoice(payload)
      ? { ...payload, reasoning_effort: 'none' }
      : payload,
);
