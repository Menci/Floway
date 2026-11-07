import type { IRAbsent } from '../common/absent.ts';
import type { IRTextRange } from '../common/text-range.ts';

export type { IRJSONObject, IRJSONValue } from '../common/json.ts';
export type { IRErrorPayload } from '../common/error.ts';
export type { IRTextRange } from '../common/text-range.ts';
export { IRAbsent } from '../common/absent.ts';

// The value shape of the output output IR: JSON plus `IRAbsent` at any leaf that may be
// determined-never-to-arrive.
type IRValueOf<Extra> = Extra | null | boolean | number | string | readonly IRValueOf<Extra>[] | { readonly [key: string]: IRValueOf<Extra> };

// All
export type IRValue = IRValueOf<IRAbsent>;

// All
export interface IR {
  readonly choices: readonly IROutputChoice[]; // All
  readonly model?: string; // All
  readonly service_tier?: string; // All
  readonly usage?: IROutputUsage; // All
}

// All
interface IROutputChoice {
  readonly items: readonly IROutputItem[]; // All
  readonly refusal?: IROutputClassifierRefusal; // All
  readonly logprobs?: readonly IROutputLogprobGroup[] | null; // ChatCompletions, Responses, GenerateContent
}

// All
interface IROutputClassifierRefusal {
  readonly category: string | null; // Messages, Responses
  readonly explanation: string | null; // All
}

// All
export type IROutputItem = IROutputMessageItem | IROutputReasoningItem | IROutputFunctionCallItem | IROutputCustomToolCallItem;

// All
export interface IROutputMessageItem {
  readonly type: 'message'; // All
  readonly content: readonly IROutputContentPart[]; // All
}

// All
type IROutputContentPart = IROutputTextPart | IROutputRefusalPart | IROutputImagePart | IROutputAudioPart;

// All
interface IROutputTextPart {
  readonly type: 'text'; // All
  readonly text: string; // All
  readonly annotations?: readonly IROutputSourceCitation[] | null; // All
}

// All
interface IROutputRefusalPart {
  readonly type: 'refusal'; // All
  readonly refusal: string; // All
}

// All
export interface IROutputReasoningItem {
  readonly type: 'reasoning'; // All
  readonly summary?: readonly string[]; // All
  readonly content?: readonly string[]; // All
}

// All
interface IROutputFunctionCallItem {
  readonly type: 'function_call'; // All
  readonly call_id?: string | IRAbsent; // All
  readonly name: string; // All
  readonly arguments: string; // All
}

// ChatCompletions, Responses, Messages
interface IROutputCustomToolCallItem {
  readonly type: 'custom_tool_call'; // ChatCompletions, Responses, Messages
  readonly call_id?: string | IRAbsent; // ChatCompletions, Responses, Messages
  readonly name: string; // ChatCompletions, Responses, Messages
  readonly input: string; // ChatCompletions, Responses, Messages
}

// Responses, GenerateContent
interface IROutputImagePart {
  readonly type: 'image'; // Responses, GenerateContent
  readonly image: IROutputImage; // Responses, GenerateContent
}

// Responses, GenerateContent
interface IROutputImage {
  readonly data: string; // Responses, GenerateContent
  readonly mime_type?: string; // Responses, GenerateContent
}

// ChatCompletions, Responses, GenerateContent
export interface IROutputAudioPart {
  readonly type: 'audio'; // ChatCompletions, Responses, GenerateContent
  readonly audio: IROutputAudio; // ChatCompletions, Responses, GenerateContent
}

// ChatCompletions, Responses, GenerateContent
interface IROutputAudio {
  readonly data?: string; // ChatCompletions, Responses, GenerateContent
  readonly transcript?: string; // ChatCompletions, Responses, GenerateContent
  // No current upstream reader produces it; reserved for a GenerateContent upstream.
  readonly mime_type?: string; // GenerateContent
}

// All
export type IROutputSourceCitation = {
  readonly type: 'source_citation'; // All
  readonly source_label?: string | null; // All
  readonly source_text?: string; // Messages, GenerateContent
  readonly source_page_range?: IROutputSourcePageRange; // Messages, GenerateContent
  readonly output_text_range?: IRTextRange; // ChatCompletions, Responses, GenerateContent
} & (
  | {
    readonly source_kind: 'url' | 'document' | 'search_result'; // All
    readonly source: string; // All
  }
  | {
    readonly source_kind: 'document' | 'search_result'; // Messages, GenerateContent
    readonly source?: null; // Messages, GenerateContent
    readonly source_text: string; // Messages, GenerateContent
  }
);

// Messages, GenerateContent
interface IROutputSourcePageRange {
  readonly start_one_based: number; // Messages, GenerateContent
  readonly end_one_based_exclusive: number; // Messages
}

// ChatCompletions, Responses, GenerateContent
type IROutputLogprobGroup = IROutputChoiceLogprobs | IROutputTextPartLogprobs;

// Reserved for a GenerateContent upstream: the current upstream readers only produce text-part logprobs.
// ChatCompletions, GenerateContent
interface IROutputChoiceLogprobs {
  readonly scope: 'choice'; // ChatCompletions, GenerateContent
  readonly tokens: readonly IROutputTokenLogprob[]; // ChatCompletions, GenerateContent
}

// ChatCompletions, Responses
interface IROutputTextPartLogprobs {
  readonly scope: 'text_part'; // ChatCompletions, Responses
  readonly item_index: number; // ChatCompletions, Responses
  readonly content_index: number; // ChatCompletions, Responses
  readonly tokens: readonly IROutputTokenLogprob[]; // ChatCompletions, Responses
}

// ChatCompletions, Responses, GenerateContent
export interface IROutputTokenLogprob {
  readonly token: string; // ChatCompletions, Responses, GenerateContent
  readonly logprob: number; // ChatCompletions, Responses, GenerateContent
  readonly bytes?: readonly number[] | null; // ChatCompletions, Responses
  readonly top_logprobs?: readonly IROutputTokenLogprobAlternative[]; // ChatCompletions, Responses, GenerateContent
}

// ChatCompletions, Responses, GenerateContent
interface IROutputTokenLogprobAlternative {
  readonly token: string; // ChatCompletions, Responses, GenerateContent
  readonly logprob: number; // ChatCompletions, Responses, GenerateContent
  readonly bytes?: readonly number[] | null; // ChatCompletions, Responses
}

// All
export interface IROutputUsage {
  readonly input_tokens_inclusive?: number; // All
  readonly output_tokens_inclusive?: number; // All
  readonly total_tokens?: number; // ChatCompletions, Responses, GenerateContent
  readonly cached_input_tokens?: number; // All
  readonly cache_creation_input_tokens?: number; // ChatCompletions, Responses, Messages
  readonly reasoning_tokens?: number; // All
  readonly input_audio_tokens?: number; // ChatCompletions, Responses, GenerateContent
  readonly input_image_tokens?: number; // ChatCompletions, Responses, GenerateContent
  readonly input_text_tokens?: number; // ChatCompletions, Responses, GenerateContent
  readonly output_audio_tokens?: number; // ChatCompletions, Responses, GenerateContent
  readonly output_text_tokens?: number; // ChatCompletions, Responses, GenerateContent
}
