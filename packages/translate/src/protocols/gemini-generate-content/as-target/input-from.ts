import { klona } from 'klona/json';

import type { IRInputAssistantItemWithCallIds, IRInputToolResultItemWithCallId, IRInputTurnWithCallIds } from '../../../composition/request/call-ids.ts';
import { requireStreaming } from '../../../ir/input/streaming.ts';
import type {
  IRInputClientItem,
  IRInputDocument,
  IRInputMedia,
  IRInputRequestHeader,
  IRInputSettings,
  IRInputTextPart,
  IRInputTool,
  IRInputToolChoice,
  IRInputToolResultContentPart,
} from '../../../ir/input/types.ts';
import { buildCustomToolInputSchema } from '../../../shared/custom-tool.ts';
import { parseDataURL } from '../../../shared/data-url.ts';
import { DOCUMENT_CLOSE_TAG, documentImage, documentOpening } from '../../../shared/document.ts';
import { TranslateInputException } from '../../../shared/input-error.ts';
import type { TranslateOptions } from '../../../types.ts';
import { FAST_SERVICE_TIER, isFastServiceTier, parseJSONWithRawNumbers } from '@floway-dev/protocols/common';
import type {
  GeminiGenerateContentBlob,
  GeminiGenerateContentContent,
  GeminiGenerateContentFunctionDeclaration,
  GeminiGenerateContentFunctionResponsePart,
  GeminiGenerateContentGenerationConfig,
  GeminiGenerateContentPart,
  GeminiGenerateContentRequest,
  GeminiGenerateContentThinkingConfig,
  GeminiGenerateContentToolConfig,
  GeminiGenerateContentToolGroup,
} from '@floway-dev/protocols/gemini-generate-content';

export interface GeminiGenerateContentTrackedCall {
  readonly name: string;
  readonly id?: string;
}

export type GeminiGenerateContentCallLookup = Map<string, GeminiGenerateContentTrackedCall>;

const inlineBlobOf = (data: string, mediaType: string | undefined): GeminiGenerateContentBlob => {
  if (mediaType !== undefined && mediaType !== '') return { mimeType: mediaType, data };
  if (data.startsWith('data:')) {
    const parsed = parseDataURL(data);
    if (parsed.media_type !== undefined && parsed.media_type !== '') {
      return { mimeType: parsed.media_type, data: parsed.data };
    }
  }
  throw new TranslateInputException('Gemini GenerateContent inlineData input requires a media type.');
};

const mediaPart = (media: IRInputMedia): GeminiGenerateContentPart => {
  switch (media.source_kind) {
  case 'url':
    if (media.url.startsWith('data:')) {
      const parsed = parseDataURL(media.url);
      return { inlineData: inlineBlobOf(parsed.data, parsed.media_type) };
    }
    return { fileData: { fileUri: media.url } };
  case 'data': {
    if (media.data.startsWith('data:')) {
      const parsed = parseDataURL(media.data);
      return { inlineData: inlineBlobOf(parsed.data, parsed.media_type) };
    }
    throw new TranslateInputException('Gemini GenerateContent inlineData input requires a media type.');
  }
  case 'base64':
    return { inlineData: inlineBlobOf(media.data, media.media_type) };
  case 'file':
    // A file id names an object in the source vendor's file store; Gemini
    // `fileData.fileUri` cannot resolve it.
    throw new TranslateInputException('Cannot translate a file id reference to Gemini GenerateContent; send the content inline or by URL.');
  }
};

const documentParts = (document: IRInputDocument): GeminiGenerateContentPart[] => {
  const source = document.source;
  const content: GeminiGenerateContentPart[] = source.source_kind === 'media'
    ? [mediaPart(source.media)]
    : source.source_kind === 'text'
      ? [{ text: source.text }]
      : source.content.map(part => part.type === 'text'
          ? { text: part.text }
          : mediaPart(documentImage(part)));
  return [{ text: documentOpening(document) }, ...content, { text: DOCUMENT_CLOSE_TAG }];
};

const parseFunctionCallArguments = (argumentsJson: string): Record<string, unknown> => {
  if (argumentsJson.trim() === '') return {};
  try {
    const parsed = parseJSONWithRawNumbers(argumentsJson);
    if (parsed === null) return {};
    return typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : { raw_arguments: argumentsJson };
  } catch {
    return { raw_arguments: argumentsJson };
  }
};

// Gemini `FunctionResponse.response` must be a JSON object (`google.protobuf.Struct`).
// Plain-object tool outputs pass through directly (matching `as-source/input-to.ts`,
// which serializes `response` with `JSON.stringify`); non-object outputs and
// error flags use Google's documented `output` / `error` keys.
// https://ai.google.dev/api/caching#FunctionResponse
const wrapFunctionResponseText = (text: string, isError: boolean): Record<string, unknown> => {
  try {
    const parsed = parseJSONWithRawNumbers(text);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      const record = parsed as Record<string, unknown>;
      if (!isError) return record;
      return 'error' in record ? record : { error: record };
    }
  } catch {
    // Non-JSON tool output falls through to `{ output }` / `{ error }` wrapping.
  }
  return isError ? { error: text } : { output: text };
};

const buildToolResultParts = (
  item: IRInputToolResultItemWithCallId,
  callLookup: GeminiGenerateContentCallLookup,
): GeminiGenerateContentPart[] => {
  const tracked = callLookup.get(item.call_id);
  if (tracked === undefined) {
    throw new TranslateInputException(`Cannot translate tool result for unknown call_id '${item.call_id}' to Gemini GenerateContent.`);
  }
  const isError = item.is_error === true;
  if (typeof item.output === 'string') {
    return [{
      functionResponse: {
        ...(tracked.id === undefined ? {} : { id: tracked.id }),
        name: tracked.name,
        response: wrapFunctionResponseText(item.output, isError),
      },
    }];
  }

  const texts: string[] = [];
  const inlineParts: GeminiGenerateContentFunctionResponsePart[] = [];
  const trailingParts: GeminiGenerateContentPart[] = [];
  for (const part of item.output as readonly IRInputToolResultContentPart[]) {
    switch (part.type) {
    case 'text':
      texts.push(part.text);
      break;
    case 'image': {
      const converted = mediaPart(part.image);
      if (converted.inlineData !== undefined) {
        inlineParts.push({ inlineData: { mimeType: converted.inlineData.mimeType, data: converted.inlineData.data } });
      } else {
        trailingParts.push(converted);
      }
      break;
    }
    case 'file': {
      const converted = mediaPart(part.file);
      if (converted.inlineData !== undefined) {
        inlineParts.push({ inlineData: { mimeType: converted.inlineData.mimeType, data: converted.inlineData.data } });
      } else {
        trailingParts.push(converted);
      }
      break;
    }
    case 'document': {
      for (const docPart of documentParts(part.document)) {
        if (docPart.inlineData !== undefined) {
          inlineParts.push({ inlineData: { mimeType: docPart.inlineData.mimeType, data: docPart.inlineData.data } });
        } else {
          trailingParts.push(docPart);
        }
      }
      break;
    }
    }
  }

  const response = texts.length > 0
    ? wrapFunctionResponseText(texts.join(''), isError)
    : isError ? { error: '' } : { output: '' };

  return [
    {
      functionResponse: {
        ...(tracked.id === undefined ? {} : { id: tracked.id }),
        name: tracked.name,
        response,
        ...(inlineParts.length > 0 ? { parts: inlineParts } : {}),
      },
    },
    ...trailingParts,
  ];
};

const userMessageParts = (item: Extract<IRInputClientItem, { type: 'message'; role: 'user' }>): GeminiGenerateContentPart[] => {
  const parts: GeminiGenerateContentPart[] = [];
  for (const part of item.content) {
    switch (part.type) {
    case 'text':
      parts.push({ text: part.text });
      break;
    case 'image':
      parts.push(mediaPart(part.image));
      break;
    case 'file':
      parts.push(mediaPart(part.file));
      break;
    case 'document':
      parts.push(...documentParts(part.document));
      break;
    case 'audio':
      parts.push({ inlineData: { mimeType: part.audio.media_type, data: part.audio.data } });
      break;
    }
  }
  return parts.length === 0 ? [{ text: '' }] : parts;
};

// Sentinel thoughtSignature documented by Google for non-Gemini or synthetic functionCall parts
// in multi-turn conversations (attached only to the first functionCall in a turn).
// https://ai.google.dev/gemini-api/docs/thought-signatures
const GEMINI_SKIP_THOUGHT_SIGNATURE_VALIDATOR = 'skip_thought_signature_validator';

const systemTextParts = (content: readonly IRInputTextPart[]): GeminiGenerateContentPart[] =>
  content.flatMap(part => (part.text === '' ? [] : [{ text: part.text }]));

const assistantParts = (
  items: readonly IRInputAssistantItemWithCallIds[],
  callLookup: GeminiGenerateContentCallLookup,
): GeminiGenerateContentPart[] => {
  const parts: GeminiGenerateContentPart[] = [];
  let signedFunctionCall = false;

  for (const item of items) {
    switch (item.type) {
    case 'message':
      if (item.content.length === 0) {
        parts.push({ text: '' });
      } else {
        for (const part of item.content) {
          parts.push(part.type === 'text' ? { text: part.text } : { text: part.refusal });
        }
      }
      break;
    case 'reasoning':
      // Readable reasoning from a non-sidecar turn has no Gemini `thoughtSignature`;
      // drop it rather than inventing a signature.
      break;
    case 'function_call': {
      callLookup.set(item.call_id, { name: item.name, id: item.call_id });
      const thoughtSignature = signedFunctionCall ? undefined : GEMINI_SKIP_THOUGHT_SIGNATURE_VALIDATOR;
      signedFunctionCall = true;
      parts.push({
        functionCall: {
          id: item.call_id,
          name: item.name,
          // Emit `{}` when arguments are absent so Go relays without `omitempty` (e.g. New-API) do not serialize `"args": null`.
          args: item.arguments === undefined ? {} : parseFunctionCallArguments(item.arguments),
        },
        ...(thoughtSignature === undefined ? {} : { thoughtSignature }),
      });
      break;
    }
    case 'custom_tool_call': {
      callLookup.set(item.call_id, { name: item.name, id: item.call_id });
      const thoughtSignature = signedFunctionCall ? undefined : GEMINI_SKIP_THOUGHT_SIGNATURE_VALIDATOR;
      signedFunctionCall = true;
      parts.push({
        functionCall: {
          id: item.call_id,
          name: item.name,
          args: { input: item.input },
        },
        ...(thoughtSignature === undefined ? {} : { thoughtSignature }),
      });
      break;
    }
    }
  }

  return parts;
};

export const appendContentParts = (
  contents: GeminiGenerateContentContent[],
  role: 'user' | 'model',
  parts: readonly GeminiGenerateContentPart[],
): void => {
  if (parts.length === 0) return;
  const last = contents.at(-1);
  if (last?.role === role) {
    last.parts ??= [];
    last.parts.push(...parts);
    return;
  }
  contents.push({ role, parts: [...parts] });
};

export interface GeminiGenerateContentConversation {
  readonly systemParts: GeminiGenerateContentPart[];
  readonly contents: GeminiGenerateContentContent[];
}

export const geminiGenerateContentConversationFromIR = (
  turns: readonly IRInputTurnWithCallIds[],
  leading: boolean,
  callLookup: GeminiGenerateContentCallLookup,
): GeminiGenerateContentConversation => {
  const systemParts: GeminiGenerateContentPart[] = [];
  const contents: GeminiGenerateContentContent[] = [];
  let hoisting = leading;

  for (const turn of turns) {
    if (turn.kind === 'assistant') {
      hoisting = false;
      appendContentParts(contents, 'model', assistantParts(turn.items, callLookup));
      continue;
    }

    for (const item of turn.items) {
      if (item.type === 'instruction') {
        if (hoisting) {
          systemParts.push(...systemTextParts(item.content));
          hoisting = false;
          continue;
        }
        appendContentParts(contents, 'user', systemTextParts(item.content));
        continue;
      }
      if (item.type === 'message' && item.role !== 'user') {
        if (hoisting) {
          systemParts.push(...systemTextParts(item.content));
          continue;
        }
        // Gemini `contents` only admits `'user'` and `'model'` roles; non-leading
        // system/developer turns lower inline into user text parts.
        appendContentParts(contents, 'user', systemTextParts(item.content));
        continue;
      }
      hoisting = false;
      appendContentParts(
        contents,
        'user',
        item.type === 'tool_result' ? buildToolResultParts(item, callLookup) : userMessageParts(item),
      );
    }
  }

  return { systemParts, contents };
};

const toolFromIR = (tool: IRInputTool): GeminiGenerateContentFunctionDeclaration => {
  const schema = tool.type === 'function'
    ? tool.parameters === undefined ? undefined : klona(tool.parameters)
    : buildCustomToolInputSchema(tool.format);
  return {
    name: tool.name,
    ...(tool.description === undefined ? {} : { description: tool.description }),
    ...(schema === undefined ? {} : { parametersJsonSchema: schema }),
  };
};

// Inverse of `toolsToIR` in `../as-source/input-to.ts`: `allowedFunctionNames` is
// paired with `ANY` (required) or `VALIDATED` (auto subset) while retaining all declarations.
// https://github.com/googleapis/googleapis/blob/bc7e3baa28fbb223fa93782e130260fab8205bfc/google/ai/generativelanguage/v1beta/content.proto
const toolConfigFromIR = (
  choice: IRInputToolChoice,
  tools: readonly IRInputTool[],
): GeminiGenerateContentToolConfig => {
  if (choice === 'auto') return { functionCallingConfig: { mode: 'AUTO' } };
  if (choice === 'none') return { functionCallingConfig: { mode: 'NONE' } };
  if (choice === 'required') return { functionCallingConfig: { mode: 'ANY' } };
  if (choice.type === 'allowed_tools') {
    if (choice.tools.length === 0) {
      if (choice.mode === 'auto') return { functionCallingConfig: { mode: 'NONE' } };
      throw new TranslateInputException('Gemini GenerateContent cannot require a tool call from an empty allowed_tools list.');
    }
    const permitted = new Set(choice.tools.map(selector => `${selector.type}:${selector.name}`));
    if (tools.length > 0 && tools.every(tool => permitted.has(`${tool.type}:${tool.name}`))) {
      return { functionCallingConfig: { mode: choice.mode === 'required' ? 'ANY' : 'AUTO' } };
    }
    return {
      functionCallingConfig: {
        mode: choice.mode === 'required' ? 'ANY' : 'VALIDATED',
        allowedFunctionNames: choice.tools.map(selector => selector.name),
      },
    };
  }
  return { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: [choice.name] } };
};

const toolChoiceForTools = (
  choice: IRInputToolChoice | undefined,
  tools: readonly IRInputTool[] | undefined,
): IRInputToolChoice | undefined => (tools !== undefined && tools.length > 0 ? choice : undefined);

// Inverse of `geminiGenerateContentReasoningEffortToIR` in `../as-source/input-to.ts`.
// https://ai.google.dev/api/generate-content#ThinkingLevel
const thinkingLevelFromEffort = (effort: string): string => {
  switch (effort) {
  case 'minimal': return 'MINIMAL';
  case 'low': return 'LOW';
  case 'medium': return 'MEDIUM';
  case 'high': return 'HIGH';
  case 'xhigh': return 'XHIGH';
  default: return effort;
  }
};

// Gemini rejects setting `thinkingBudget` and `thinkingLevel` simultaneously.
// Explicit numeric budgets take `thinkingBudget`, explicit effort uses
// `thinkingLevel` (including `thinking: { type: 'adaptive' }` with explicit
// `output_config.effort`), and bare dynamic thinking falls back to `-1`.
// https://ai.google.dev/api/generate-content#ThinkingConfig
const thinkingConfigFromSettings = (settings: IRInputSettings): GeminiGenerateContentThinkingConfig | undefined => {
  const thoughtFlag = settings.reasoning_summary === 'omitted' ? {} : { includeThoughts: true };
  if (settings.reasoning_budget !== undefined) {
    return settings.reasoning_budget === 0
      ? { thinkingBudget: 0 }
      : { thinkingBudget: settings.reasoning_budget, ...thoughtFlag };
  }
  const effort = settings.reasoning_effort;
  if (effort !== undefined && effort !== '') {
    if (effort === 'none') return { thinkingBudget: 0 };
    return {
      thinkingLevel: thinkingLevelFromEffort(effort),
      ...thoughtFlag,
    };
  }
  if (settings.reasoning_budget_dynamic === true) {
    return { thinkingBudget: -1, ...thoughtFlag };
  }
  if (settings.reasoning_summary !== undefined) {
    return { includeThoughts: settings.reasoning_summary !== 'omitted' };
  }
  return undefined;
};

export const geminiGenerateContentSettingsFromIR = (
  settings: IRInputSettings,
  options: Pick<TranslateOptions, 'fallbackMaxOutputTokens'> = {},
): GeminiGenerateContentGenerationConfig | undefined => {
  const ceiling = settings.max_output_tokens ?? settings.max_visible_output_tokens ?? options.fallbackMaxOutputTokens;
  const format = settings.output_format;
  const thinkingConfig = thinkingConfigFromSettings(settings);

  const config: GeminiGenerateContentGenerationConfig = {
    ...(ceiling == null ? {} : { maxOutputTokens: ceiling }),
    ...(settings.temperature == null ? {} : { temperature: settings.temperature }),
    ...(settings.top_p == null ? {} : { topP: settings.top_p }),
    ...(settings.top_k === undefined ? {} : { topK: settings.top_k }),
    ...(settings.stop === undefined ? {} : { stopSequences: [...settings.stop] }),
    ...(settings.seed === undefined ? {} : { seed: settings.seed }),
    ...(settings.choice_count === undefined ? {} : { candidateCount: settings.choice_count }),
    ...(settings.presence_penalty == null ? {} : { presencePenalty: settings.presence_penalty }),
    ...(settings.frequency_penalty == null ? {} : { frequencyPenalty: settings.frequency_penalty }),
    ...(settings.logprobs == null ? {} : { responseLogprobs: settings.logprobs }),
    ...(settings.top_logprobs == null ? {} : { logprobs: settings.top_logprobs }),
    ...(format?.type === 'json_schema'
      ? {
          responseMimeType: 'application/json',
          ...(format.schema === undefined ? {} : { responseJsonSchema: klona(format.schema) }),
        }
      : format?.type === 'json_object'
        ? { responseMimeType: 'application/json' }
        : {}),
    ...(thinkingConfig === undefined ? {} : { thinkingConfig }),
  };

  return Object.keys(config).length === 0 ? undefined : config;
};

export const geminiGenerateContentHeaderFromIR = (
  request: IRInputRequestHeader,
  options: Pick<TranslateOptions, 'fallbackMaxOutputTokens'> = {},
): Omit<GeminiGenerateContentRequest, 'contents' | 'systemInstruction'> => {
  requireStreaming(request.settings);
  const declarations = request.tools?.map(toolFromIR) ?? [];
  const tools: GeminiGenerateContentToolGroup[] | undefined = declarations.length === 0
    ? undefined
    : [{ functionDeclarations: declarations }];
  const choice = toolChoiceForTools(request.tool_choice, request.tools);
  const toolConfig = choice === undefined ? undefined : toolConfigFromIR(choice, request.tools ?? []);
  const generationConfig = geminiGenerateContentSettingsFromIR(request.settings, options);
  // Gemini's ServiceTier enum spells the accelerated lane as `priority` and the standard lane as `standard`.
  // Omit OpenAI's default `auto` lane since Gemini has no matching tier value.
  // https://ai.google.dev/api/generate-content#ServiceTier
  const tier = request.settings.service_tier;
  const serviceTier = tier == null || tier === 'auto'
    ? undefined
    : isFastServiceTier(tier)
      ? FAST_SERVICE_TIER
      : tier === 'default'
        ? 'standard'
        : tier;

  return {
    model: request.settings.model,
    ...(tools === undefined ? {} : { tools }),
    ...(toolConfig === undefined ? {} : { toolConfig }),
    ...(generationConfig === undefined ? {} : { generationConfig }),
    ...(serviceTier === undefined ? {} : { serviceTier }),
  };
};
