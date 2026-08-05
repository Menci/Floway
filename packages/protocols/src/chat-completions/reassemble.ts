import { chatCompletionsErrorPayloadMessage } from './errors.ts';
import type { ChatCompletionsChoiceNonStreaming, ChatCompletionsDelta, ChatCompletionsResult, ChatCompletionsStreamEvent, ChatCompletionsReasoningItem, ChatCompletionsToolCall } from './index.ts';
import { isOpenAIUsageOnlyEventShape } from '../common/openai-stream.ts';
import { captureExtras } from '../common/reassemble-extras.ts';

// Field-fidelity contract: every field an upstream emits must reach the
// non-streaming result. Known streaming fields use their protocol semantics;
// unknown fields fall through to captureExtras so future extensions survive.
const KNOWN_DELTA_KEYS = new Set(['content', 'role', 'reasoning_text', 'reasoning_opaque', 'reasoning_items', 'refusal', 'tool_calls']);
const KNOWN_CHOICE_KEYS = new Set(['index', 'delta', 'finish_reason']);
const KNOWN_CHUNK_KEYS = new Set(['id', 'object', 'created', 'model', 'choices', 'usage', 'system_fingerprint', 'service_tier']);

interface ToolCallAccumulator {
  id?: string;
  name?: string;
  arguments: string;
}

interface ChoiceAccumulator {
  readonly index: number;
  content: string;
  sawContent: boolean;
  reasoningText: string;
  sawReasoningText: boolean;
  reasoningOpaque?: string;
  refusal?: string;
  readonly reasoningItems: ChatCompletionsReasoningItem[];
  finishReason: ChatCompletionsChoiceNonStreaming['finish_reason'] | null;
  readonly toolCalls: Map<number, ToolCallAccumulator>;
  readonly choiceExtras: Record<string, unknown>;
  readonly messageExtras: Record<string, unknown>;
}

const createChoiceAccumulator = (index: number): ChoiceAccumulator => ({
  index,
  content: '',
  sawContent: false,
  reasoningText: '',
  sawReasoningText: false,
  reasoningItems: [],
  finishReason: null,
  toolCalls: new Map(),
  choiceExtras: {},
  messageExtras: {},
});

const accumulateToolCalls = (choice: ChoiceAccumulator, value: ChatCompletionsDelta['tool_calls']): void => {
  if (value == null) return;

  for (const toolCall of value) {
    if (!Number.isSafeInteger(toolCall.index) || toolCall.index < 0) {
      throw new RangeError(`Chat Completions tool call index must be a non-negative safe integer: ${toolCall.index}`);
    }
    const fn = toolCall.function;
    const current = choice.toolCalls.get(toolCall.index) ?? { arguments: '' };
    if (toolCall.id !== undefined) current.id = toolCall.id;
    if (fn?.name !== undefined) current.name = fn.name;
    if (fn?.arguments !== undefined) current.arguments += fn.arguments;
    choice.toolCalls.set(toolCall.index, current);
  }
};

const finalizedToolCalls = (choice: ChoiceAccumulator): ChatCompletionsToolCall[] =>
  [...choice.toolCalls.entries()]
    .toSorted(([left], [right]) => left - right)
    .map(([index, toolCall]) => {
      if (toolCall.id === undefined || toolCall.name === undefined) {
        throw new Error(`Chat Completions tool call ${index} ended without ${toolCall.id === undefined ? 'id' : 'function.name'}`);
      }
      return {
        id: toolCall.id,
        type: 'function' as const,
        function: { name: toolCall.name, arguments: toolCall.arguments },
      };
    });

const finalizeChoice = (choice: ChoiceAccumulator): ChatCompletionsChoiceNonStreaming => {
  if (choice.finishReason === null) throw new Error(`Chat Completions choice ${choice.index} ended without finish_reason`);
  const toolCalls = finalizedToolCalls(choice);
  return {
    index: choice.index,
    message: {
      role: 'assistant',
      content: choice.sawContent ? choice.content : null,
      ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      ...(choice.sawReasoningText ? { reasoning_text: choice.reasoningText } : {}),
      ...(choice.reasoningOpaque !== undefined ? { reasoning_opaque: choice.reasoningOpaque } : {}),
      ...(choice.reasoningItems.length > 0 ? { reasoning_items: choice.reasoningItems } : {}),
      ...(choice.refusal !== undefined ? { refusal: choice.refusal } : {}),
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
  let systemFingerprint: ChatCompletionsResult['system_fingerprint'];
  let systemFingerprintObserved = false;
  let serviceTier: ChatCompletionsResult['service_tier'];
  let serviceTierObserved = false;
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
    if ('system_fingerprint' in chunk && (!systemFingerprintObserved || systemFingerprint === null)) {
      if (chunk.system_fingerprint !== null && typeof chunk.system_fingerprint !== 'string') throw new TypeError('Chat Completions system_fingerprint must be a string or null');
      systemFingerprint = chunk.system_fingerprint;
      systemFingerprintObserved = true;
    }
    if ('service_tier' in chunk && (!serviceTierObserved || serviceTier === null)) {
      if (chunk.service_tier !== null && typeof chunk.service_tier !== 'string') throw new TypeError('Chat Completions service_tier must be a string or null');
      serviceTier = chunk.service_tier;
      serviceTierObserved = true;
    }
    if (chunk.usage) lastUsage = chunk.usage;
    captureExtras(chunk as unknown as Record<string, unknown>, KNOWN_CHUNK_KEYS, chunkExtras);
    if (isOpenAIUsageOnlyEventShape(chunk)) continue;

    for (const streamed of chunk.choices) {
      if (!Number.isSafeInteger(streamed.index) || streamed.index < 0) {
        throw new RangeError(`Chat Completions choice index must be a non-negative safe integer: ${streamed.index}`);
      }
      const choice = choices.get(streamed.index) ?? createChoiceAccumulator(streamed.index);
      if (choice.finishReason !== null) throw new Error(`Chat Completions choice ${streamed.index} emitted data after finish_reason`);
      choices.set(streamed.index, choice);
      captureExtras(streamed as unknown as Record<string, unknown>, KNOWN_CHOICE_KEYS, choice.choiceExtras);

      const delta = streamed.delta;
      if (typeof delta !== 'object' || delta === null || Array.isArray(delta)) throw new TypeError(`Chat Completions choice ${streamed.index} delta must be an object`);
      captureExtras(delta as unknown as Record<string, unknown>, KNOWN_DELTA_KEYS, choice.messageExtras);
      if (typeof delta.content === 'string') {
        choice.content += delta.content;
        choice.sawContent = true;
      }
      if (typeof delta.reasoning_text === 'string') {
        choice.reasoningText += delta.reasoning_text;
        choice.sawReasoningText = true;
      }
      if (typeof delta.reasoning_opaque === 'string') choice.reasoningOpaque = delta.reasoning_opaque;
      if (typeof delta.refusal === 'string') choice.refusal = (choice.refusal ?? '') + delta.refusal;
      if (Array.isArray(delta.reasoning_items)) {
        choice.reasoningItems.push(...delta.reasoning_items);
      }
      accumulateToolCalls(choice, delta.tool_calls);
      if (streamed.finish_reason !== null && streamed.finish_reason !== undefined) {
        if (typeof streamed.finish_reason !== 'string') throw new TypeError(`Chat Completions choice ${streamed.index} finish_reason must be a string or null`);
        choice.finishReason = streamed.finish_reason;
      }
    }
  }

  return {
    id,
    object: 'chat.completion',
    created,
    model,
    choices: [...choices.values()].toSorted((left, right) => left.index - right.index).map(finalizeChoice),
    ...(systemFingerprintObserved ? { system_fingerprint: systemFingerprint } : {}),
    ...(serviceTierObserved ? { service_tier: serviceTier } : {}),
    ...(lastUsage ? { usage: lastUsage } : {}),
    ...chunkExtras,
  } as ChatCompletionsResult;
}
