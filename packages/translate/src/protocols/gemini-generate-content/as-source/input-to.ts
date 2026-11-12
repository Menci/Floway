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
  IRInputToolResultContentPart,
} from '../../../ir/input/types.ts';
import { TranslateInputException } from '../../../shared/input-error.ts';
import { geminiGenerateContentPartKind } from '@floway-dev/protocols/gemini-generate-content';
import type { GeminiGenerateContentThinkingConfig, GeminiGenerateContentContent, GeminiGenerateContentPart, GeminiGenerateContentPayload, GeminiGenerateContentRequest } from '@floway-dev/protocols/gemini-generate-content';

// Translate Google's named thinking levels to target effort names; the default
// sentinel leaves effort unset. Preserve all other open-string values verbatim.
// Reference: https://ai.google.dev/api/generate-content#ThinkingLevel
const geminiGenerateContentReasoningEffortToIR = (thinkingConfig?: GeminiGenerateContentThinkingConfig): string | undefined => {
  const level = thinkingConfig?.thinkingLevel ?? undefined;
  switch (level) {
  case 'LOW': return 'low';
  case 'MEDIUM': return 'medium';
  case 'HIGH': return 'high';
  case 'MINIMAL': return 'minimal';
  case 'THINKING_LEVEL_UNSPECIFIED': return undefined;
  default: return level;
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

const functionResponsePart = (
  part: NonNullable<NonNullable<GeminiGenerateContentPart['functionResponse']>['parts']>[number],
): IRInputToolResultContentPart => {
  const media = { source_kind: 'base64' as const, media_type: part.inlineData.mimeType, data: part.inlineData.data };
  return geminiGenerateContentInlineData({ inlineData: part.inlineData })?.kind === 'image'
    ? { type: 'image', image: media }
    : { type: 'file', file: media };
};

const userParts = (content: GeminiGenerateContentContent): IRInputClientItem[] => {
  const items: IRInputClientItem[] = [];
  const pending: IRInputUserContentPart[] = [];
  const flush = (): void => {
    if (pending.length === 0) return;
    items.push({ type: 'message', role: 'user', content: pending.splice(0) });
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
        output: response.parts === undefined
          ? JSON.stringify(response.response)
          : [{ type: 'text', text: JSON.stringify(response.response) }, ...response.parts.map(functionResponsePart)],
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
      // Omitted args leaves argument text absent; explicit null becomes the JSON text "null".
      items.push({ type: 'function_call', ...(call.id === undefined ? {} : { call_id: call.id }), name: call.name, arguments: JSON.stringify(call.args) });
      return;
    }
    case 'text': {
      const thoughtText = geminiGenerateContentThoughtText(part);
      if (thoughtText !== null) {
        flush();
        // Thought parts have no ID; their IR identity comes from their position.
        items.push({ type: 'reasoning', id: `gemini_reasoning_${contentIndex}_${partIndex}`, summary: [thoughtText] });
        return;
      }
      const visible = geminiGenerateContentVisibleText(part);
      if (visible !== null) pending.push({ type: 'text', text: visible });
      return;
    }
    case 'inline_data':

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

// One partitioned source turn becomes one IR turn, including consecutive same-role contents.
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
        if (content.role !== 'user' && content.role != null) {
          throw new TranslateInputException(`"${(content as { role: string }).role}" is not a supported content role.`);
        }
        return (content.parts?.length ?? 0) === 0
          ? [{ type: 'message' as const, role: 'user' as const, content: [] }]
          : userParts(content);
      }),
    }];

const geminiGenerateContentSystemToIR = (content: GeminiGenerateContentContent | undefined): IRInputTurn | undefined => {
  const parts = systemParts(content);
  return parts.length === 0 ? undefined : { kind: 'client', items: [{ type: 'instruction', content: parts }] };
};

// GenerateContent's allowedFunctionNames becomes an IR allowed_tools choice while retaining all declarations.
// https://github.com/googleapis/googleapis/blob/bc7e3baa28fbb223fa93782e130260fab8205bfc/google/ai/generativelanguage/v1beta/content.proto
const toolsToIR = (payload: GeminiGenerateContentPayload): Pick<IRInputRequestHeader, 'tools' | 'tool_choice'> => {
  const declarations = payload.tools?.flatMap(group => group.functionDeclarations ?? []) ?? [];
  const config = payload.toolConfig?.functionCallingConfig;
  const allowedNames = config?.allowedFunctionNames ?? undefined;
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
    ...(toolChoice === undefined || tools.length === 0 && toolChoice === 'required' ? {} : { tool_choice: toolChoice }),
  };
};

export const readGeminiGenerateContentRequest = (payload: GeminiGenerateContentRequest): SourceReading<GeminiGenerateContentSourceAssistantTurn> => {
  let contentIndex = 0;
  const instruction = geminiGenerateContentSystemToIR(payload.systemInstruction);

  const turnSlotFor = (turn: GeminiGenerateContentTurn): SourceTurnSlot<GeminiGenerateContentSourceAssistantTurn> => {
    const at = contentIndex;
    contentIndex += turn.items.length;
    const toIRInputTurns = () => turnToIRTurns(turn, at);
    if (turn.role !== 'assistant') return { kind: 'client', toIRInputTurns };
    return { kind: 'assistant', assistantTurn: turn.items, toIRInputTurns };
  };

  return {
    request: {
      settings: geminiGenerateContentSettingsToIR(payload),
      ...toolsToIR(payload),
    },
    turns: [
      ...(instruction === undefined ? [] : [{ kind: 'client' as const, toIRInputTurns: () => [instruction] }]),
      ...partitionGeminiGenerateContentTurns(payload.contents ?? []).map(turnSlotFor),
    ],
  };
};

const geminiGenerateContentSettingsToIR = (payload: GeminiGenerateContentRequest): IRInputSettings => {
  const config = payload.generationConfig ?? undefined;
  const thinkingConfig = config?.thinkingConfig ?? undefined;
  const budget = thinkingConfig?.thinkingBudget ?? undefined;
  // A level is what the caller stated, including an empty one: it is an open
  // string, and a target that accepts it forwards it verbatim. A budget is a
  // different quantity the caller may state instead, so it travels on its own
  // field and each target decides what it can do with it.
  const statedLevel = geminiGenerateContentReasoningEffortToIR(thinkingConfig);
  // Reject a simultaneous budget and non-empty thinking level. The empty string is exempt from this conflict check.
  // https://github.com/cline/cline/issues/7957
  if (statedLevel !== undefined && statedLevel !== '' && budget !== undefined) {
    throw new TranslateInputException('Unable to submit request because thinking_budget and thinking_level are not supported together.');
  }
  // A zero thinking budget maps to disabled reasoning.
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
    ...(config?.candidateCount == null ? {} : { choice_count: config.candidateCount }),
    ...(config?.presencePenalty == null ? {} : { presence_penalty: config.presencePenalty }),
    ...(config?.frequencyPenalty == null ? {} : { frequency_penalty: config.frequencyPenalty }),
    ...(effort === undefined ? {} : { reasoning_effort: effort }),
    // A negative budget asks the model to choose its own and states no number.
    ...(budget === undefined || budget <= 0 ? {} : { reasoning_budget: budget }),
    ...(budget === undefined || budget >= 0 ? {} : { reasoning_budget_dynamic: true }),
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
