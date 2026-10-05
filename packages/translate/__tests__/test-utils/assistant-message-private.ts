import { openAIChatCompletionsReferencedTextHash, OpenAIChatCompletionsAssistantMessagePrivate, type OpenAIChatCompletionsPrivateContext } from '@floway-dev/protocols/openai-chat-completions';

export const privateContext = (): OpenAIChatCompletionsPrivateContext => {
  const values = new Map<string, OpenAIChatCompletionsAssistantMessagePrivate>();
  return {
    preference: { textFieldName: 'reasoning', reasoningEncapsulationFormat: 'openrouter-reasoning_details' },
    codec: {
      encapsulate: async value => {
        const key = `test:${values.size}`;
        values.set(key, structuredClone(value));
        return key;
      },
      unencapsulate: async value => typeof value === 'string' && values.has(value) ? structuredClone(values.get(value)) : undefined,
    },
  };
};

export const referencedTextHash = (reasoningText?: string, content?: string | null, args: string[] = []): Uint8Array => openAIChatCompletionsReferencedTextHash({
  role: 'assistant', content,
  [OpenAIChatCompletionsAssistantMessagePrivate]: { reasoningText, sidecar: { upstreamProtocol: 'openaiChatCompletions' } },
  tool_calls: args.map((arguments_, index) => ({ id: `${index}`, type: 'function', function: { name: 'tool', arguments: arguments_ } })),
});
