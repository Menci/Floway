// Official SDK wire declarations.
// https://github.com/openai/openai-node/blob/7423ac3e9351c46300cd094479cded5551a72eb4/src/resources/chat/completions/completions.ts

import type * as CompletionsAPI from './sdk-usage.ts';
import type * as ChatCompletionsAPI from './sdk.ts';
import type * as Shared from '../openai-responses/sdk-shared.ts';

export interface ChatCompletion {
  id: string;
  choices: Array<ChatCompletion.Choice>;
  created: number;
  model: string;
  object: 'chat.completion';
  metadata?: Shared.Metadata | null;
  moderation?: ChatCompletion.Moderation | null;
  service_tier?: 'auto' | 'default' | 'flex' | 'scale' | 'priority' | 'fast' | null;
  system_fingerprint?: string;
  usage?: CompletionsAPI.CompletionUsage;
}

export namespace ChatCompletion {
  export interface Choice {
    finish_reason: 'stop' | 'length' | 'tool_calls' | 'content_filter' | 'function_call';
    index: number;
    logprobs: Choice.Logprobs | null;
    message: ChatCompletionsAPI.ChatCompletionMessage;
  }
  export namespace Choice {
    export interface Logprobs {
      content: Array<ChatCompletionsAPI.ChatCompletionTokenLogprob> | null;
      refusal: Array<ChatCompletionsAPI.ChatCompletionTokenLogprob> | null;
    }
  }
  export interface Moderation {
    input: Moderation.ModerationResults | Moderation.Error;
    output: Moderation.ModerationResults | Moderation.Error;
  }
  export namespace Moderation {
    export interface ModerationResults {
      model: string;
      results: Array<ModerationResults.Result>;
      type: 'moderation_results';
    }
    export namespace ModerationResults {
      export interface Result {
        categories: {
          [key: string]: boolean;
        };
        category_applied_input_types: {
          [key: string]: Array<'text' | 'image'>;
        };
        category_scores: {
          [key: string]: number;
        };
        flagged: boolean;
        model: string;
        type: 'moderation_result';
      }
    }
    export interface Error {
      code: string;
      message: string;
      type: 'error';
    }
    export interface ModerationResults {
      model: string;
      results: Array<ModerationResults.Result>;
      type: 'moderation_results';
    }
    export namespace ModerationResults {
      export interface Result {
        categories: {
          [key: string]: boolean;
        };
        category_applied_input_types: {
          [key: string]: Array<'text' | 'image'>;
        };
        category_scores: {
          [key: string]: number;
        };
        flagged: boolean;
        model: string;
        type: 'moderation_result';
      }
    }
    export interface Error {
      code: string;
      message: string;
      type: 'error';
    }
  }
}

export interface ChatCompletionAllowedToolChoice {
  allowed_tools: ChatCompletionAllowedTools;
  type: 'allowed_tools';
}

export interface ChatCompletionAssistantMessageParam {
  role: 'assistant';
  audio?: ChatCompletionAssistantMessageParam.Audio | null;
  content?: string | Array<ChatCompletionContentPartText | ChatCompletionContentPartRefusal> | null;
  function_call?: ChatCompletionAssistantMessageParam.FunctionCall | null;
  name?: string;
  refusal?: string | null;
  tool_calls?: Array<ChatCompletionMessageToolCall>;
}

export namespace ChatCompletionAssistantMessageParam {
  export interface Audio {
    id: string;
  }
  export interface FunctionCall {
    arguments: string;
    name: string;
  }
}

export interface ChatCompletionAudio {
  id: string;
  data: string;
  expires_at: number;
  transcript: string;
}

export interface ChatCompletionAudioParam {
  format: 'wav' | 'aac' | 'mp3' | 'flac' | 'opus' | 'pcm16';
  voice: string | 'alloy' | 'ash' | 'ballad' | 'coral' | 'echo' | 'sage' | 'shimmer' | 'verse' | 'marin' | 'cedar' | ChatCompletionAudioParam.ID;
}

export namespace ChatCompletionAudioParam {
  export interface ID {
    id: string;
  }
}

export interface ChatCompletionChunk {
  id: string;
  choices: Array<ChatCompletionChunk.Choice>;
  created: number;
  model: string;
  object: 'chat.completion.chunk';
  moderation?: ChatCompletionChunk.Moderation | null;
  obfuscation?: string;
  service_tier?: 'auto' | 'default' | 'flex' | 'scale' | 'priority' | 'fast' | null;
  system_fingerprint?: string;
  usage?: CompletionsAPI.CompletionUsage | null;
}

export namespace ChatCompletionChunk {
  export interface Choice {
    delta: Choice.Delta;
    finish_reason: 'stop' | 'length' | 'tool_calls' | 'content_filter' | 'function_call' | null;
    index: number;
    logprobs?: Choice.Logprobs | null;
  }
  export namespace Choice {
    export interface Delta {
      content?: string | null;
      function_call?: Delta.FunctionCall;
      refusal?: string | null;
      role?: 'developer' | 'system' | 'user' | 'assistant' | 'tool';
      tool_calls?: Array<Delta.ToolCall>;
    }
    export namespace Delta {
      export interface FunctionCall {
        arguments?: string;
        name?: string;
      }
      export interface ToolCall {
        index: number;
        id?: string;
        custom?: ToolCall.Custom;
        function?: ToolCall.Function;
        type?: 'function' | 'custom';
      }
      export namespace ToolCall {
        export interface Custom {
          input?: string;
          name?: string;
        }
        export interface Function {
          arguments?: string;
          name?: string;
        }
      }
    }
    export interface Logprobs {
      content: Array<ChatCompletionsAPI.ChatCompletionTokenLogprob> | null;
      refusal: Array<ChatCompletionsAPI.ChatCompletionTokenLogprob> | null;
    }
  }
  export interface Moderation {
    input: Moderation.ModerationResults | Moderation.Error;
    output: Moderation.ModerationResults | Moderation.Error;
  }
  export namespace Moderation {
    export interface ModerationResults {
      model: string;
      results: Array<ModerationResults.Result>;
      type: 'moderation_results';
    }
    export namespace ModerationResults {
      export interface Result {
        categories: {
          [key: string]: boolean;
        };
        category_applied_input_types: {
          [key: string]: Array<'text' | 'image'>;
        };
        category_scores: {
          [key: string]: number;
        };
        flagged: boolean;
        model: string;
        type: 'moderation_result';
      }
    }
    export interface Error {
      code: string;
      message: string;
      type: 'error';
    }
    export interface ModerationResults {
      model: string;
      results: Array<ModerationResults.Result>;
      type: 'moderation_results';
    }
    export namespace ModerationResults {
      export interface Result {
        categories: {
          [key: string]: boolean;
        };
        category_applied_input_types: {
          [key: string]: Array<'text' | 'image'>;
        };
        category_scores: {
          [key: string]: number;
        };
        flagged: boolean;
        model: string;
        type: 'moderation_result';
      }
    }
    export interface Error {
      code: string;
      message: string;
      type: 'error';
    }
  }
}

export type ChatCompletionContentPart = ChatCompletionContentPartText | ChatCompletionContentPartImage | ChatCompletionContentPartInputAudio | ChatCompletionContentPart.File;

export namespace ChatCompletionContentPart {
  export interface File {
    file: File.File;
    type: 'file';
    prompt_cache_breakpoint?: File.PromptCacheBreakpoint;
  }
  export namespace File {
    export interface File {
      file_data?: string;
      file_id?: string;
      filename?: string;
    }
    export interface PromptCacheBreakpoint {
      mode: 'explicit';
    }
  }
}

export interface ChatCompletionContentPartImage {
  image_url: ChatCompletionContentPartImage.ImageURL;
  type: 'image_url';
  prompt_cache_breakpoint?: ChatCompletionContentPartImage.PromptCacheBreakpoint;
}

export namespace ChatCompletionContentPartImage {
  export interface ImageURL {
    url: string;
    detail?: 'auto' | 'low' | 'high' | 'original';
  }
  export interface PromptCacheBreakpoint {
    mode: 'explicit';
  }
}

export interface ChatCompletionContentPartInputAudio {
  input_audio: ChatCompletionContentPartInputAudio.InputAudio;
  type: 'input_audio';
  prompt_cache_breakpoint?: ChatCompletionContentPartInputAudio.PromptCacheBreakpoint;
}

export namespace ChatCompletionContentPartInputAudio {
  export interface InputAudio {
    data: string;
    format: 'wav' | 'mp3';
  }
  export interface PromptCacheBreakpoint {
    mode: 'explicit';
  }
}

export interface ChatCompletionContentPartRefusal {
  refusal: string;
  type: 'refusal';
}

export interface ChatCompletionContentPartText {
  text: string;
  type: 'text';
  prompt_cache_breakpoint?: ChatCompletionContentPartText.PromptCacheBreakpoint;
}

export namespace ChatCompletionContentPartText {
  export interface PromptCacheBreakpoint {
    mode: 'explicit';
  }
}

export interface ChatCompletionCustomTool {
  custom: ChatCompletionCustomTool.Custom;
  type: 'custom';
}

export namespace ChatCompletionCustomTool {
  export interface Custom {
    name: string;
    description?: string;
    format?: Custom.Text | Custom.Grammar;
  }
  export namespace Custom {
    export interface Text {
      type: 'text';
    }
    export interface Grammar {
      grammar: Grammar.Grammar;
      type: 'grammar';
    }
    export namespace Grammar {
      export interface Grammar {
        definition: string;
        syntax: 'lark' | 'regex';
      }
    }
  }
}

export interface ChatCompletionDeveloperMessageParam {
  content: string | Array<ChatCompletionContentPartText>;
  role: 'developer';
  name?: string;
}

export interface ChatCompletionFunctionCallOption {
  name: string;
}

export interface ChatCompletionFunctionMessageParam {
  content: string | null;
  name: string;
  role: 'function';
}

export interface ChatCompletionFunctionTool {
  function: Shared.FunctionDefinition;
  type: 'function';
}

export interface ChatCompletionMessage {
  content: string | null;
  refusal: string | null;
  role: 'assistant';
  annotations?: Array<ChatCompletionMessage.Annotation>;
  audio?: ChatCompletionAudio | null;
  function_call?: ChatCompletionMessage.FunctionCall | null;
  tool_calls?: Array<ChatCompletionMessageToolCall>;
}

export namespace ChatCompletionMessage {
  export interface Annotation {
    type: 'url_citation';
    url_citation: Annotation.URLCitation;
  }
  export namespace Annotation {
    export interface URLCitation {
      end_index: number;
      start_index: number;
      title: string;
      url: string;
    }
  }
  export interface FunctionCall {
    arguments: string;
    name: string;
  }
}

export interface ChatCompletionMessageCustomToolCall {
  id: string;
  custom: ChatCompletionMessageCustomToolCall.Custom;
  type: 'custom';
}

export namespace ChatCompletionMessageCustomToolCall {
  export interface Custom {
    input: string;
    name: string;
  }
}

export interface ChatCompletionMessageFunctionToolCall {
  id: string;
  function: ChatCompletionMessageFunctionToolCall.Function;
  type: 'function';
}

export namespace ChatCompletionMessageFunctionToolCall {
  export interface Function {
    arguments: string;
    name: string;
  }
}

export type ChatCompletionMessageParam = ChatCompletionDeveloperMessageParam | ChatCompletionSystemMessageParam | ChatCompletionUserMessageParam | ChatCompletionAssistantMessageParam | ChatCompletionToolMessageParam | ChatCompletionFunctionMessageParam;

export type ChatCompletionMessageToolCall = ChatCompletionMessageFunctionToolCall | ChatCompletionMessageCustomToolCall;

export interface ChatCompletionNamedToolChoice {
  function: ChatCompletionNamedToolChoice.Function;
  type: 'function';
}

export namespace ChatCompletionNamedToolChoice {
  export interface Function {
    name: string;
  }
}

export interface ChatCompletionNamedToolChoiceCustom {
  custom: ChatCompletionNamedToolChoiceCustom.Custom;
  type: 'custom';
}

export namespace ChatCompletionNamedToolChoiceCustom {
  export interface Custom {
    name: string;
  }
}

export interface ChatCompletionPredictionContent {
  content: string | Array<ChatCompletionContentPartText>;
  type: 'content';
}

export interface ChatCompletionStreamOptions {
  include_obfuscation?: boolean;
  include_usage?: boolean;
}

export interface ChatCompletionSystemMessageParam {
  content: string | Array<ChatCompletionContentPartText>;
  role: 'system';
  name?: string;
}

export interface ChatCompletionTokenLogprob {
  token: string;
  bytes: Array<number> | null;
  logprob: number;
  top_logprobs: Array<ChatCompletionTokenLogprob.TopLogprob>;
}

export namespace ChatCompletionTokenLogprob {
  export interface TopLogprob {
    token: string;
    bytes: Array<number> | null;
    logprob: number;
  }
}

export type ChatCompletionTool = ChatCompletionFunctionTool | ChatCompletionCustomTool;

export type ChatCompletionToolChoiceOption = 'none' | 'auto' | 'required' | ChatCompletionAllowedToolChoice | ChatCompletionNamedToolChoice | ChatCompletionNamedToolChoiceCustom;

export interface ChatCompletionToolMessageParam {
  content: string | Array<ChatCompletionContentPartText>;
  role: 'tool';
  tool_call_id: string;
}

export interface ChatCompletionUserMessageParam {
  content: string | Array<ChatCompletionContentPart>;
  role: 'user';
  name?: string;
}

export interface ChatCompletionAllowedTools {
  mode: 'auto' | 'required';
  tools: Array<{
    [key: string]: unknown;
  }>;
}

export type ChatCompletionCreateParams = ChatCompletionCreateParamsNonStreaming | ChatCompletionCreateParamsStreaming;

export interface ChatCompletionCreateParamsBase {
  messages: Array<ChatCompletionMessageParam>;
  model: (string & {}) | Shared.ChatModel;
  audio?: ChatCompletionAudioParam | null;
  frequency_penalty?: number | null;
  function_call?: 'none' | 'auto' | ChatCompletionFunctionCallOption;
  functions?: Array<ChatCompletionCreateParams.Function>;
  logit_bias?: {
    [key: string]: number;
  } | null;
  logprobs?: boolean | null;
  max_completion_tokens?: number | null;
  max_tokens?: number | null;
  metadata?: Shared.Metadata | null;
  modalities?: Array<'text' | 'audio'> | null;
  moderation?: ChatCompletionCreateParams.Moderation | null;
  n?: number | null;
  parallel_tool_calls?: boolean;
  prediction?: ChatCompletionPredictionContent | null;
  presence_penalty?: number | null;
  prompt_cache_key?: string | null;
  prompt_cache_options?: ChatCompletionCreateParams.PromptCacheOptions;
  prompt_cache_retention?: 'in_memory' | '24h' | null;
  reasoning_effort?: Shared.ReasoningEffort | null;
  response_format?: Shared.ResponseFormatText | Shared.ResponseFormatJSONSchema | Shared.ResponseFormatJSONObject;
  safety_identifier?: string | null;
  seed?: number | null;
  service_tier?: 'auto' | 'default' | 'flex' | 'scale' | 'priority' | 'fast' | null;
  stop?: string | null | Array<string>;
  store?: boolean | null;
  stream?: boolean | null;
  stream_options?: ChatCompletionStreamOptions | null;
  temperature?: number | null;
  tool_choice?: ChatCompletionToolChoiceOption;
  tools?: Array<ChatCompletionTool>;
  top_logprobs?: number | null;
  top_p?: number | null;
  user?: string;
  verbosity?: 'low' | 'medium' | 'high' | null;
  web_search_options?: ChatCompletionCreateParams.WebSearchOptions;
}

export namespace ChatCompletionCreateParams {
  export interface Function {
    name: string;
    description?: string;
    parameters?: Shared.FunctionParameters;
  }
  export interface Moderation {
    model: string;
    policy?: Moderation.Policy | null;
  }
  export namespace Moderation {
    export interface Policy {
      input?: Policy.Input | null;
      output?: Policy.Output | null;
    }
    export namespace Policy {
      export interface Input {
        mode: 'score' | 'block';
      }
      export interface Output {
        mode: 'score' | 'block';
      }
    }
  }
  export interface PromptCacheOptions {
    mode?: 'implicit' | 'explicit';
    ttl?: '30m';
  }
  export interface WebSearchOptions {
    search_context_size?: 'low' | 'medium' | 'high';
    user_location?: WebSearchOptions.UserLocation | null;
  }
  export namespace WebSearchOptions {
    export interface UserLocation {
      approximate: UserLocation.Approximate;
      type: 'approximate';
    }
    export namespace UserLocation {
      export interface Approximate {
        city?: string;
        country?: string;
        region?: string;
        timezone?: string;
      }
    }
  }
}

export interface ChatCompletionCreateParamsNonStreaming extends ChatCompletionCreateParamsBase {
  stream?: false | null;
}

export interface ChatCompletionCreateParamsStreaming extends ChatCompletionCreateParamsBase {
  stream: true;
}
