// Official SDK wire declarations.
// https://github.com/openai/openai-node/blob/7423ac3e9351c46300cd094479cded5551a72eb4/src/resources/shared.ts

export type ChatModel = 'gpt-6-astra' | 'gpt-6.1-sol' | 'gpt-6-sol' | 'gpt-6-luna' | 'gpt-5.6-sol' | 'gpt-5.6-terra' | 'gpt-5.6-luna' | 'gpt-5.5' | 'gpt-5.5-2026-04-23' | 'gpt-5.4' | 'gpt-5.4-mini' | 'gpt-5.4-nano' | 'gpt-5.4-mini-2026-03-17' | 'gpt-5.4-nano-2026-03-17' | 'gpt-5.3-chat-latest' | 'gpt-5.2' | 'gpt-5.2-2025-12-11' | 'gpt-5.2-chat-latest' | 'gpt-5.2-pro' | 'gpt-5.2-pro-2025-12-11' | 'gpt-5.1' | 'gpt-5.1-2025-11-13' | 'gpt-5.1-codex' | 'gpt-5.1-mini' | 'gpt-5.1-chat-latest' | 'gpt-5' | 'gpt-5-mini' | 'gpt-5-nano' | 'gpt-5-2025-08-07' | 'gpt-5-mini-2025-08-07' | 'gpt-5-nano-2025-08-07' | 'gpt-5-chat-latest' | 'gpt-4.1' | 'gpt-4.1-mini' | 'gpt-4.1-nano' | 'gpt-4.1-2025-04-14' | 'gpt-4.1-mini-2025-04-14' | 'gpt-4.1-nano-2025-04-14' | 'o4-mini' | 'o4-mini-2025-04-16' | 'o3' | 'o3-2025-04-16' | 'o3-mini' | 'o3-mini-2025-01-31' | 'o1' | 'o1-2024-12-17' | 'o1-preview' | 'o1-preview-2024-09-12' | 'o1-mini' | 'o1-mini-2024-09-12' | 'gpt-4o' | 'gpt-4o-2024-11-20' | 'gpt-4o-2024-08-06' | 'gpt-4o-2024-05-13' | 'gpt-audio-mini' | 'gpt-audio-mini-2025-12-15' | 'gpt-4o-audio-preview' | 'gpt-4o-audio-preview-2024-10-01' | 'gpt-4o-audio-preview-2024-12-17' | 'gpt-4o-audio-preview-2025-06-03' | 'gpt-4o-mini-audio-preview' | 'gpt-4o-mini-audio-preview-2024-12-17' | 'gpt-4o-search-preview' | 'gpt-4o-mini-search-preview' | 'gpt-4o-search-preview-2025-03-11' | 'gpt-4o-mini-search-preview-2025-03-11' | 'chatgpt-4o-latest' | 'codex-mini-latest' | 'gpt-4o-mini' | 'gpt-4o-mini-2024-07-18' | 'gpt-4-turbo' | 'gpt-4-turbo-2024-04-09' | 'gpt-4-0125-preview' | 'gpt-4-turbo-preview' | 'gpt-4-1106-preview' | 'gpt-4-vision-preview' | 'gpt-4' | 'gpt-4-0314' | 'gpt-4-0613' | 'gpt-4-32k' | 'gpt-4-32k-0314' | 'gpt-4-32k-0613' | 'gpt-3.5-turbo' | 'gpt-3.5-turbo-16k' | 'gpt-3.5-turbo-0301' | 'gpt-3.5-turbo-0613' | 'gpt-3.5-turbo-1106' | 'gpt-3.5-turbo-0125' | 'gpt-3.5-turbo-16k-0613';

export interface ComparisonFilter {
  key: string;
  type: 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte' | 'in' | 'nin';
  value: string | number | boolean | Array<string | number>;
}

export interface CompoundFilter {
  filters: Array<ComparisonFilter | unknown>;
  type: 'and' | 'or';
}

export type CustomToolInputFormat = CustomToolInputFormat.Text | CustomToolInputFormat.Grammar;

export namespace CustomToolInputFormat {
  export interface Text {
    type: 'text';
  }
  export interface Grammar {
    definition: string;
    syntax: 'lark' | 'regex';
    type: 'grammar';
  }
}

export interface FunctionDefinition {
  name: string;
  description?: string;
  parameters?: FunctionParameters;
  strict?: boolean | null;
}

export type FunctionParameters = {
  [key: string]: unknown;
};

export type Metadata = {
  [key: string]: string;
};

export interface Reasoning {
  context?: 'auto' | 'current_turn' | 'all_turns' | null;
  effort?: ReasoningEffort | null;
  generate_summary?: 'auto' | 'concise' | 'detailed' | null;
  mode?: (string & {}) | 'standard' | 'pro';
  summary?: 'auto' | 'concise' | 'detailed' | null;
}

export type ReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | null;

export interface ResponseFormatJSONObject {
  type: 'json_object';
}

export interface ResponseFormatJSONSchema {
  json_schema: ResponseFormatJSONSchema.JSONSchema;
  type: 'json_schema';
}

export namespace ResponseFormatJSONSchema {
  export interface JSONSchema {
    name: string;
    description?: string;
    schema?: {
      [key: string]: unknown;
    };
    strict?: boolean | null;
  }
}

export interface ResponseFormatText {
  type: 'text';
}

export type ResponsesModel = (string & {}) | ChatModel | 'o1-pro' | 'o1-pro-2025-03-19' | 'o3-pro' | 'o3-pro-2025-06-10' | 'o3-deep-research' | 'o3-deep-research-2025-06-26' | 'o4-mini-deep-research' | 'o4-mini-deep-research-2025-06-26' | 'computer-use-preview' | 'computer-use-preview-2025-03-11' | 'gpt-5.5-pro' | 'gpt-5.5-pro-2026-04-23' | 'gpt-5-codex' | 'gpt-5-pro' | 'gpt-5-pro-2025-10-06' | 'gpt-5.1-codex-max' | 'gpt-daybreak-blue-latest' | 'gpt-daybreak-red-latest' | 'gpt-5.6-cyber' | 'gpt-rosalind-research';
