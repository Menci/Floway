import { OpenAIChatCompletionsAssistantMessagePrivate, type OpenAIChatCompletionsAssistantMessageEx, type OpenAIChatCompletionsPayload, type OpenAIChatCompletionsPrivateContext } from '@floway-dev/protocols/openai-chat-completions';

export const decodeChatPrivateHistory = async (payload: OpenAIChatCompletionsPayload, context?: OpenAIChatCompletionsPrivateContext): Promise<OpenAIChatCompletionsPayload> => {
  if (context === undefined) return payload;
  let messages = payload.messages;
  for (const [index, source] of payload.messages.entries()) {
    if (source.role !== 'assistant' || source[OpenAIChatCompletionsAssistantMessagePrivate] !== undefined) continue;
    const extensions = source as OpenAIChatCompletionsAssistantMessageEx;
    let reasoning: OpenAIChatCompletionsAssistantMessagePrivate | undefined;
    if (context.preference.reasoningEncapsulationFormat === 'copilot-reasoning_opaque') {
      reasoning = await context.codec.unencapsulate(extensions.reasoning_opaque);
    } else {
      for (const detail of Array.isArray(extensions.reasoning_details) ? extensions.reasoning_details : []) {
        reasoning = await context.codec.unencapsulate((detail as { data?: unknown }).data);
        if (reasoning !== undefined) break;
      }
    }
    if (reasoning === undefined) continue;
    const text = extensions[context.preference.textFieldName];
    const message = { ...extensions, [OpenAIChatCompletionsAssistantMessagePrivate]: { ...reasoning, reasoningText: typeof text === 'string' ? text : undefined } };
    if (context.preference.reasoningEncapsulationFormat === 'copilot-reasoning_opaque') delete message.reasoning_opaque;
    else delete message.reasoning_details;
    if (typeof text === 'string') delete message[context.preference.textFieldName];
    if (messages === payload.messages) messages = [...messages];
    messages[index] = message;
  }
  return messages === payload.messages ? payload : { ...payload, messages };
};
