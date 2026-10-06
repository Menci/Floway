import { openaiChatCompletionsErrorPayloadMessage } from './errors.ts';
import type { OpenAIChatCompletionsChoiceNonStreaming, OpenAIChatCompletionsDelta, OpenAIChatCompletionsAssistantDeltaEx, OpenAIChatCompletionsResult, OpenAIChatCompletionsStreamEvent, OpenAIChatCompletionsReasoningItem, OpenAIChatCompletionsToolCall, OpenAIChatCompletionsAudio, OpenAIChatCompletionsLogprobs } from './index.ts';
import { captureExtras } from '../common/reassemble-extras.ts';

// Field-fidelity contract: every field an upstream emits must reach the
// non-streaming result. Known streaming fields use their protocol semantics;
// unknown fields fall through to captureExtras so future extensions survive.
const KNOWN_DELTA_KEYS = new Set(['audio', 'function_call', 'content', 'role', 'reasoning_text', 'reasoning_opaque', 'reasoning_items', 'refusal', 'tool_calls']);
const KNOWN_CHOICE_KEYS = new Set(['index', 'delta', 'finish_reason', 'logprobs']);
const KNOWN_CHUNK_KEYS = new Set(['id', 'object', 'created', 'model', 'choices', 'usage', 'system_fingerprint', 'service_tier']);

interface ToolCallAccumulator {
  id: string;
  name: string;
  arguments: string;
  type: 'function' | 'custom';
  extras: Record<string, unknown>;
}

interface ChoiceAccumulator {
  readonly index: number;
  content: string;
  reasoningText: string;
  audio?: Partial<OpenAIChatCompletionsAudio>;
  functionCall?: { name: string; arguments: string };
  logprobs?: OpenAIChatCompletionsLogprobs;
  reasoningOpaque?: string;
  refusal?: string;
  readonly reasoningItems: OpenAIChatCompletionsReasoningItem[];
  finishReason: OpenAIChatCompletionsChoiceNonStreaming['finish_reason'];
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

const accumulateToolCalls = (choice: ChoiceAccumulator, value: OpenAIChatCompletionsDelta['tool_calls']): void => {
  if (value == null) return;

  for (const toolCall of value) {
    const fn = toolCall.function;
    const custom = toolCall.custom;
    const current = choice.toolCalls.get(toolCall.index) ?? { id: '', name: '', arguments: '', type: 'function', extras: {} };
    if (toolCall.id !== undefined) current.id = toolCall.id;
    if (fn?.name !== undefined) current.name = fn.name;
    if (fn?.arguments !== undefined) current.arguments += fn.arguments;
    if (custom?.name !== undefined) current.name = custom.name;
    if (custom?.input !== undefined) current.arguments += custom.input;
    if (toolCall.type !== undefined) current.type = toolCall.type;
    captureExtras(toolCall as unknown as Record<string, unknown>, new Set(['index', 'id', 'type', 'function', 'custom']), current.extras);
    choice.toolCalls.set(toolCall.index, current);
  }
};

const finalizedToolCalls = (choice: ChoiceAccumulator): OpenAIChatCompletionsToolCall[] =>
  [...choice.toolCalls.entries()]
    .toSorted(([left], [right]) => left - right)
    .map(([, toolCall]): OpenAIChatCompletionsToolCall => ({
      ...toolCall.extras,
      id: toolCall.id,
      ...(toolCall.type === 'custom'
        ? { type: 'custom', custom: { name: toolCall.name, input: toolCall.arguments } }
        : { type: 'function', function: { name: toolCall.name, arguments: toolCall.arguments } }),
    }));

// Native audio chunks concatenate data/transcript and finish with an expiry-only delta.
// https://github.com/openai/openai-node/blob/7423ac3e9351c46300cd094479cded5551a72eb4/src/lib/ChatCompletionStream.ts#L1975-L2020
const accumulateAudio = (choice: ChoiceAccumulator, delta: OpenAIChatCompletionsDelta['audio']): void => {
  if (delta == null) return;
  const audio = choice.audio ??= {};
  if (delta.id !== undefined) audio.id = delta.id;
  if (delta.expires_at !== undefined) audio.expires_at = delta.expires_at;
  if (delta.data !== undefined) audio.data = (audio.data ?? '') + delta.data;
  if (delta.transcript !== undefined) audio.transcript = (audio.transcript ?? '') + delta.transcript;
};

const completeAudio = (audio: Partial<OpenAIChatCompletionsAudio>): OpenAIChatCompletionsAudio => {
  if (audio.id === undefined || audio.data === undefined || audio.transcript === undefined || audio.expires_at === undefined) throw new TypeError('Upstream Chat Completions audio ended without its complete metadata.');
  return audio as OpenAIChatCompletionsAudio;
};

const finalizeChoice = (choice: ChoiceAccumulator): OpenAIChatCompletionsChoiceNonStreaming => {
  const toolCalls = finalizedToolCalls(choice);
  return {
    index: choice.index,
    logprobs: choice.logprobs ?? null,
    message: {
      role: 'assistant',
      content: choice.content || null,
      refusal: choice.refusal ?? null,
      ...(choice.audio === undefined ? {} : { audio: completeAudio(choice.audio) }),
      ...(choice.functionCall === undefined ? {} : { function_call: choice.functionCall }),
      ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      ...(choice.reasoningText ? { reasoning_text: choice.reasoningText } : {}),
      ...(choice.reasoningOpaque !== undefined ? { reasoning_opaque: choice.reasoningOpaque } : {}),
      ...(choice.reasoningItems.length > 0 ? { reasoning_items: choice.reasoningItems } : {}),
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

      const delta = streamed.delta as OpenAIChatCompletionsAssistantDeltaEx;
      captureExtras(delta as unknown as Record<string, unknown>, KNOWN_DELTA_KEYS, choice.messageExtras);
      if (typeof delta.content === 'string') choice.content += delta.content;
      if (typeof delta.reasoning_text === 'string') choice.reasoningText += delta.reasoning_text;
      if (typeof delta.reasoning_opaque === 'string') choice.reasoningOpaque = delta.reasoning_opaque;
      if (typeof delta.refusal === 'string') choice.refusal = (choice.refusal ?? '') + delta.refusal;
      if (Array.isArray(delta.reasoning_items)) {
        choice.reasoningItems.push(...delta.reasoning_items as OpenAIChatCompletionsReasoningItem[]);
      }
      if (delta.function_call !== undefined) {
        const call = choice.functionCall ??= { name: '', arguments: '' };
        if (delta.function_call.name !== undefined) call.name = delta.function_call.name;
        if (delta.function_call.arguments !== undefined) call.arguments += delta.function_call.arguments;
      }
      if (streamed.logprobs != null) {
        const logprobs = choice.logprobs ??= { content: null, refusal: null };
        if (streamed.logprobs.content != null) (logprobs.content ??= []).push(...streamed.logprobs.content);
        if (streamed.logprobs.refusal != null) (logprobs.refusal ??= []).push(...streamed.logprobs.refusal);
      }
      accumulateToolCalls(choice, delta.tool_calls);
      accumulateAudio(choice, delta.audio);
      if (streamed.finish_reason != null) choice.finishReason = streamed.finish_reason;
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
