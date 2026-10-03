import { openaiChatCompletionsErrorPayloadMessage } from './errors.ts';
import type { OpenAIChatCompletionsChoiceNonStreaming, OpenAIChatCompletionsDelta, OpenAIChatCompletionsResult, OpenAIChatCompletionsStreamEvent, OpenAIChatCompletionsToolCall } from './index.ts';
import { FlowayOpenAIChatCompletionsReasoning } from './reasoning-format.ts';
import { mergeReasoningStreamItems, type ReasoningRecord } from './reasoning.ts';
import { captureExtras } from '../common/reassemble-extras.ts';

// Field-fidelity contract: every field an upstream emits must reach the
// non-streaming result. Known streaming fields use their protocol semantics;
// unknown fields fall through to captureExtras so future extensions survive.
const KNOWN_DELTA_KEYS = new Set(['content', 'role', 'reasoning', 'reasoning_content', 'reasoning_text', 'reasoning_opaque', 'reasoning_items', 'reasoning_details', 'thinking_blocks', 'refusal', 'tool_calls']);
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
  readonly rawReasoning: Record<string, unknown>;
  canonicalReasoning: boolean;
  canonicalReasoningText: string;
  canonicalReasoningOpaque?: string;
  refusal?: string;
  finishReason: OpenAIChatCompletionsChoiceNonStreaming['finish_reason'];
  readonly toolCalls: Map<number, ToolCallAccumulator>;
  readonly choiceExtras: Record<string, unknown>;
  readonly messageExtras: Record<string, unknown>;
}

const createChoiceAccumulator = (index: number): ChoiceAccumulator => ({
  index,
  content: '',
  rawReasoning: {},
  canonicalReasoning: false,
  canonicalReasoningText: '',
  finishReason: 'stop',
  toolCalls: new Map(),
  choiceExtras: {},
  messageExtras: {},
});

const isReasoningRecord = (value: unknown): value is ReasoningRecord => value !== null && typeof value === 'object' && !Array.isArray(value);

const accumulateRawReasoning = (choice: ChoiceAccumulator, delta: OpenAIChatCompletionsDelta): void => {
  const input = delta as Record<string, unknown>;
  for (const key of ['reasoning', 'reasoning_content', 'reasoning_text', 'reasoning_opaque', 'reasoning_items', 'reasoning_details', 'thinking_blocks'] as const) {
    if (!Object.hasOwn(input, key)) continue;
    const value = input[key];
    const previous = choice.rawReasoning[key];
    if (value == null && Object.hasOwn(choice.rawReasoning, key)) continue;
    if (key === 'reasoning' || key === 'reasoning_content' || key === 'reasoning_text') {
      choice.rawReasoning[key] = typeof previous === 'string' && typeof value === 'string' ? previous + value : value;
    } else if (Array.isArray(value)) {
      const prior = Array.isArray(previous) ? previous : [];
      choice.rawReasoning[key] = (key === 'reasoning_details' || key === 'thinking_blocks') && value.every(isReasoningRecord) && prior.every(isReasoningRecord)
        ? mergeReasoningStreamItems(prior, value, key === 'reasoning_details' ? 'openrouter-reasoning-details' : 'litellm-thinking-blocks')
        : [...prior, ...value];
    } else choice.rawReasoning[key] = value;
  }
};

const accumulateToolCalls = (choice: ChoiceAccumulator, value: OpenAIChatCompletionsDelta['tool_calls']): void => {
  if (value == null) return;

  for (const toolCall of value) {
    const fn = toolCall.function;
    const current = choice.toolCalls.get(toolCall.index) ?? { id: '', name: '', arguments: '' };
    if (toolCall.id !== undefined) current.id = toolCall.id;
    if (fn?.name !== undefined) current.name = fn.name;
    if (fn?.arguments !== undefined) current.arguments += fn.arguments;
    choice.toolCalls.set(toolCall.index, current);
  }
};

const finalizedToolCalls = (choice: ChoiceAccumulator): OpenAIChatCompletionsToolCall[] =>
  [...choice.toolCalls.entries()]
    .toSorted(([left], [right]) => left - right)
    .map(([, toolCall]) => ({
      id: toolCall.id,
      type: 'function',
      function: { name: toolCall.name, arguments: toolCall.arguments },
    }));

const finalizeChoice = (choice: ChoiceAccumulator): OpenAIChatCompletionsChoiceNonStreaming => {
  const toolCalls = finalizedToolCalls(choice);
  return {
    index: choice.index,
    message: {
      role: 'assistant',
      content: choice.content || null,
      ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      ...(choice.canonicalReasoning ? { [FlowayOpenAIChatCompletionsReasoning]: Object.freeze({ reasoning: choice.canonicalReasoningText, reasoning_opaque: choice.canonicalReasoningOpaque ?? '' }) } : {}),
      ...choice.rawReasoning,
      ...(choice.refusal !== undefined ? { refusal: choice.refusal } : {}),
      ...choice.messageExtras,
    },
    finish_reason: choice.finishReason,
    ...choice.choiceExtras,
  } as OpenAIChatCompletionsChoiceNonStreaming;
};

export async function reassembleOpenAIChatCompletionsEvents(chunks: AsyncIterable<OpenAIChatCompletionsStreamEvent>): Promise<OpenAIChatCompletionsResult> {
  let id = '';
  let model = '';
  let created = 0;
  let systemFingerprint: string | undefined;
  let serviceTier: OpenAIChatCompletionsResult['service_tier'];
  let lastUsage: OpenAIChatCompletionsResult['usage'] | undefined;
  const choices = new Map<number, ChoiceAccumulator>();
  const chunkExtras: Record<string, unknown> = {};

  for await (const chunk of chunks) {
    const errorMessage = openaiChatCompletionsErrorPayloadMessage(chunk);
    if (errorMessage) throw new Error(`Upstream OpenAI Chat Completions SSE error: ${errorMessage}`);

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
      const canonical = delta[FlowayOpenAIChatCompletionsReasoning];
      if (canonical !== undefined) {
        choice.canonicalReasoning = true;
        choice.canonicalReasoningText += canonical.reasoning;
        if (canonical.reasoning_opaque !== '') choice.canonicalReasoningOpaque = canonical.reasoning_opaque;
      }
      accumulateRawReasoning(choice, delta);
      if (typeof delta.refusal === 'string') choice.refusal = (choice.refusal ?? '') + delta.refusal;
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
  } as OpenAIChatCompletionsResult;
}
