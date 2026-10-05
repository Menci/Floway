import type { AnthropicMessagesStreamEventEx, AnthropicMessagesAssistantInputContentBlock } from '@floway-dev/protocols/anthropic-messages';
import { OpenAIChatCompletionsAssistantMessagePrivate, createOpenAIChatCompletionsReferencedTextHash, openAIChatCompletionsTextFromRanges, matchesOpenAIChatCompletionsReferencedTextHash, type OpenAIChatCompletionsAssistantMessage, type OpenAIChatCompletionsAssistantMessageSidecar, type OpenAIChatCompletionsStreamEvent, type OpenAIChatCompletionsViaAnthropicMessagesThinBlock } from '@floway-dev/protocols/openai-chat-completions';

type MessagesSidecar = Extract<OpenAIChatCompletionsAssistantMessageSidecar, { upstreamProtocol: 'anthropicMessages' }>;

export const createAnthropicMessagesPrivateState = () => ({
  blocks: new Map<number, OpenAIChatCompletionsViaAnthropicMessagesThinBlock>(),
  hash: createOpenAIChatCompletionsReferencedTextHash(),
  nativeInputs: new Map<number, string>(),
});

export const observeAnthropicMessagesPrivate = (event: AnthropicMessagesStreamEventEx, state: ReturnType<typeof createAnthropicMessagesPrivateState>): string | undefined => {
  let text: string | undefined;
  if (event.type === 'content_block_start') {
    if (event.content_block.type === 'thinking') {
      const { thinking, ...block } = event.content_block;
      state.blocks.set(event.index, { ...block, __thinking: [] });
      if (thinking) text = thinking;
    } else if (event.content_block.type === 'redacted_thinking') state.blocks.set(event.index, { ...event.content_block });
  } else if (event.type === 'content_block_delta') {
    const block = state.blocks.get(event.index);
    if (event.delta.type === 'thinking_delta' || event.delta.type === 'signature_delta') {
      if (block?.type !== 'thinking') throw new Error('A thinking delta must reference its native thinking block');
      if (event.delta.type === 'signature_delta') block.signature = (block.signature ?? '') + event.delta.signature;
      else text = event.delta.thinking;
    } else if (event.delta.type === 'citations_delta' && block?.type === 'text') {
      (block.citations ??= []).push(event.delta.citation);
    } else if (event.delta.type === 'input_json_delta' && block?.type === 'server_tool_use') {
      state.nativeInputs.set(event.index, (state.nativeInputs.get(event.index) ?? '') + event.delta.partial_json);
    } else if (event.delta.type === 'compaction_delta' && block?.type === 'compaction') {
      if (event.delta.content !== null) block.content = (block.content ?? '') + event.delta.content;
      if (event.delta.encrypted_content !== null) block.encrypted_content = event.delta.encrypted_content;
    }
  } else if (event.type === 'content_block_stop') {
    const input = state.nativeInputs.get(event.index);
    const block = state.blocks.get(event.index);
    if (input !== undefined && block?.type === 'server_tool_use') {
      block.input = JSON.parse(input);
      state.nativeInputs.delete(event.index);
    }
  }
  if (text !== undefined) {
    const block = state.blocks.get((event as { index: number }).index)!;
    if (block.type === 'thinking') state.hash.update({ [OpenAIChatCompletionsAssistantMessagePrivate]: { reasoningText: text } }, { reasoningText: block.__thinking });
  }
  return text;
};

export const recordAnthropicMessagesChatProjection = (event: AnthropicMessagesStreamEventEx, chunks: OpenAIChatCompletionsStreamEvent[], state: ReturnType<typeof createAnthropicMessagesPrivateState>): void => {
  if (event.type === 'content_block_start') {
    const block = event.content_block;
    if (block.type === 'text') {
      const { text: _text, ...metadata } = block;
      state.blocks.set(event.index, { ...metadata, citations: block.citations == null ? block.citations : [...block.citations], __text: [] });
    } else if (block.type === 'tool_use') {
      const { input: _input, ...metadata } = block;
      const index = chunks.flatMap(chunk => chunk.choices.flatMap(choice => choice.delta.tool_calls ?? []))[0].index;
      state.blocks.set(event.index, { ...metadata, __index: index });
    } else if (block.type !== 'thinking' && block.type !== 'redacted_thinking') state.blocks.set(event.index, { ...block });
  }
  for (const chunk of chunks) for (const { delta } of chunk.choices) {
    const block = 'index' in event ? state.blocks.get(event.index) : undefined;
    state.hash.update({ content: delta.content, tool_calls: delta.tool_calls }, { content: block?.type === 'text' ? block.__text : undefined });
  }
};

export const finalizeAnthropicMessagesPrivate = (state: ReturnType<typeof createAnthropicMessagesPrivateState>): MessagesSidecar | undefined => state.blocks.size > 0 ? {
  upstreamProtocol: 'anthropicMessages',
  thinBlocks: [...state.blocks].toSorted(([a], [b]) => a - b).map(([, block]) => block),
  referencedTextHash: state.hash.digest(),
} : undefined;

export const restoreAnthropicMessagesThinBlocks = (message: OpenAIChatCompletionsAssistantMessage): AnthropicMessagesAssistantInputContentBlock[] | undefined => {
  const privateState = message[OpenAIChatCompletionsAssistantMessagePrivate];
  if (privateState?.sidecar.upstreamProtocol !== 'anthropicMessages' || !matchesOpenAIChatCompletionsReferencedTextHash(message, privateState.sidecar.referencedTextHash)) return undefined;
  const content = typeof message.content === 'string' ? message.content : message.content?.filter(part => part.type === 'text').map(part => part.text).join('');
  return privateState.sidecar.thinBlocks.map(block => {
    if (block.type === 'text') {
      const { __text, ...metadata } = block;
      return { ...metadata, text: openAIChatCompletionsTextFromRanges(content!, __text) };
    }
    if (block.type === 'thinking') {
      const { __thinking, ...metadata } = block;
      return { ...metadata, thinking: openAIChatCompletionsTextFromRanges(privateState.reasoningText!, __thinking) };
    }
    if (block.type === 'tool_use') {
      const { __index, ...metadata } = block;
      const call = message.tool_calls![__index];
      if (call.type !== 'function') throw new Error('A native Messages tool must reference a Chat function call');
      return { ...metadata, input: JSON.parse(call.function.arguments) };
    }
    return block;
  }) as AnthropicMessagesAssistantInputContentBlock[];
};
