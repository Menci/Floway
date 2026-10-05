import { OpenAIChatCompletionsAssistantMessagePrivate, createOpenAIChatCompletionsReferencedTextHash, openAIChatCompletionsTextFromRanges, matchesOpenAIChatCompletionsReferencedTextHash, type OpenAIChatCompletionsAssistantMessage, type OpenAIChatCompletionsAssistantMessageSidecar, type OpenAIChatCompletionsStreamEvent, type OpenAIChatCompletionsTextRangeReference, type OpenAIChatCompletionsViaOpenAIResponsesThinItem } from '@floway-dev/protocols/openai-chat-completions';
import type { OpenAIResponsesStreamEventEx, OpenAIResponsesOutputItemEx, CanonicalOpenAIResponsesInputItem } from '@floway-dev/protocols/openai-responses';

type ResponsesSidecar = Extract<OpenAIChatCompletionsAssistantMessageSidecar, { upstreamProtocol: 'openaiResponses' }>;
export const createOpenAIResponsesPrivateState = () => ({
  items: new Map<number, OpenAIChatCompletionsViaOpenAIResponsesThinItem>(),
  references: new Map<string, OpenAIChatCompletionsTextRangeReference[]>(),
  hash: createOpenAIChatCompletionsReferencedTextHash(),
  toolIndexes: new Map<number, number>(),
});
const ranges = (state: ReturnType<typeof createOpenAIResponsesPrivateState>, key: string): OpenAIChatCompletionsTextRangeReference[] => {
  let value = state.references.get(key);
  if (value === undefined) { value = []; state.references.set(key, value); }
  return value;
};

export const observeOpenAIResponsesPrivate = (event: OpenAIResponsesStreamEventEx, state: ReturnType<typeof createOpenAIResponsesPrivateState>): string[] => {
  const emit = (outputIndex: number, field: 'summary' | 'content', index: number, text: string, fallback: boolean): string[] => {
    const key = `${outputIndex}:${field}:${index}`;
    const reference = ranges(state, key);
    if (!text || (fallback && reference.length > 0)) return [];
    state.hash.update({ [OpenAIChatCompletionsAssistantMessagePrivate]: { reasoningText: text } }, { reasoningText: reference });
    return [text];
  };
  const capture = (index: number, item: OpenAIResponsesOutputItemEx): string[] => {
    if (item.type !== 'reasoning') return [];
    const text = [
      ...item.summary.flatMap((part, i) => emit(index, 'summary', i, part.text, true)),
      ...(item.content ?? []).flatMap((part, i) => emit(index, 'content', i, part.text, true)),
    ];
    const { summary, content, ...metadata } = item;
    state.items.set(index, {
      ...metadata,
      __summary: summary.map((_, i) => ranges(state, `${index}:summary:${i}`)),
      ...(content !== undefined ? { __content: content.map((_, i) => ranges(state, `${index}:content:${i}`)) } : {}),
    });
    return text;
  };
  switch (event.type) {
  case 'response.reasoning_summary_text.delta': return emit(event.output_index, 'summary', event.summary_index, event.delta, false);
  case 'response.reasoning_summary_text.done': return emit(event.output_index, 'summary', event.summary_index, event.text, true);
  case 'response.reasoning_summary_part.added':
  case 'response.reasoning_summary_part.done': return emit(event.output_index, 'summary', event.summary_index, event.part.text, true);
  case 'response.reasoning_text.delta': return emit(event.output_index, 'content', event.content_index, event.delta, false);
  case 'response.content_part.added':
  case 'response.content_part.done': return event.part.type === 'reasoning_text' ? emit(event.output_index, 'content', event.content_index, event.part.text, true) : [];
  case 'response.reasoning_text.done': return emit(event.output_index, 'content', event.content_index, event.text, true);
  case 'response.output_item.added':
  case 'response.output_item.done': return capture(event.output_index, event.item);
  case 'response.completed':
  case 'response.incomplete': return event.response.output.flatMap((item, index) => capture(index, item));
  default: return [];
  }
};

export const recordOpenAIResponsesChatProjection = (event: OpenAIResponsesStreamEventEx, chunks: OpenAIChatCompletionsStreamEvent[], state: ReturnType<typeof createOpenAIResponsesPrivateState>): void => {
  for (const chunk of chunks) for (const { delta } of chunk.choices) {
    let reference: OpenAIChatCompletionsTextRangeReference[] | undefined;
    if (delta.content != null && 'output_index' in event) {
      const contentIndex = 'content_index' in event ? event.content_index : (event.type === 'response.output_item.added' || event.type === 'response.output_item.done') && event.item.type === 'message' ? event.item.content.findIndex((part, i) => part.type === 'output_text' && ranges(state, `${event.output_index}:text:${i}`).length === 0) : -1;
      reference = ranges(state, `${event.output_index}:text:${contentIndex}`);
    }
    for (const call of delta.tool_calls ?? []) if ('output_index' in event) state.toolIndexes.set(event.output_index, call.index);
    if (delta.content != null || delta.tool_calls !== undefined) state.hash.update({ content: delta.content, tool_calls: delta.tool_calls }, { content: reference });
  }
  const capture = (index: number, item: OpenAIResponsesOutputItemEx) => {
    if (item.type === 'reasoning') return;
    if (item.type === 'message') {
      const { content, ...metadata } = item;
      state.items.set(index, {
        ...metadata, __contents: content.map((part, i) => {
          if (part.type !== 'output_text') return part;
          const { text: _text, ...fields } = part;
          return { ...fields, __text: ranges(state, `${index}:text:${i}`) };
        }),
      });
    } else if (item.type === 'function_call') {
      const { arguments: _arguments, ...metadata } = item;
      state.items.set(index, { ...metadata, __index: state.toolIndexes.get(index)! });
    } else state.items.set(index, item as OpenAIChatCompletionsViaOpenAIResponsesThinItem);
  };
  if (event.type === 'response.output_item.added' || event.type === 'response.output_item.done') capture(event.output_index, event.item);
  else if (event.type === 'response.content_part.added' || event.type === 'response.content_part.done') {
    const item = state.items.get(event.output_index);
    if (item?.type === 'message' && item.__contents !== undefined) {
      const part = event.part;
      if (part.type === 'output_text') {
        const { text: _text, ...metadata } = part;
        item.__contents[event.content_index] = { ...metadata, __text: ranges(state, `${event.output_index}:text:${event.content_index}`) };
      } else if (part.type === 'refusal') item.__contents[event.content_index] = part;
    }
  } else if (event.type === 'response.completed' || event.type === 'response.incomplete') event.response.output.forEach((item, index) => capture(index, item));
};

export const finalizeOpenAIResponsesPrivate = (state: ReturnType<typeof createOpenAIResponsesPrivateState>): ResponsesSidecar | undefined => state.items.size > 0 ? {
  upstreamProtocol: 'openaiResponses',
  thinItems: [...state.items].toSorted(([a], [b]) => a - b).map(([, item]) => item),
  referencedTextHash: state.hash.digest(),
} : undefined;

export const restoreOpenAIResponsesThinItems = (message: OpenAIChatCompletionsAssistantMessage): CanonicalOpenAIResponsesInputItem[] | undefined => {
  const privateState = message[OpenAIChatCompletionsAssistantMessagePrivate];
  if (privateState?.sidecar.upstreamProtocol !== 'openaiResponses' || !matchesOpenAIChatCompletionsReferencedTextHash(message, privateState.sidecar.referencedTextHash)) return undefined;
  const content = typeof message.content === 'string' ? message.content : message.content?.filter(part => part.type === 'text').map(part => part.text).join('');
  const text = (references: OpenAIChatCompletionsTextRangeReference[], source: string | undefined | null) => openAIChatCompletionsTextFromRanges(source!, references);
  return privateState.sidecar.thinItems.map(item => {
    if (item.type === 'message') {
      const { __text, __contents, ...metadata } = item;
      return {
        ...metadata, content: __text !== undefined ? text(__text, content) : __contents!.map(part => {
          if (part.type !== 'input_text' && part.type !== 'output_text') return part;
          const { __text: reference, ...fields } = part;
          return { ...fields, text: text(reference, content) };
        }),
      };
    }
    if (item.type === 'reasoning') {
      const { __summary, __content, ...metadata } = item;
      return { ...metadata, summary: __summary.map(reference => ({ type: 'summary_text', text: text(reference, privateState.reasoningText) })), ...(__content !== undefined ? { content: __content.map(reference => ({ type: 'reasoning_text', text: text(reference, privateState.reasoningText) })) } : {}) };
    }
    if (item.type === 'function_call') {
      const { __index, ...metadata } = item;
      const call = message.tool_calls![__index];
      if (call.type !== 'function') throw new Error('A native Responses tool must reference a Chat function call');
      return { ...metadata, arguments: call.function.arguments };
    }
    return item;
  }) as CanonicalOpenAIResponsesInputItem[];
};
