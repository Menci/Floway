import { OPENAI_CHAT_COMPLETIONS_REASONING_TEXT_FIELDS } from './private.ts';
import { accumulateOpenAIChatCompletionsReasoningDetails } from './reasoning-details.ts';

// Assistant output fields include native streamed audio; annotation deltas are a compatible transport of a standard message field.
// https://github.com/openai/openai-node/blob/7423ac3e9351c46300cd094479cded5551a72eb4/src/resources/chat/completions/completions.ts#L1804-L1843
// https://github.com/openai/openai-openapi/blob/d4068fc0091867f62e2caca8f3d8692848c24590/openapi.yaml#L42329-L42377
export const OPENAI_CHAT_COMPLETIONS_ASSISTANT_FIELDS = new Set(['role', 'content', 'tool_calls', 'refusal', 'audio', 'annotations', 'function_call']);
// Tool index identifies a streamed call; custom and function are the standard payload variants.
// https://github.com/openai/openai-node/blob/7423ac3e9351c46300cd094479cded5551a72eb4/src/resources/chat/completions/completions.ts#L1911-L1963
export const OPENAI_CHAT_COMPLETIONS_TOOL_CALL_FIELDS = new Set(['id', 'type', 'function', 'custom', 'index']);

const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

export const setOpenAIChatCompletionsField = (target: object, field: string, value: unknown): void => {
  Object.defineProperty(target, field, { value, enumerable: true, writable: true, configurable: true });
};

export interface OpenAIChatCompletionsExtensionAccumulator {
  readonly scope: 'assistant' | 'tool';
  readonly fields: Record<string, unknown>;
  citations?: unknown[];
}

export const createOpenAIChatCompletionsExtensionAccumulator = (scope: OpenAIChatCompletionsExtensionAccumulator['scope']): OpenAIChatCompletionsExtensionAccumulator => ({ scope, fields: {} });

// A nonempty signature closes thinking; redacted entries form boundaries. Unsigned/empty entries survive EOF.
// https://github.com/BerriAI/litellm/blob/cad87a900fbe8b99eba258e6ebb23f58225a8002/litellm/litellm_core_utils/streaming_chunk_builder_utils.py#L699-L738
const accumulateThinkingBlocks = (blocks: unknown[], incoming: unknown[]): void => {
  for (const value of incoming) {
    const previous = blocks.at(-1);
    if (record(value) && value.type === 'thinking' && record(previous) && previous.type === 'thinking'
      && !(typeof previous.signature === 'string' && previous.signature.length > 0)
      && typeof previous.thinking === 'string' && typeof value.thinking === 'string') {
      previous.thinking += value.thinking;
      for (const [field, data] of Object.entries(value)) if (field !== 'thinking') setOpenAIChatCompletionsField(previous, field, data);
    } else blocks.push(record(value) ? { ...value } : value);
  }
};

// LiteLLM collects assistant citation fragments separately; an explicit plural snapshot takes precedence at completion.
// Tool provider dictionaries use only shallow key replacement.
// https://github.com/BerriAI/litellm/blob/cad87a900fbe8b99eba258e6ebb23f58225a8002/litellm/main.py#L9199-L9231
// https://github.com/BerriAI/litellm/blob/cad87a900fbe8b99eba258e6ebb23f58225a8002/litellm/litellm_core_utils/streaming_chunk_builder_utils.py#L572-L600
const accumulateProviderFields = (state: OpenAIChatCompletionsExtensionAccumulator, value: unknown): void => {
  if (!record(value)) {
    setOpenAIChatCompletionsField(state.fields, 'provider_specific_fields', value);
    delete state.citations;
    return;
  }
  const previous = state.fields.provider_specific_fields;
  const fields = record(previous) ? previous : {};
  for (const [key, data] of Object.entries(value)) {
    if (state.scope === 'assistant' && key === 'citation') (state.citations ??= []).push(data);
    else setOpenAIChatCompletionsField(fields, key, data);
  }
  setOpenAIChatCompletionsField(state.fields, 'provider_specific_fields', fields);
};

// Unknown extensions are complete values; only documented fragmented fields receive specialized aggregation.
// https://github.com/openai/openai-node/blob/7423ac3e9351c46300cd094479cded5551a72eb4/src/lib/ChatCompletionStream.ts#L1975-L1984
export const accumulateOpenAIChatCompletionsExtension = (state: OpenAIChatCompletionsExtensionAccumulator, field: string, value: unknown): void => {
  const previous = Object.hasOwn(state.fields, field) ? state.fields[field] : undefined;
  if (state.scope === 'assistant' && (OPENAI_CHAT_COMPLETIONS_REASONING_TEXT_FIELDS as readonly string[]).includes(field) && typeof value === 'string') {
    setOpenAIChatCompletionsField(state.fields, field, (typeof previous === 'string' ? previous : '') + value);
  } else if (field === 'provider_specific_fields') accumulateProviderFields(state, value);
  else if (state.scope === 'assistant' && field === 'thinking_blocks' && Array.isArray(value)) {
    const blocks = Array.isArray(previous) ? previous : [];
    accumulateThinkingBlocks(blocks, value);
    setOpenAIChatCompletionsField(state.fields, field, blocks);
  } else if (state.scope === 'assistant' && field === 'reasoning_details' && Array.isArray(value)) {
    const details = Array.isArray(previous) ? previous : [];
    accumulateOpenAIChatCompletionsReasoningDetails(details, value);
    setOpenAIChatCompletionsField(state.fields, field, details);
  } else setOpenAIChatCompletionsField(state.fields, field, value);
};

export const finalizeOpenAIChatCompletionsExtensions = (state: OpenAIChatCompletionsExtensionAccumulator): Record<string, unknown> => {
  const fields = state.fields.provider_specific_fields;
  if (record(fields) && state.citations !== undefined && !Object.hasOwn(fields, 'citations')) {
    setOpenAIChatCompletionsField(fields, 'citations', state.citations.every(Array.isArray) ? state.citations : [state.citations]);
  }
  return state.fields;
};
