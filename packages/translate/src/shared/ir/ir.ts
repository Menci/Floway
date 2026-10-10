// All
export type IRJSONValue = null | boolean | number | string | IRJSONValue[] | IRJSONObject;

// All
export type IRJSONObject = { [key: string]: IRJSONValue };

// All
export type IRProtocol = 'openaiChatCompletions' | 'openaiResponses' | 'anthropicMessages' | 'geminiGenerateContent';

// All
export interface IR {
  choices: IRChoice[]; // All
  usage?: IRUsage; // All
  extensions?: Partial<Record<IRProtocol, IRJSONObject>>; // All
}

// All
export interface IRChoice {
  items: IRItem[]; // All
  refusal?: IRClassifierRefusal; // All
  logprobs?: IRLogprobGroup[] | null; // ChatCompletions, Responses, GenerateContent
}

// All
export interface IRClassifierRefusal {
  category: string | null; // Messages, Responses
  explanation: string | null; // All
}

// All
export type IRItem = IRMessageItem | IRReasoningItem | IRFunctionCallItem | IRCustomToolCallItem;

// All
export interface IRMessageItem {
  type: 'message'; // All
  content: IRContentPart[]; // All
}

// All
export type IRContentPart = IRTextPart | IRRefusalPart | IRImagePart | IRAudioPart;

// All
export interface IRTextPart {
  type: 'text'; // All
  text: string; // All
  annotations?: IRSourceCitation[] | null; // All
}

// All
export interface IRRefusalPart {
  type: 'refusal'; // All
  refusal: string; // All
}

// All
export interface IRReasoningItem {
  type: 'reasoning'; // All
  summary?: string[]; // All
  content?: string[]; // All
  encrypted_content?: string | null; // All
}

// All
export interface IRFunctionCallItem {
  type: 'function_call'; // All
  call_id?: string; // All
  name: string; // All
  arguments?: string | IRJSONObject; // All
}

// ChatCompletions, Responses, Messages
export interface IRCustomToolCallItem {
  type: 'custom_tool_call'; // ChatCompletions, Responses, Messages
  call_id: string; // ChatCompletions, Responses, Messages
  name: string; // ChatCompletions, Responses, Messages
  input: string; // ChatCompletions, Responses, Messages
}

// Responses, GenerateContent
export interface IRImagePart {
  type: 'image'; // Responses, GenerateContent
  image: IRImage; // Responses, GenerateContent
}

// Responses, GenerateContent
export interface IRImage {
  data: string; // Responses, GenerateContent
  mime_type?: string; // Responses, GenerateContent
}

// ChatCompletions, Responses, GenerateContent
export interface IRAudioPart {
  type: 'audio'; // ChatCompletions, Responses, GenerateContent
  audio: IRAudio; // ChatCompletions, Responses, GenerateContent
}

// ChatCompletions, Responses, GenerateContent
export type IRAudio = {
  mime_type?: string; // ChatCompletions, GenerateContent
} & (
  | {
    data: string; // ChatCompletions, Responses, GenerateContent
    transcript?: string; // ChatCompletions, Responses, GenerateContent
  }
  | {
    data?: never; // ChatCompletions, Responses, GenerateContent
    transcript: string; // ChatCompletions, Responses, GenerateContent
  }
);

// All
export type IRSourceCitation = {
  type: 'source_citation'; // All
  source_label?: string | null; // All
  source_text?: IRSourceText; // Messages, GenerateContent
  source_page_range?: IRSourcePageRange; // Messages, GenerateContent
  output_text_range?: IRUTF16TextRange; // ChatCompletions, Responses, GenerateContent
} & (
  | {
    source_kind: 'url' | 'document' | 'search_result'; // All
    source: string; // All
  }
  | {
    source_kind: 'document' | 'search_result'; // Messages, GenerateContent
    source?: null; // Messages, GenerateContent
    source_text: IRSourceText; // Messages, GenerateContent
  }
);

// Messages, GenerateContent
export interface IRSourceText {
  text: string; // Messages, GenerateContent
  granularity: 'exact_quote' | 'retrieved_passage'; // Messages, GenerateContent
}

// Messages, GenerateContent
export interface IRSourcePageRange {
  start_one_based: number; // Messages, GenerateContent
  end_one_based_exclusive: number; // Messages
}

// ChatCompletions, Responses, GenerateContent
export interface IRUTF16TextRange {
  start: number; // ChatCompletions, Responses, GenerateContent
  end_exclusive: number; // ChatCompletions, Responses, GenerateContent
}

// ChatCompletions, Responses, GenerateContent
export type IRLogprobGroup = IRChoiceLogprobs | IRTextPartLogprobs;

// ChatCompletions, GenerateContent
export interface IRChoiceLogprobs {
  scope: 'choice'; // ChatCompletions, GenerateContent
  tokens: IRTokenLogprob[]; // ChatCompletions, GenerateContent
}

// ChatCompletions, Responses
export interface IRTextPartLogprobs {
  scope: 'text_part'; // ChatCompletions, Responses
  item_index: number; // ChatCompletions, Responses
  content_index: number; // ChatCompletions, Responses
  tokens: IRTokenLogprob[]; // ChatCompletions, Responses
}

// ChatCompletions, Responses, GenerateContent
export interface IRTokenLogprob {
  token: string; // ChatCompletions, Responses, GenerateContent
  logprob: number; // ChatCompletions, Responses, GenerateContent
  bytes?: number[] | null; // ChatCompletions, Responses
  top_logprobs?: IRTokenLogprobAlternative[]; // ChatCompletions, Responses, GenerateContent
}

// ChatCompletions, Responses, GenerateContent
export interface IRTokenLogprobAlternative {
  token: string; // ChatCompletions, Responses, GenerateContent
  logprob: number; // ChatCompletions, Responses, GenerateContent
  bytes?: number[] | null; // ChatCompletions, Responses
}

// All
export interface IRUsage {
  input_tokens_inclusive?: number; // All
  output_tokens_inclusive?: number; // All
  total_tokens?: number; // ChatCompletions, Responses, GenerateContent
  cached_input_tokens?: number; // All
  cache_creation_input_tokens?: number; // ChatCompletions, Responses, Messages
  reasoning_tokens?: number; // All
  input_audio_tokens?: number; // ChatCompletions, GenerateContent
  input_image_tokens?: number; // ChatCompletions, GenerateContent
  input_text_tokens?: number; // ChatCompletions, GenerateContent
  output_audio_tokens?: number; // ChatCompletions, GenerateContent
  output_text_tokens?: number; // ChatCompletions, GenerateContent
}
