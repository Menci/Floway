import { type ChatCompletionsReasoningDataStandard, type ChatCompletionsReasoningFormat, FlowayOpenAIChatCompletionsReasoning, type FlowayOpenAIChatCompletionsReasoningCarrier } from './reasoning-format.ts';
import { decodeReasoningData, encodeReasoningData } from '../common/reasoning-data.ts';

export const OPENROUTER_REASONING_OPAQUE_ID_PREFIX = 'floway-reasoning-opaque:';
export const REASONING_WIRE_FIELDS = ['reasoning_content', 'reasoning_text', 'reasoning', 'reasoning_opaque', 'reasoning_details', 'thinking_blocks', 'reasoning_items'] as const;
type ReasoningWireField = typeof REASONING_WIRE_FIELDS[number];
export type ReasoningRecord = Record<string, unknown>;

export interface ReasoningConversionWarning {
  readonly kind: 'unexpected-format' | 'overwriting-field';
  readonly channel: 'text' | 'data';
  readonly standard: string;
  readonly fields: readonly string[];
}

export interface ReasoningConversionOptions {
  readonly warn: (warning: ReasoningConversionWarning) => void;
  readonly stream?: { readonly previousOpaque: string };
}

export type FlowayReasoningMessage<T extends object> = Omit<T, ReasoningWireField> & FlowayOpenAIChatCompletionsReasoningCarrier;
export type WireReasoningMessage<T extends object> = Omit<T, ReasoningWireField | typeof FlowayOpenAIChatCompletionsReasoning> & {
  reasoning?: string;
  reasoning_text?: string;
  reasoning_content?: string;
  reasoning_opaque?: string;
  reasoning_details?: ReasoningRecord[];
  thinking_blocks?: ReasoningRecord[];
};

const TEXT_FIELDS = { 'reasoning-content': 'reasoning_content', 'reasoning-text': 'reasoning_text', reasoning: 'reasoning' } as const;
const DATA_FIELDS = { none: undefined, 'reasoning-opaque': 'reasoning_opaque', 'openrouter-reasoning-details': 'reasoning_details', 'litellm-thinking-blocks': 'thinking_blocks' } as const;
const TEXT_KEYS = ['reasoning_content', 'reasoning_text', 'reasoning'] as const;
const DATA_KEYS = ['reasoning_opaque', 'reasoning_details', 'thinking_blocks', 'reasoning_items'] as const;
const hasValue = (value: unknown): boolean => value !== undefined && value !== null && value !== '' && (!Array.isArray(value) || value.length !== 0);
const malformed = (path: string, expected: string): never => { throw new TypeError(`Malformed Chat Completions reasoning ${path}: expected ${expected}`); };
const record = (value: unknown, path: string): ReasoningRecord => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return malformed(path, 'an object');
  return value as ReasoningRecord;
};
const optionalString = (item: ReasoningRecord, key: string, path: string): void => {
  if (item[key] !== undefined && item[key] !== null && typeof item[key] !== 'string') malformed(`${path}.${key}`, 'a string or null');
};
const requiredString = (item: ReasoningRecord, key: string, path: string): void => {
  if (typeof item[key] !== 'string') malformed(`${path}.${key}`, 'a string');
};

// Keep complete wire records: adapter projections may discard metadata or
// variants that another client needs on the next turn.
// https://github.com/OpenRouterTeam/typescript-sdk/blob/f16baec106bbb191c22ba9fce058aa1f833fbbcc/src/models/reasoningdetailunion.ts
// https://github.com/BerriAI/litellm/blob/b370996b9d2fc9aaec356013a698711ee3e127cc/litellm/types/llms/openai.py
export const validateStructuredReasoning = (value: unknown, standard: 'openrouter-reasoning-details' | 'litellm-thinking-blocks'): ReasoningRecord[] => {
  if (!Array.isArray(value)) return malformed(DATA_FIELDS[standard], 'an array');
  return value.map((entry, index) => {
    const path = `${DATA_FIELDS[standard]}[${index}]`;
    const item = record(entry, path);
    if (standard === 'openrouter-reasoning-details') {
      optionalString(item, 'id', path);
      optionalString(item, 'format', path);
      if (item.index !== undefined && !Number.isInteger(item.index)) malformed(`${path}.index`, 'an integer');
      switch (item.type) {
      case 'reasoning.encrypted': requiredString(item, 'data', path); break;
      case 'reasoning.text': optionalString(item, 'text', path); optionalString(item, 'signature', path); break;
      case 'reasoning.summary': requiredString(item, 'summary', path); break;
      case 'reasoning.server_tool_call':
        requiredString(item, 'arguments', path); requiredString(item, 'result', path); requiredString(item, 'tool_name', path); optionalString(item, 'tool_call_id', path); break;
      default: malformed(`${path}.type`, 'a known OpenRouter reasoning type');
      }
    } else {
      switch (item.type) {
      case 'thinking': optionalString(item, 'thinking', path); optionalString(item, 'signature', path); break;
      case 'redacted_thinking': optionalString(item, 'data', path); break;
      default: malformed(`${path}.type`, 'thinking or redacted_thinking');
      }
    }
    return item;
  });
};

const isOwnedOpaqueItem = (items: readonly ReasoningRecord[], standard: ChatCompletionsReasoningDataStandard): string | undefined => {
  if (items.length !== 1) return undefined;
  const item = items[0];
  if (typeof item.data !== 'string') return undefined;
  if (standard === 'openrouter-reasoning-details'
    && item.type === 'reasoning.encrypted' && item.format === 'unknown'
    && typeof item.id === 'string' && item.id.startsWith(OPENROUTER_REASONING_OPAQUE_ID_PREFIX)
    && Object.keys(item).every(key => key === 'type' || key === 'data' || key === 'id' || key === 'format')) return item.data;
  if (standard === 'litellm-thinking-blocks' && item.type === 'redacted_thinking'
    && Object.keys(item).every(key => key === 'type' || key === 'data')) return item.data;
  return undefined;
};

const sameGroup = (left: ReasoningRecord, right: ReasoningRecord): boolean =>
  left.type === right.type && (left.id === right.id || left.id === undefined || right.id === undefined)
  && (left.index === right.index || left.index === undefined || right.index === undefined);

export const mergeReasoningStreamItems = (previous: readonly ReasoningRecord[], incoming: readonly ReasoningRecord[], standard: ChatCompletionsReasoningDataStandard): ReasoningRecord[] => {
  const merged = previous.map(item => ({ ...item }));
  for (const [incomingIndex, item] of incoming.entries()) {
    const last = incomingIndex === 0 ? merged.at(-1) : undefined;
    if (standard === 'openrouter-reasoning-details' && last !== undefined && sameGroup(last, item)
      && (item.type === 'reasoning.text' || item.type === 'reasoning.summary')) {
      const field = item.type === 'reasoning.text' ? 'text' : 'summary';
      const text = typeof item[field] === 'string' ? item[field] as string : '';
      const prefix = typeof last[field] === 'string' ? last[field] as string : '';
      Object.assign(last, Object.fromEntries(Object.entries(item).filter(([, value]) => value !== null && value !== undefined)), { [field]: prefix + text });
    } else if (standard === 'litellm-thinking-blocks' && last?.type === 'thinking' && item.type === 'thinking' && sameGroup(last, item)
      && (typeof last.signature !== 'string' || last.signature === item.signature)) {
      const text = typeof item.thinking === 'string' ? item.thinking : '';
      const prefix = typeof last.thinking === 'string' ? last.thinking : '';
      // Signed LiteLLM chunks may carry the full thinking snapshot.
      // https://github.com/BerriAI/litellm/blob/b370996b9d2fc9aaec356013a698711ee3e127cc/tests/unit/llms/anthropic/pass_through/adapters/test_streaming_iterator_first_delta.py#L559-L584
      Object.assign(last, item, { thinking: typeof item.signature === 'string' && text !== '' ? text : prefix + text });
    } else merged.push({ ...item });
  }
  return merged;
};

const readOpaque = (value: unknown, standard: ChatCompletionsReasoningDataStandard, previousOpaque: string | undefined): string => {
  if (value === undefined || value === null || standard === 'none') return '';
  if (standard === 'reasoning-opaque') {
    if (typeof value !== 'string') return malformed('reasoning_opaque', 'a string or null');
    decodeReasoningData(value);
    return value;
  }
  let items = validateStructuredReasoning(value, standard);
  const owned = previousOpaque === undefined || standard === 'openrouter-reasoning-details' ? isOwnedOpaqueItem(items, standard) : undefined;
  if (owned !== undefined) { decodeReasoningData(owned); return owned; }
  if (previousOpaque !== undefined && previousOpaque !== '') {
    const previous = decodeReasoningData(previousOpaque);
    if (previous?.type === standard) items = mergeReasoningStreamItems(validateStructuredReasoning(previous.value, standard), items, standard);
  }
  return encodeReasoningData(standard, items);
};

const copyWithoutReasoning = <T extends object>(message: T): Omit<T, ReasoningWireField | typeof FlowayOpenAIChatCompletionsReasoning> => {
  const copy = { ...message } as Record<PropertyKey, unknown>;
  for (const key of REASONING_WIRE_FIELDS) delete copy[key];
  delete copy[FlowayOpenAIChatCompletionsReasoning];
  return copy as Omit<T, ReasoningWireField | typeof FlowayOpenAIChatCompletionsReasoning>;
};

export const toFlowayOpenAIChatCompletionsReasoning = <T extends object>(message: T, format: ChatCompletionsReasoningFormat, options: ReasoningConversionOptions): FlowayReasoningMessage<T> => {
  const input = message as Record<PropertyKey, unknown>;
  if (input[FlowayOpenAIChatCompletionsReasoning] !== undefined) throw new TypeError('Chat Completions wire message already contains Floway reasoning');
  const textField = TEXT_FIELDS[format.text];
  const dataField = DATA_FIELDS[format.data];
  const textValue = input[textField];
  if (textValue !== undefined && textValue !== null && typeof textValue !== 'string') malformed(textField, 'a string or null');
  const text = typeof textValue === 'string' ? textValue : '';
  const opaque = readOpaque(dataField === undefined ? undefined : input[dataField], format.data, options.stream?.previousOpaque);
  if (!hasValue(textValue)) {
    const fields = TEXT_KEYS.filter(key => key !== textField && hasValue(input[key]));
    if (fields.length !== 0) options.warn({ kind: 'unexpected-format', channel: 'text', standard: format.text, fields });
  }
  if (dataField === undefined || !hasValue(input[dataField])) {
    const fields = DATA_KEYS.filter(key => key !== dataField && hasValue(input[key]));
    if (fields.length !== 0) options.warn({ kind: 'unexpected-format', channel: 'data', standard: format.data, fields });
  }
  const copy = copyWithoutReasoning(message) as FlowayReasoningMessage<T>;
  if (text !== '' || opaque !== '') Object.assign(copy, { [FlowayOpenAIChatCompletionsReasoning]: Object.freeze({ reasoning: text, reasoning_opaque: opaque }) });
  return copy;
};

export const fromFlowayOpenAIChatCompletionsReasoning = <T extends object>(message: T, format: ChatCompletionsReasoningFormat, options: ReasoningConversionOptions): WireReasoningMessage<T> => {
  const reasoning = (message as FlowayOpenAIChatCompletionsReasoningCarrier)[FlowayOpenAIChatCompletionsReasoning];
  if (reasoning === undefined) return message as WireReasoningMessage<T>;
  const textField = TEXT_FIELDS[format.text];
  const dataField = DATA_FIELDS[format.data];
  const input = message as Record<string, unknown>;
  if (Object.hasOwn(input, textField)) options.warn({ kind: 'overwriting-field', channel: 'text', standard: format.text, fields: [textField] });
  if (dataField !== undefined && Object.hasOwn(input, dataField)) options.warn({ kind: 'overwriting-field', channel: 'data', standard: format.data, fields: [dataField] });
  const output = copyWithoutReasoning(message) as Record<string, unknown>;
  if (reasoning.reasoning !== '') output[textField] = reasoning.reasoning;
  if (reasoning.reasoning_opaque !== '' && dataField !== undefined && format.data !== 'none') {
    if (format.data === 'reasoning-opaque') output[dataField] = reasoning.reasoning_opaque;
    else {
      const envelope = decodeReasoningData(reasoning.reasoning_opaque);
      if (envelope?.type === format.data) output[dataField] = validateStructuredReasoning(envelope.value, format.data);
      else if (format.data === 'openrouter-reasoning-details') {
        // A fixed ID makes the OpenRouter adapter deduplicate different messages.
        // https://github.com/OpenRouterTeam/ai-sdk-provider/blob/1b22b05352cb0f9243a6c3fdd326038dd3705544/src/utils/reasoning-details-duplicate-tracker.ts#L45
        output[dataField] = [{ type: 'reasoning.encrypted', data: reasoning.reasoning_opaque, id: OPENROUTER_REASONING_OPAQUE_ID_PREFIX + crypto.randomUUID(), format: 'unknown' }];
      } else output[dataField] = [{ type: 'redacted_thinking', data: reasoning.reasoning_opaque }];
    }
  }
  return output as WireReasoningMessage<T>;
};
