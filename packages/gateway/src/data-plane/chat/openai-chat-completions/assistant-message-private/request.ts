import { klona } from 'klona/json';

import { OpenAIChatCompletionsAssistantMessagePrivate, setOpenAIChatCompletionsField, type OpenAIChatCompletionsAssistantMessageEx, type OpenAIChatCompletionsPayload, type OpenAIChatCompletionsPrivateContext } from '@floway-dev/protocols/openai-chat-completions';

export const decodeOpenAIChatCompletionsPrivateHistory = async (payload: OpenAIChatCompletionsPayload, context: OpenAIChatCompletionsPrivateContext): Promise<void> => {
  for (const source of payload.messages) {
    if (source.role !== 'assistant') continue;
    const message = source as OpenAIChatCompletionsAssistantMessageEx;
    let value: OpenAIChatCompletionsAssistantMessagePrivate | undefined;
    if (context.preference.reasoningEncapsulationFormat === 'openrouter-reasoning_details') {
      if (Array.isArray(message.reasoning_details)) {
        for (const item of message.reasoning_details) {
          value = await context.codec.unencapsulate((item as { data?: unknown }).data);
          if (value !== undefined) break;
        }
      }
      if (value !== undefined) delete message.reasoning_details;
    } else {
      value = await context.codec.unencapsulate(message.reasoning_opaque);
      if (value !== undefined) delete message.reasoning_opaque;
    }
    if (value === undefined) continue;
    const text = message[context.preference.textFieldName];
    value.reasoningText = typeof text === 'string' ? text : undefined;
    if (value.reasoningText !== undefined) delete message[context.preference.textFieldName];
    message[OpenAIChatCompletionsAssistantMessagePrivate] = value;
  }
};

export const restoreOpenAIChatCompletionsPrivateHistory = (payload: OpenAIChatCompletionsPayload): void => {
  for (const source of payload.messages) {
    if (source.role !== 'assistant') continue;
    const message = source as OpenAIChatCompletionsAssistantMessageEx;
    const value = message[OpenAIChatCompletionsAssistantMessagePrivate];
    if (value?.sidecar.upstreamProtocol !== 'openaiChatCompletions') continue;
    const { reasoningText, sidecar } = value;
    if (reasoningText !== undefined && sidecar.textFieldOriginalName !== undefined) message[sidecar.textFieldOriginalName] = reasoningText;
    for (const [field, data] of Object.entries(sidecar.extraFields ?? {})) setOpenAIChatCompletionsField(message, field, data);
    for (const tool of message.tool_calls ?? []) {
      for (const [field, data] of Object.entries(sidecar.toolCallExtraFields?.[tool.id] ?? {})) setOpenAIChatCompletionsField(tool, field, data);
    }
  }
};

export const cloneOpenAIChatCompletionsPayload = (payload: OpenAIChatCompletionsPayload): OpenAIChatCompletionsPayload => {
  const copy = klona(payload);
  for (const [index, message] of payload.messages.entries()) {
    if (message.role !== 'assistant') continue;
    const value = message[OpenAIChatCompletionsAssistantMessagePrivate];
    const target = copy.messages[index];
    if (value !== undefined && target.role === 'assistant') target[OpenAIChatCompletionsAssistantMessagePrivate] = klona(value);
  }
  return copy;
};
