import { openaiChatCompletionsErrorPayloadMessage } from './errors.ts';
import { OPENAI_CHAT_COMPLETIONS_ASSISTANT_FIELDS, OPENAI_CHAT_COMPLETIONS_TOOL_CALL_FIELDS, accumulateOpenAIChatCompletionsExtension, createOpenAIChatCompletionsExtensionAccumulator, finalizeOpenAIChatCompletionsExtensions, type OpenAIChatCompletionsExtensionAccumulator } from './extensions.ts';
import type { OpenAIChatCompletionsChoiceNonStreaming, OpenAIChatCompletionsDelta, OpenAIChatCompletionsAssistantDeltaEx, OpenAIChatCompletionsResult, OpenAIChatCompletionsStreamEvent, OpenAIChatCompletionsToolCall, OpenAIChatCompletionsAudio, OpenAIChatCompletionsLogprobs, OpenAIChatCompletionsAssistantOutputMessageEx, OpenAIChatCompletionsAnnotation } from './index.ts';
import { accumulateOpenAIChatCompletionsPrivate, finalizeOpenAIChatCompletionsPrivate, OpenAIChatCompletionsAssistantMessagePrivate, type OpenAIChatCompletionsPrivateDraft } from './private.ts';
import { captureExtras } from '../common/reassemble-extras.ts';

const KNOWN_CHOICE_KEYS = new Set(['index', 'delta', 'finish_reason', 'logprobs']);
const KNOWN_CHUNK_KEYS = new Set(['id', 'object', 'created', 'model', 'choices', 'usage', 'system_fingerprint', 'service_tier']);

interface ToolCallAccumulator {
  id: string;
  name: string;
  arguments: string;
  type: 'function' | 'custom';
  extensions: OpenAIChatCompletionsExtensionAccumulator;
}

interface ChoiceAccumulator {
  readonly index: number;
  content?: string;
  audio?: Partial<OpenAIChatCompletionsAudio>;
  functionCall?: { name: string; arguments: string };
  logprobs?: OpenAIChatCompletionsLogprobs;
  annotations?: OpenAIChatCompletionsAnnotation[];
  refusal?: string;
  finishReason: OpenAIChatCompletionsChoiceNonStreaming['finish_reason'];
  readonly toolCalls: Map<number, ToolCallAccumulator>;
  readonly choiceExtras: Record<string, unknown>;
  readonly extensions: OpenAIChatCompletionsExtensionAccumulator;
  readonly private: OpenAIChatCompletionsPrivateDraft;
}

const createChoiceAccumulator = (index: number): ChoiceAccumulator => ({
  index,
  finishReason: 'stop',
  toolCalls: new Map(),
  choiceExtras: {},
  extensions: createOpenAIChatCompletionsExtensionAccumulator('assistant'),
  private: {},
});

const accumulateToolCalls = (choice: ChoiceAccumulator, value: OpenAIChatCompletionsDelta['tool_calls']): void => {
  if (value == null) return;

  for (const toolCall of value) {
    const fn = toolCall.function;
    const custom = toolCall.custom;
    const current = choice.toolCalls.get(toolCall.index) ?? { id: '', name: '', arguments: '', type: 'function', extensions: createOpenAIChatCompletionsExtensionAccumulator('tool') };
    if (toolCall.id !== undefined) current.id = toolCall.id;
    if (fn?.name !== undefined) current.name = fn.name;
    if (fn?.arguments !== undefined) current.arguments += fn.arguments;
    if (custom?.name !== undefined) current.name = custom.name;
    if (custom?.input !== undefined) current.arguments += custom.input;
    if (toolCall.type !== undefined) current.type = toolCall.type;
    for (const [field, value] of Object.entries(toolCall)) {
      if (!OPENAI_CHAT_COMPLETIONS_TOOL_CALL_FIELDS.has(field)) accumulateOpenAIChatCompletionsExtension(current.extensions, field, value);
    }
    choice.toolCalls.set(toolCall.index, current);
  }
};

const finalizedToolCalls = (choice: ChoiceAccumulator): OpenAIChatCompletionsToolCall[] =>
  [...choice.toolCalls.entries()]
    .toSorted(([left], [right]) => left - right)
    .map(([, toolCall]): OpenAIChatCompletionsToolCall => ({
      ...finalizeOpenAIChatCompletionsExtensions(toolCall.extensions),
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
  const privateValue = finalizeOpenAIChatCompletionsPrivate(choice.private);
  const message: OpenAIChatCompletionsAssistantOutputMessageEx = {
    role: 'assistant',
    content: choice.content ?? null,
    refusal: choice.refusal ?? null,
    ...(choice.annotations === undefined ? {} : { annotations: choice.annotations }),
    ...(choice.audio === undefined ? {} : { audio: completeAudio(choice.audio) }),
    ...(choice.functionCall === undefined ? {} : { function_call: choice.functionCall }),
    ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
    ...finalizeOpenAIChatCompletionsExtensions(choice.extensions),
    ...(privateValue === undefined ? {} : { [OpenAIChatCompletionsAssistantMessagePrivate]: privateValue }),
  };
  return {
    index: choice.index,
    logprobs: choice.logprobs ?? null,
    message,
    finish_reason: choice.finishReason,
    ...choice.choiceExtras,
  };
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
      for (const [field, value] of Object.entries(delta)) {
        if (!OPENAI_CHAT_COMPLETIONS_ASSISTANT_FIELDS.has(field)) accumulateOpenAIChatCompletionsExtension(choice.extensions, field, value);
      }
      const privateDelta = delta[OpenAIChatCompletionsAssistantMessagePrivate];
      if (privateDelta !== undefined) accumulateOpenAIChatCompletionsPrivate(choice.private, privateDelta);
      if (typeof delta.content === 'string') choice.content = (choice.content ?? '') + delta.content;
      if (typeof delta.refusal === 'string') choice.refusal = (choice.refusal ?? '') + delta.refusal;
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
      if (delta.annotations !== undefined) choice.annotations = delta.annotations;
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
