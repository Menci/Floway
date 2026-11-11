import { klona } from 'klona/json';

import { partitionGeminiGenerateContentTurns, type GeminiGenerateContentConversationTurn as GeminiGenerateContentTurn } from './conversation-turns.ts';
import type { GeminiGenerateContentSourceAssistantTurn } from './round-trip.ts';
import { geminiFunctionParameters, geminiResponseSchema } from './schema.ts';
import type { SourceReading, SourceTurnSlot } from '../../../composition/reading.ts';
import type {
  IRInputAssistantContentPart,
  IRInputRequestHeader,
  IRInputSettings,
  IRInputTool,
  IRInputToolChoice,
  IRInputOutputFormat,
  IRInputAssistantItem,
  IRInputTextPart,
  IRInputTurn,
  IRInputUserContentPart,
  IRInputClientItem,
} from '../../../ir/input/types.ts';
import { TranslateInputException } from '../../../shared/input-error.ts';
import type { GeminiGenerateContentThinkingConfig, GeminiGenerateContentContent, GeminiGenerateContentPart, GeminiGenerateContentPartData, GeminiGenerateContentPayload, GeminiGenerateContentRequest } from '@floway-dev/protocols/gemini-generate-content';

// Translate Google's named thinking levels to target effort names; the default
// sentinel leaves effort unset. Preserve all other open-string values verbatim.
// Reference: https://ai.google.dev/api/generate-content#ThinkingLevel
const geminiGenerateContentReasoningEffortToIR = (thinkingConfig?: GeminiGenerateContentThinkingConfig): string | undefined => {
  switch (thinkingConfig?.thinkingLevel) {
  case 'LOW': return 'low';
  case 'MEDIUM': return 'medium';
  case 'HIGH': return 'high';
  case 'MINIMAL': return 'minimal';
  case 'THINKING_LEVEL_UNSPECIFIED': return undefined;
  default: return thinkingConfig?.thinkingLevel;
  }
};

const inlinePart = (part: GeminiGenerateContentPart): IRInputUserContentPart => {
  const inlineData = geminiGenerateContentInlineData(part);
  if (inlineData === null) throw new TranslateInputException('Expected inline data.');
  const media = { source_kind: 'base64' as const, media_type: inlineData.mimeType, data: inlineData.data };
  switch (inlineData.kind) {
  case 'image': return { type: 'image', image: media };
  case 'pdf': return { type: 'file', file: media };
  case 'audio': return { type: 'audio', audio: { media_type: inlineData.mimeType, data: inlineData.data } };
  // Inline data outside known image/audio kinds becomes a file with its original MIME type.
  // The selected upstream owns acceptance.
  case 'other': return { type: 'file', file: media };
  }
};

const userParts = (content: GeminiGenerateContentContent): IRInputClientItem[] => {
  const items: IRInputClientItem[] = [];
  const pending: IRInputUserContentPart[] = [];
  const flush = (): void => {
    if (pending.length === 0) return;
    items.push({ type: 'message', content: pending.splice(0) });
  };

  (content.parts ?? []).forEach(part => {
    const kind = geminiGenerateContentPartKind(part);
    switch (kind) {
    case null:
      return;
    case 'function_response': {
      const response = part.functionResponse!;
      flush();
      items.push({
        type: 'tool_result',
        // The target matches id-less results against both ordinary and native calls.
        name: response.name,
        ...(response.id === undefined ? {} : { call_id: response.id }),
        output: JSON.stringify(response.response),
      });
      return;
    }
    case 'text': {
      const text = geminiGenerateContentPartText(part);
      if (text !== null) pending.push({ type: 'text', text });
      return;
    }
    case 'inline_data':
      pending.push(inlinePart(part));
      return;
    default:
      throw new TranslateInputException(`"${kind}" parts are not supported in user content.`);
    }
  });
  flush();
  return items;
};

// A thought part states no id of its own, so its IR identity comes from the
// position it occupies in the request.
const reasoningId = (contentIndex: number, partIndex: number): string => `gemini_reasoning_${contentIndex}_${partIndex}`;

const assistantItems = (content: GeminiGenerateContentContent, contentIndex: number): IRInputAssistantItem[] => {
  const items: IRInputAssistantItem[] = [];
  const pending: IRInputAssistantContentPart[] = [];
  const flush = (): void => {
    if (pending.length === 0) return;
    items.push({ type: 'message', content: pending.splice(0) });
  };

  const parts = (content.parts ?? []).flatMap(part => {
    const kind = geminiGenerateContentPartKind(part);
    return kind === null ? [] : [{ kind, part }];
  });

  parts.forEach(({ kind, part }, partIndex) => {
    switch (kind) {
    case 'function_call': {
      const call = part.functionCall!;
      flush();
      // An absent `functionCall.args` stays absent: `JSON.stringify(undefined)`
      // is `undefined`, so the field is omitted exactly as before. An explicit
      // `null` keeps `null`, because both OpenAI protocols distinguish the two.
      items.push({ type: 'function_call', ...(call.id === undefined ? {} : { call_id: call.id }), name: call.name, arguments: JSON.stringify(call.args) });
      return;
    }
    case 'text': {
      const thoughtText = geminiGenerateContentThoughtText(part);
      if (thoughtText !== null) {
        flush();
        items.push({ type: 'reasoning', id: reasoningId(contentIndex, partIndex), summary: [thoughtText] });
        return;
      }
      const visible = geminiGenerateContentVisibleText(part);
      if (visible !== null) pending.push({ type: 'text', text: visible });
      return;
    }
    case 'inline_data':
      // A model part has no media variant on any target; the current routes
      // reject it rather than flattening it.
      throw new TranslateInputException('"inline_data" parts are not supported in model content.');
    default:
      throw new TranslateInputException(`"${kind}" parts are not supported in model content.`);
    }
  });
  flush();
  return items;
};

const systemParts = (content: GeminiGenerateContentContent | undefined): IRInputTextPart[] => {
  const text = geminiGenerateContentText(content);
  return text === null ? [] : [{ type: 'text', text }];
};

// One IR turn per source turn. `partitionGeminiGenerateContentTurns` already
// folds consecutive same-role contents into one turn, so handing back one turn
// per content would re-split a grouping this reader had just made — the turn
// boundary the partition draws is the boundary the IR keeps.
const turnToIRTurns = (
  turn: GeminiGenerateContentTurn,
  contentIndex: number,
): IRInputTurn[] => turn.role === 'assistant'
  ? [{
      kind: 'assistant',
      items: turn.items.flatMap((content, index) => (content.parts?.length ?? 0) === 0
        ? [{ type: 'message' as const, content: [{ type: 'text' as const, text: '' }] }]
        : assistantItems(content, contentIndex + index)),
    }]
  : [{
      kind: 'client',
      items: turn.items.flatMap(content => {
        if (content.role !== 'user' && content.role !== undefined) {
          throw new TranslateInputException(`"${(content as { role: string }).role}" is not a supported content role.`);
        }
        return (content.parts?.length ?? 0) === 0
          ? [{ type: 'message' as const, content: [] }]
          : userParts(content);
      }),
    }];

/** A GenerateContent system instruction is the conversation's leading prompt. */
const geminiGenerateContentSystemToIR = (content: GeminiGenerateContentContent | undefined): IRInputTurn | undefined => {
  const parts = systemParts(content);
  return parts.length === 0 ? undefined : { kind: 'client', items: [{ type: 'prompt', role: 'system', content: parts }] };
};

// GenerateContent declares functions in groups and narrows them through
// `toolConfig.functionCallingConfig`. The IR states that narrowing as
// `allowed_tools`, keeping the complete declaration list separate from which
// functions the model may call.
// https://github.com/googleapis/googleapis/blob/master/google/ai/generativelanguage/v1beta/content.proto
// (FunctionCallingConfig: `allowed_function_names` only applies to ANY and
// VALIDATED, and limits which functions the model calls.)
const toolsToIR = (payload: GeminiGenerateContentPayload): Pick<IRInputRequestHeader, 'tools' | 'tool_choice'> => {
  const declarations = payload.tools?.flatMap(group => group.functionDeclarations ?? []) ?? [];
  const config = payload.toolConfig?.functionCallingConfig;
  const allowedNames = config?.allowedFunctionNames;
  const restrictable = config?.mode === 'ANY' || config?.mode === 'VALIDATED';
  const permitted = restrictable && allowedNames !== undefined && allowedNames.length > 0 ? new Set(allowedNames) : undefined;

  const tools: IRInputTool[] = declarations.map(declaration => {
    const parameters = geminiFunctionParameters(declaration);
    return {
      type: 'function' as const,
      name: declaration.name,
      ...(declaration.description === undefined ? {} : { description: declaration.description }),
      // GenerateContent states a declaration's schema either as its own dialect or
      // as JSON Schema; both become the same neutral object here.
      ...(parameters === undefined ? {} : { parameters }),
    };
  });

  let toolChoice: IRInputToolChoice | undefined;
  if (config?.mode === 'NONE') toolChoice = 'none';
  else if (config?.mode === 'AUTO' || config?.mode === 'VALIDATED' || config?.mode === 'ANY') {
    const mode = config.mode === 'ANY' ? 'required' : 'auto';
    toolChoice = permitted === undefined ? mode : {
      type: 'allowed_tools', mode,
      tools: [...permitted].map(name => ({ type: 'function', name })),
    };
  }

  return {
    ...(tools.length === 0 ? {} : { tools }),
    ...(toolChoice === undefined ? {} : { tool_choice: toolChoice }),
  };
};

export const readGeminiGenerateContentRequest = (payload: GeminiGenerateContentRequest): SourceReading<GeminiGenerateContentSourceAssistantTurn> => {
  let contentIndex = 0;
  const prompt = geminiGenerateContentSystemToIR(payload.systemInstruction);

  const turnSlotFor = (turn: GeminiGenerateContentTurn): SourceTurnSlot<GeminiGenerateContentSourceAssistantTurn> => {
    const at = contentIndex;
    contentIndex += turn.items.length;
    const toIRInputTurns = () => turnToIRTurns(turn, at);
    if (turn.role !== 'assistant') return { kind: 'client', toIRInputTurns };
    return {
      kind: 'assistant', assistantTurn: turn.items, toIRInputTurns,
      readCallIdentities: () => turn.items.flatMap(content => (content.parts ?? []).flatMap(part => part.functionCall === undefined ? [] : [{
        type: 'function' as const, name: part.functionCall.name,
        ...(part.functionCall.id === undefined ? {} : { call_id: part.functionCall.id }),
      }])),
    };
  };

  return {
    request: {
      settings: geminiGenerateContentSettingsToIR(payload),
      ...toolsToIR(payload),
    },
    turns: [
      ...(prompt === undefined ? [] : [{ kind: 'client' as const, toIRInputTurns: () => [prompt] }]),
      ...partitionGeminiGenerateContentTurns(payload.contents ?? []).map(turnSlotFor),
    ],
  };
};

/** GenerateContent keeps every sampling knob inside `generationConfig`. */
const geminiGenerateContentSettingsToIR = (payload: GeminiGenerateContentRequest): IRInputSettings => {
  const config = payload.generationConfig;
  const budget = config?.thinkingConfig?.thinkingBudget;
  // A level is what the caller stated, including an empty one: it is an open
  // string, and a target that accepts it forwards it verbatim. A budget is a
  // different quantity the caller may state instead, so it travels on its own
  // field and each target decides what it can do with it.
  const statedLevel = geminiGenerateContentReasoningEffortToIR(config?.thinkingConfig);
  // A stated level beside a stated budget is the one combination GenerateContent
  // refuses outright: the two knobs are mutually exclusive, and no model accepts
  // both. Neither can be preferred here, because which one a model understands
  // depends on its family, and a tie-break would invert a caller who asked for
  // one and got the other. Refusing keeps this reader's answer the one Google
  // itself gives. An empty level names no tier, so it is not a statement.
  // https://github.com/cline/cline/issues/7957
  if (statedLevel !== undefined && statedLevel !== '' && budget !== undefined) {
    throw new TranslateInputException('Unable to submit request because thinking_budget and thinking_level are not supported together.');
  }
  // A budget of zero is GenerateContent's off switch, which every target spells
  // on the effort axis.
  const effort = statedLevel ?? (budget === 0 ? 'none' : undefined);
  const schema = config === undefined ? undefined : geminiResponseSchema(config);
  const outputFormat: IRInputOutputFormat | undefined = schema !== undefined
    ? { type: 'json_schema', schema: klona(schema), name: 'gemini_response' }
    : config?.responseMimeType === 'application/json' ? { type: 'json_object' } : undefined;

  return {
    model: payload.model,
    stream: true,
    ...(config?.temperature == null ? {} : { temperature: config.temperature }),
    ...(config?.topP == null ? {} : { top_p: config.topP }),
    ...(config?.topK == null ? {} : { top_k: config.topK }),
    ...(config?.stopSequences == null ? {} : { stop: [...config.stopSequences] }),
    ...(config?.seed == null ? {} : { seed: config.seed }),
    ...(config?.maxOutputTokens == null ? {} : { max_output_tokens: config.maxOutputTokens }),
    ...(outputFormat === undefined ? {} : { output_format: outputFormat }),
    ...(config?.candidateCount === undefined ? {} : { choice_count: config.candidateCount }),
    ...(config?.presencePenalty === undefined ? {} : { presence_penalty: config.presencePenalty }),
    ...(config?.frequencyPenalty === undefined ? {} : { frequency_penalty: config.frequencyPenalty }),
    ...(effort === undefined ? {} : { reasoning_effort: effort }),
    // A negative budget asks the model to choose its own and states no number.
    ...(budget === undefined || budget <= 0 ? {} : { reasoning_budget: budget }),
    ...(budget === undefined || budget >= 0 ? {} : { reasoning_budget_dynamic: true }),
    // GenerateContent states readable reasoning as a boolean; the neutral
    // spelling names how much of it the caller wants. A request that asked for
    // no reasoning at all has nothing to summarize.
    ...(effort !== 'none' && config?.thinkingConfig?.includeThoughts === true ? { reasoning_summary: 'detailed' } : {}),
  };
};

const GEMINI_GENERATE_CONTENT_SUPPORTED_IMAGE_MIME_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'] as const;

const GEMINI_GENERATE_CONTENT_AUDIO_MIME_TYPES = ['audio/wav', 'audio/mp3', 'audio/mpeg'] as const;

type GeminiGenerateContentAudioMimeType = (typeof GEMINI_GENERATE_CONTENT_AUDIO_MIME_TYPES)[number];

const isAudioMimeType = (value: string): value is GeminiGenerateContentAudioMimeType =>
  (GEMINI_GENERATE_CONTENT_AUDIO_MIME_TYPES as readonly string[]).includes(value);

type GeminiGenerateContentSupportedImageMimeType = (typeof GEMINI_GENERATE_CONTENT_SUPPORTED_IMAGE_MIME_TYPES)[number];

type GeminiGenerateContentInlineData =
  | { kind: 'image'; mimeType: GeminiGenerateContentSupportedImageMimeType; data: string }
  | { kind: 'pdf'; mimeType: 'application/pdf'; data: string }
  | { kind: 'audio'; mimeType: GeminiGenerateContentAudioMimeType; data: string }
  // Any other MIME type: carried as a file and left for the target to judge.
  | { kind: 'other'; mimeType: string; data: string };

type GeminiGenerateContentPartKind = 'text' | 'inline_data' | 'function_call' | 'function_response' | 'file_data' | 'executable_code' | 'code_execution_result' | 'tool_call' | 'tool_response';

type GeminiGenerateContentPartDataField = keyof GeminiGenerateContentPartData;

// Source of truth for "what counts as a content-bearing field on a part".
// Record<GeminiGenerateContentPartDataField, _> forces a matching entry whenever a new field
// is added to GeminiGenerateContentPart, so request translators cannot silently start
// dropping it.
const GEMINI_GENERATE_CONTENT_PART_FIELD_TO_KIND: Record<GeminiGenerateContentPartDataField, GeminiGenerateContentPartKind> = {
  text: 'text',
  inlineData: 'inline_data',
  functionCall: 'function_call',
  functionResponse: 'function_response',
  fileData: 'file_data',
  executableCode: 'executable_code',
  codeExecutionResult: 'code_execution_result',
  toolCall: 'tool_call',
  toolResponse: 'tool_response',
};

const GEMINI_GENERATE_CONTENT_PART_DATA_FIELDS = Object.keys(GEMINI_GENERATE_CONTENT_PART_FIELD_TO_KIND) as GeminiGenerateContentPartDataField[];

// Classify the part by its single content-bearing field. Returns null when
// the part only carries a thoughtSignature (a valid signature carrier with
// no body). Throws when the part sets zero or multiple content fields —
// both are silent-data-loss shapes the request translators must refuse
// rather than coerce.
const geminiGenerateContentPartKind = (part: GeminiGenerateContentPart): GeminiGenerateContentPartKind | null => {
  const presentFields = GEMINI_GENERATE_CONTENT_PART_DATA_FIELDS.filter(field => part[field] !== undefined);
  if (presentFields.length === 1) return GEMINI_GENERATE_CONTENT_PART_FIELD_TO_KIND[presentFields[0]];
  if (presentFields.length > 1) {
    throw new Error(`Gemini generateContent part sets conflicting content fields: ${presentFields.join(', ')}.`);
  }
  if (part.thoughtSignature !== undefined) return null;
  const keys = Object.keys(part);
  throw new Error(`Gemini generateContent part has no recognized content. Keys present: ${keys.length ? keys.join(', ') : '(none)'}.`);
};

const geminiGenerateContentPartText = (part: GeminiGenerateContentPart): string | null => (typeof part.text === 'string' ? part.text : null);

const geminiGenerateContentThoughtText = (part: GeminiGenerateContentPart): string | null => (part.thought === true && typeof part.text === 'string' ? part.text : null);

const geminiGenerateContentVisibleText = (part: GeminiGenerateContentPart): string | null => (part.thought === true ? null : geminiGenerateContentPartText(part));

const geminiGenerateContentText = (content?: GeminiGenerateContentContent): string | null => {
  const texts = content?.parts?.map(geminiGenerateContentPartText).filter((text): text is string => text !== null);

  return texts?.length ? texts.join('') : null;
};

const geminiGenerateContentInlineData = (part: GeminiGenerateContentPart): GeminiGenerateContentInlineData | null => {
  const inlineData = part.inlineData;
  if (!inlineData) return null;

  if (GEMINI_GENERATE_CONTENT_SUPPORTED_IMAGE_MIME_TYPES.includes(inlineData.mimeType as GeminiGenerateContentSupportedImageMimeType)) {
    return {
      kind: 'image',
      mimeType: inlineData.mimeType as GeminiGenerateContentSupportedImageMimeType,
      data: inlineData.data,
    };
  }

  if (inlineData.mimeType === 'application/pdf') {
    return { kind: 'pdf', mimeType: inlineData.mimeType, data: inlineData.data };
  }

  if (isAudioMimeType(inlineData.mimeType)) {
    return { kind: 'audio', mimeType: inlineData.mimeType, data: inlineData.data };
  }

  return {
    kind: 'other',
    mimeType: inlineData.mimeType,
    data: inlineData.data,
  };
};
