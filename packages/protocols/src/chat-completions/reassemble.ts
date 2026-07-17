import { chatCompletionsErrorPayloadMessage } from './index.ts';
import type { ChatCompletionsChoiceNonStreaming, ChatCompletionsDelta, ChatCompletionsResult, ChatCompletionsStreamEvent, ChatCompletionsReasoningItem, ChatCompletionsToolCall } from './index.ts';
import { captureExtras } from '../common/reassemble-extras.ts';

// Field-fidelity contract: every field an upstream emits must reach the
// non-streaming result. Known streaming fields use their protocol semantics;
// unknown fields fall through to captureExtras so future extensions survive.
const KNOWN_DELTA_KEYS = new Set(['content', 'role', 'reasoning_text', 'reasoning_opaque', 'reasoning_items', 'tool_calls']);
const KNOWN_CHOICE_KEYS = new Set(['index', 'delta', 'finish_reason']);
const KNOWN_CHUNK_KEYS = new Set(['id', 'object', 'created', 'model', 'choices', 'usage', 'system_fingerprint', 'service_tier']);

interface ToolCallAccumulator {
  id: string;
  name: string;
  arguments: string;
}

interface ChoiceAccumulator {
  readonly index: number;
  content: string;
  reasoningText: string;
  reasoningOpaque?: string;
  readonly reasoningItems: ChatCompletionsReasoningItem[];
  finishReason: ChatCompletionsChoiceNonStreaming['finish_reason'];
  readonly toolCalls: Map<number, ToolCallAccumulator>;
  readonly choiceExtras: Record<string, unknown>;
  readonly messageExtras: Record<string, unknown>;
}

const createChoiceAccumulator = (index: number): ChoiceAccumulator => ({
  index,
  content: '',
  reasoningText: '',
  reasoningItems: [],
  finishReason: 'stop',
  toolCalls: new Map(),
  choiceExtras: {},
  messageExtras: {},
});

const accumulateToolCalls = (choice: ChoiceAccumulator, value: ChatCompletionsDelta['tool_calls']): void => {
  if (value === undefined) return;

  for (const toolCall of value) {
    const fn = toolCall.function;
    const current = choice.toolCalls.get(toolCall.index) ?? { id: '', name: '', arguments: '' };
    if (toolCall.id !== undefined) current.id = toolCall.id;
    if (fn?.name !== undefined) current.name = fn.name;
    if (fn?.arguments !== undefined) current.arguments += fn.arguments;
    choice.toolCalls.set(toolCall.index, current);
  }
};

const finalizedToolCalls = (choice: ChoiceAccumulator): ChatCompletionsToolCall[] =>
  [...choice.toolCalls.entries()]
    .toSorted(([left], [right]) => left - right)
    .map(([, toolCall]) => ({
      id: toolCall.id,
      type: 'function',
      function: { name: toolCall.name, arguments: toolCall.arguments },
    }));

const finalizeChoice = (choice: ChoiceAccumulator): ChatCompletionsChoiceNonStreaming => {
  const toolCalls = finalizedToolCalls(choice);
  return {
    index: choice.index,
    message: {
      role: 'assistant',
      content: choice.content || null,
      ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      ...(choice.reasoningText ? { reasoning_text: choice.reasoningText } : {}),
      ...(choice.reasoningOpaque !== undefined ? { reasoning_opaque: choice.reasoningOpaque } : {}),
      ...(choice.reasoningItems.length > 0 ? { reasoning_items: choice.reasoningItems } : {}),
      ...choice.messageExtras,
    },
    finish_reason: choice.finishReason,
    ...choice.choiceExtras,
  } as ChatCompletionsChoiceNonStreaming;
};

export async function reassembleChatCompletionsEvents(chunks: AsyncIterable<ChatCompletionsStreamEvent>): Promise<ChatCompletionsResult> {
  let id = '';
  let model = '';
  let created = 0;
  let systemFingerprint: string | undefined;
  let serviceTier: ChatCompletionsResult['service_tier'];
  let lastUsage: ChatCompletionsResult['usage'] | undefined;
  const choices = new Map<number, ChoiceAccumulator>();
  const chunkExtras: Record<string, unknown> = {};

  for await (const chunk of chunks) {
    const errorMessage = chatCompletionsErrorPayloadMessage(chunk);
    if (errorMessage) throw new Error(`Upstream Chat Completions SSE error: ${errorMessage}`);

    if (!id && chunk.id) {
      id = chunk.id;
      model = chunk.model;
      created = chunk.created;
    }
    if (!systemFingerprint && typeof chunk.system_fingerprint === 'string' && chunk.system_fingerprint) {
      systemFingerprint = chunk.system_fingerprint;
    }
    if (!serviceTier && typeof chunk.service_tier === 'string' && chunk.service_tier) {
      serviceTier = chunk.service_tier;
    }
    if (chunk.usage) lastUsage = chunk.usage;
    captureExtras(chunk as unknown as Record<string, unknown>, KNOWN_CHUNK_KEYS, chunkExtras);

    for (const streamed of chunk.choices) {
      const choice = choices.get(streamed.index) ?? createChoiceAccumulator(streamed.index);
      choices.set(streamed.index, choice);
      captureExtras(streamed as unknown as Record<string, unknown>, KNOWN_CHOICE_KEYS, choice.choiceExtras);

      const delta = streamed.delta;
      captureExtras(delta as unknown as Record<string, unknown>, KNOWN_DELTA_KEYS, choice.messageExtras);
      if (typeof delta.content === 'string') choice.content += delta.content;
      if (typeof delta.reasoning_text === 'string') choice.reasoningText += delta.reasoning_text;
      if (typeof delta.reasoning_opaque === 'string') choice.reasoningOpaque = delta.reasoning_opaque;
      if (Array.isArray(delta.reasoning_items)) {
        choice.reasoningItems.push(...delta.reasoning_items);
      }
      accumulateToolCalls(choice, delta.tool_calls);
      if (streamed.finish_reason !== null) choice.finishReason = streamed.finish_reason;
    }
  }

  return {
    id,
    object: 'chat.completion',
    created,
    model,
    choices: [...choices.values()].toSorted((left, right) => left.index - right.index).map(finalizeChoice),
    ...(systemFingerprint ? { system_fingerprint: systemFingerprint } : {}),
    ...(serviceTier ? { service_tier: serviceTier } : {}),
    ...(lastUsage ? { usage: lastUsage } : {}),
    ...chunkExtras,
  } as ChatCompletionsResult;
}
