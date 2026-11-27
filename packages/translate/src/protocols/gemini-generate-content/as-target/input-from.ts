import { klona } from 'klona/json';

import type { GeminiGenerateContentInputAssistantTurn } from './assistant-turn.ts';
import type { RestoredAssistantTurn } from '../../../composition/reading.ts';
import type { IRInputAssistantItemWithCallIds, IRInputToolResultItemWithCallId, IRInputTurnWithCallIds } from '../../../composition/request/call-ids.ts';
import { requireStreaming } from '../../../ir/input/streaming.ts';
import type {
  IRInputClientItem,
  IRInputDocument,
  IRInputMedia,
  IRInputOutputFormat,
  IRInputRequestHeader,
  IRInputSettings,
  IRInputTextPart,
  IRInputTool,
  IRInputToolChoice,
} from '../../../ir/input/types.ts';
import { buildCustomToolInputSchema } from '../../../shared/custom-tool.ts';
import { isDataURL, parseDataURL } from '../../../shared/data-url.ts';
import { DOCUMENT_CLOSE_TAG, documentImage, documentOpening } from '../../../shared/document.ts';
import { TranslateInputException } from '../../../shared/input-error.ts';
import { isPlainJSONObject } from '../../../shared/json/object.ts';
import { geminiServiceTierFromIR } from '../service-tier.ts';
import { parseJSONWithRawNumbers } from '@floway-dev/protocols/common';
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

export interface GeminiGenerateContentMatchedCall {
  readonly name: string;
  readonly wireId?: string;
  readonly order: number;
}

export type GeminiGenerateContentToolResultLookup = ReadonlyMap<IRInputToolResultItemWithCallId, GeminiGenerateContentMatchedCall>;

const DEFAULT_BINARY_MEDIA_TYPE = 'application/octet-stream';

const inlineBlob = (data: string, mediaType: string | undefined): GeminiGenerateContentBlob => ({
  mimeType: mediaType !== undefined && mediaType !== '' ? mediaType : DEFAULT_BINARY_MEDIA_TYPE,
  data,
});

const dataURLPart = (value: string): GeminiGenerateContentPart => {
  const parsed = parseDataURL(value);
  return { inlineData: inlineBlob(parsed.data, parsed.media_type) };
};

const mediaPart = (media: IRInputMedia): GeminiGenerateContentPart => {
  switch (media.source_kind) {
  case 'url':
    return isDataURL(media.url)
      ? dataURLPart(media.url)
      : {
          fileData: {
            ...(media.media_type !== undefined && media.media_type !== '' ? { mimeType: media.media_type } : {}),
            fileUri: media.url,
          },
        };
  case 'data':
    return isDataURL(media.data) ? dataURLPart(media.data) : { inlineData: inlineBlob(media.data, undefined) };
  case 'base64':
    return { inlineData: inlineBlob(media.data, media.media_type) };
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
    return isPlainJSONObject(parsed) ? parsed : { raw_arguments: argumentsJson };
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
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
    if (isPlainJSONObject(parsed)) {
      if (!isError) return parsed;
      return 'error' in parsed ? parsed : { error: parsed };
    }
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
  }
  return isError ? { error: text } : { output: text };
};

interface BuiltToolResult {
  readonly responsePart: GeminiGenerateContentPart;
  readonly liftedParts: readonly GeminiGenerateContentPart[];
  readonly order: number;
}

// Keep `functionResponse` parts contiguous and intact: inline images/files fit inside
// `functionResponse.parts`, whereas documents and URL references are lifted intact after
// the contiguous `functionResponse` run so `<document>` envelopes stay unbroken.
const buildToolResult = (
  item: IRInputToolResultItemWithCallId,
  matchedToolResults: GeminiGenerateContentToolResultLookup,
): BuiltToolResult => {
  const matched = matchedToolResults.get(item);
  if (matched === undefined) {
    throw new Error(`Missing Gemini GenerateContent matched call metadata for tool_result '${item.call_id}'.`);
  }
  const isError = item.is_error === true;
  let response: Record<string, unknown>;
  const inlineParts: GeminiGenerateContentFunctionResponsePart[] = [];
  let liftedParts: GeminiGenerateContentPart[] = [];
  if (typeof item.output === 'string') {
    response = wrapFunctionResponseText(item.output, isError);
  } else {
    const texts: string[] = [];
    const rawLiftedParts: GeminiGenerateContentPart[] = [];
    const liftedKinds = new Set<'image' | 'file' | 'document'>();
    for (const part of item.output) {
      switch (part.type) {
      case 'text':
        texts.push(part.text);
        break;
      case 'image':
      case 'file': {
        const converted = mediaPart(part.type === 'image' ? part.image : part.file);
        if (converted.inlineData !== undefined) {
          inlineParts.push({ inlineData: converted.inlineData });
        } else {
          liftedKinds.add(part.type);
          rawLiftedParts.push(converted);
        }
        break;
      }
      case 'document':
        liftedKinds.add('document');
        rawLiftedParts.push(...documentParts(part.document));
        break;
      }
    }

    let liftedPlaceholder = '';
    if (rawLiftedParts.length > 0) {
      const [noun, verb] = liftedKinds.size > 1
        ? ['Attachments', 'are']
        : liftedKinds.has('image')
          ? ['Image output', 'is']
          : liftedKinds.has('file')
            ? ['File output', 'is']
            : ['Document output', 'is'];
      liftedPlaceholder = `${noun} ${verb} attached in the following user content.`;
      liftedParts = [
        { text: `${noun} from tool call ${matched.wireId ?? matched.name}:` },
        ...rawLiftedParts,
      ];
    }

    const joinedText = texts.join('');
    response = joinedText !== ''
      ? wrapFunctionResponseText(joinedText, isError)
      : isError ? { error: liftedPlaceholder } : { output: liftedPlaceholder };
  }

  return {
    responsePart: {
      functionResponse: {
        ...(matched.wireId === undefined ? {} : { id: matched.wireId }),
        name: matched.name,
        response,
        ...(inlineParts.length > 0 ? { parts: inlineParts } : {}),
      },
    },
    liftedParts,
    order: matched.order,
  };
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

type NormalizedGeminiContent = GeminiGenerateContentContent & { role: 'user' | 'model'; parts: GeminiGenerateContentPart[] };

const systemTextParts = (content: readonly IRInputTextPart[]): GeminiGenerateContentPart[] =>
  content.flatMap(part => (part.text === '' ? [] : [{ text: part.text }]));

const assistantParts = (
  items: readonly IRInputAssistantItemWithCallIds[],
  hasPriorFunctionCall: boolean,
): GeminiGenerateContentPart[] => {
  const parts: GeminiGenerateContentPart[] = [];
  let sawFunctionCall = hasPriorFunctionCall;

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
      // Readable reasoning from a non-sidecar turn has no GenerateContent `thoughtSignature`;
      // omit it without inventing a signature.
      break;
    case 'function_call':
    case 'custom_tool_call': {
      const part: GeminiGenerateContentPart = {
        functionCall: {
          id: item.call_id,
          name: item.name,
          // `FunctionCall.args` is a `google.protobuf.Struct`; always emit an explicit object
          // so downstream JSON relays never forward a missing/null field.
          // https://github.com/googleapis/googleapis/blob/bc7e3baa28fbb223fa93782e130260fab8205bfc/google/ai/generativelanguage/v1beta/content.proto
          args: item.type === 'custom_tool_call'
            ? { input: item.input }
            : item.arguments === undefined ? {} : parseFunctionCallArguments(item.arguments),
        },
        ...(sawFunctionCall ? {} : { thoughtSignature: GEMINI_SKIP_THOUGHT_SIGNATURE_VALIDATOR }),
      };
      sawFunctionCall = true;
      parts.push(part);
      break;
    }
    }
  }

  return parts;
};

const appendContentParts = (
  contents: NormalizedGeminiContent[],
  role: 'user' | 'model',
  parts: readonly GeminiGenerateContentPart[],
): void => {
  if (parts.length === 0) return;
  const last = contents.at(-1);
  if (last?.role === role) {
    last.parts.push(...parts);
    return;
  }
  contents.push({ role, parts: [...parts] });
};

const buildConversation = (
  turns: readonly (IRInputTurnWithCallIds | RestoredAssistantTurn<GeminiGenerateContentInputAssistantTurn>)[],
  matchedToolResults: GeminiGenerateContentToolResultLookup,
): { readonly systemParts: GeminiGenerateContentPart[]; readonly contents: NormalizedGeminiContent[] } => {
  const systemParts: GeminiGenerateContentPart[] = [];
  const contents: NormalizedGeminiContent[] = [];
  let hoisting = true;
  let pendingEmptyModelBoundary = false;
  let pendingToolResults: BuiltToolResult[] = [];
  let pendingUserParts: GeminiGenerateContentPart[] = [];

  const flushEmptyModelBoundary = (): void => {
    if (!pendingEmptyModelBoundary) return;
    pendingEmptyModelBoundary = false;
    // Non-sidecar reasoning-only or empty model turns have no wireable content;
    // emit an empty text part so surrounding user turns do not merge.
    appendContentParts(contents, 'model', [{ text: '' }]);
  };

  const appendModelParts = (parts: readonly GeminiGenerateContentPart[]): void => {
    if (parts.length > 0) {
      pendingEmptyModelBoundary = false;
      appendContentParts(contents, 'model', parts);
    } else if (contents.at(-1)?.role !== 'model') {
      pendingEmptyModelBoundary = true;
    }
  };

  const flushClientRun = (): void => {
    if (pendingToolResults.length === 0 && pendingUserParts.length === 0) return;
    flushEmptyModelBoundary();
    const ordered = pendingToolResults.toSorted((a, b) => a.order - b.order);
    const parts: GeminiGenerateContentPart[] = [
      ...ordered.map(entry => entry.responsePart),
      ...ordered.flatMap(entry => entry.liftedParts),
      ...pendingUserParts,
    ];
    pendingToolResults = [];
    pendingUserParts = [];
    appendContentParts(contents, 'user', parts);
  };

  for (const piece of turns) {
    if (piece.kind === 'restored') {
      flushClientRun();
      hoisting = false;
      appendModelParts(klona(piece.turn.flatMap(entry => entry.parts ?? [])));
      continue;
    }
    if (piece.kind === 'assistant') {
      flushClientRun();
      hoisting = false;
      const last = contents.at(-1);
      const hasPriorFunctionCall = last?.role === 'model' && last.parts.some(part => part.functionCall !== undefined);
      appendModelParts(assistantParts(piece.items, hasPriorFunctionCall));
      continue;
    }

    for (const item of piece.items) {
      if (item.type === 'tool_result') {
        hoisting = false;
        pendingToolResults.push(buildToolResult(item, matchedToolResults));
        continue;
      }
      if (item.type === 'instruction' || (item.type === 'message' && item.role !== 'user')) {
        // GenerateContent `contents` only admits `'user'` and `'model'` roles; non-leading
        // system/developer turns lower inline into user text parts.
        (hoisting ? systemParts : pendingUserParts).push(...systemTextParts(item.content));
        if (item.type === 'instruction') hoisting = false;
        continue;
      }
      hoisting = false;
      pendingUserParts.push(...userMessageParts(item));
    }
  }

  flushClientRun();
  flushEmptyModelBoundary();
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
    if (tools.length > 0 && permitted.size === tools.length && tools.every(tool => permitted.has(`${tool.type}:${tool.name}`))) {
      return { functionCallingConfig: { mode: choice.mode === 'required' ? 'ANY' : 'AUTO' } };
    }
    return {
      functionCallingConfig: {
        mode: choice.mode === 'required' ? 'ANY' : 'VALIDATED',
        allowedFunctionNames: [...new Set(choice.tools.map(selector => selector.name))],
      },
    };
  }
  return { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: [choice.name] } };
};

const isForcingToolChoice = (choice: IRInputToolChoice): boolean =>
  choice === 'required'
  || (typeof choice === 'object' && (choice.type !== 'allowed_tools' || choice.mode === 'required'));

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
  const summary = settings.reasoning_summary;
  const includeThoughts = summary === undefined || summary === '' ? undefined : summary !== 'omitted';
  if (settings.reasoning_budget !== undefined) {
    return settings.reasoning_budget === 0
      ? { thinkingBudget: 0 }
      : { thinkingBudget: settings.reasoning_budget, includeThoughts: includeThoughts ?? true };
  }
  const effort = settings.reasoning_effort;
  if (effort !== undefined && effort !== '') {
    if (effort === 'none') return { thinkingBudget: 0 };
    return {
      thinkingLevel: thinkingLevelFromEffort(effort),
      includeThoughts: includeThoughts ?? true,
    };
  }
  if (settings.reasoning_budget_dynamic === true) {
    return { thinkingBudget: -1, includeThoughts: includeThoughts ?? true };
  }
  if (includeThoughts !== undefined) {
    return { includeThoughts };
  }
  return undefined;
};

const outputFormatConfig = (format: IRInputOutputFormat | undefined): Partial<GeminiGenerateContentGenerationConfig> => {
  if (format?.type === 'json_schema') {
    if (format.schema === undefined) {
      throw new TranslateInputException('Cannot translate json_schema response format without a schema.');
    }
    return { responseMimeType: 'application/json', responseJsonSchema: klona(format.schema) };
  }
  return format?.type === 'json_object' ? { responseMimeType: 'application/json' } : {};
};

const geminiGenerateContentSettingsFromIR = (
  settings: IRInputSettings,
): GeminiGenerateContentGenerationConfig | undefined => {
  const ceiling = settings.max_output_tokens ?? settings.max_visible_output_tokens;
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
    // GenerateContent rejects `generationConfig.logprobs` unless `responseLogprobs` is true,
    // and OpenAI Responses sets `logprobs: false` whenever `include` omits logprobs.
    // https://ai.google.dev/api/generate-content#GenerationConfig
    ...(settings.logprobs === true
      ? {
          responseLogprobs: true,
          ...(settings.top_logprobs == null ? {} : { logprobs: settings.top_logprobs }),
        }
      : {}),
    ...outputFormatConfig(settings.output_format),
    ...(thinkingConfig === undefined ? {} : { thinkingConfig }),
  };

  return Object.keys(config).length === 0 ? undefined : config;
};

export const geminiGenerateContentPayloadFromIR = (
  request: IRInputRequestHeader,
  turns: readonly (IRInputTurnWithCallIds | RestoredAssistantTurn<GeminiGenerateContentInputAssistantTurn>)[],
  matchedToolResults: GeminiGenerateContentToolResultLookup,
): GeminiGenerateContentRequest => {
  requireStreaming(request.settings);
  const declaredTools = request.tools ?? [];
  const declarations = declaredTools.map(toolFromIR);
  const tools: GeminiGenerateContentToolGroup[] | undefined = declarations.length === 0
    ? undefined
    : [{ functionDeclarations: declarations }];
  const choice = request.tool_choice !== undefined && (declaredTools.length > 0 || isForcingToolChoice(request.tool_choice))
    ? request.tool_choice
    : undefined;
  const toolConfig = choice === undefined ? undefined : toolConfigFromIR(choice, declaredTools);
  const generationConfig = geminiGenerateContentSettingsFromIR(request.settings);
  // Omit `auto` since GenerateContent has no matching service tier value.
  const serviceTier = request.settings.service_tier === 'auto' ? undefined : geminiServiceTierFromIR(request.settings.service_tier);
  const { systemParts, contents } = buildConversation(turns, matchedToolResults);

  return {
    model: request.settings.model,
    ...(systemParts.length === 0 ? {} : { systemInstruction: { parts: systemParts } }),
    contents,
    ...(tools === undefined ? {} : { tools }),
    ...(toolConfig === undefined ? {} : { toolConfig }),
    ...(generationConfig === undefined ? {} : { generationConfig }),
    ...(serviceTier === undefined ? {} : { serviceTier }),
  };
};
