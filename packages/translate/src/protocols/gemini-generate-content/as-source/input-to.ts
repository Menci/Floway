import { klona } from 'klona/json';

import { partitionGeminiGenerateContentTurns, type GeminiGenerateContentConversationTurn as GeminiGenerateContentTurn } from './conversation-turns.ts';
import { geminiGenerateContentThinkingLevelEffort } from './reasoning.ts';
import type { GeminiGenerateContentAssistantTurn } from './round-trip.ts';
import { geminiFunctionParameters, geminiResponseSchema } from './schema.ts';
import type {
  IRInputAssistantContentPart,
  IRInputRequestHeader,
  IRInputSettings,
  IRInputTool,
  IRInputToolChoice,
  IRInputOutputFormat,
  IRInputAssistantItem,
  IRInputMedia,
  IRInputTextPart,
  IRInputTurn,
  IRInputUserContentPart,
  IRInputClientItem,
} from '../../../ir/input/types.ts';
import { TranslatorInputError } from '../../../types.ts';
import type { Reading, TurnSlot } from '../../composition/reading.ts';
import type { GeminiGenerateContentContent, GeminiGenerateContentPart, GeminiGenerateContentPartData, GeminiGenerateContentPayload, GeminiGenerateContentRequest } from '@floway-dev/protocols/gemini-generate-content';

const inlineMedia = (part: GeminiGenerateContentPart): IRInputMedia | null => {
  const inlineData = geminiGenerateContentInlineData(part);
  return inlineData === null ? null : { source_kind: 'base64', media_type: inlineData.mimeType, data: inlineData.data };
};

const inlinePart = (part: GeminiGenerateContentPart): IRInputUserContentPart => {
  const inlineData = geminiGenerateContentInlineData(part);
  if (inlineData === null) throw new TranslatorInputError('Expected inline data.');
  switch (inlineData.kind) {
  case 'image': return { type: 'image', image: inlineMedia(part)! };
  case 'pdf': return { type: 'file', file: inlineMedia(part)! };
  case 'audio': return { type: 'audio', audio: { media_type: inlineData.mimeType, data: inlineData.data } };
  // GenerateContent states any MIME type inline, and every target that carries a
  // file part carries its media type verbatim. A type this snapshot does not
  // recognize is forwarded as a file so the selected upstream decides whether it
  // accepts it.
  case 'other': return { type: 'file', file: inlineMedia(part)! };
  }
};

const userParts = (content: GeminiGenerateContentContent, turnIndex: number, ids: GeminiGenerateContentUnmatchedCallIds): IRInputClientItem[] => {
  const items: IRInputClientItem[] = [];
  const pending: IRInputUserContentPart[] = [];
  const flush = (): void => {
    if (pending.length === 0) return;
    items.push({ type: 'message', content: pending.splice(0) });
  };

  (content.parts ?? []).forEach((part, partIndex) => {
    const kind = geminiGenerateContentPartKind(part);
    switch (kind) {
    case null:
      return;
    case 'function_response': {
      const { response, id } = geminiGenerateContentFunctionResponseMatch(part, ids, turnIndex, partIndex)!;
      flush();
      items.push({
        type: 'tool_result',
        // The name is what lets a target pair a result this reader could not:
        // GenerateContent correlates by name, and the id may be unstated.
        name: response.name,
        ...(id === undefined ? {} : { call_id: id }),
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
      throw new TranslatorInputError(`"${kind}" parts are not supported in user content.`);
    }
  });
  flush();
  return items;
};

// A thought part states no id of its own, so its IR identity comes from the
// position it occupies in the request.
const reasoningId = (turnIndex: number, partIndex: number): string => `gemini_reasoning_${turnIndex}_${partIndex}`;

const assistantItems = (content: GeminiGenerateContentContent, turnIndex: number, ids: GeminiGenerateContentUnmatchedCallIds): IRInputAssistantItem[] => {
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
      const { call, id } = geminiGenerateContentFunctionCallMatch(part, ids, turnIndex, partIndex)!;
      flush();
      // An absent `functionCall.args` stays absent: `JSON.stringify(undefined)`
      // is `undefined`, so the field is omitted exactly as before. An explicit
      // `null` keeps `null`, because both OpenAI protocols distinguish the two.
      items.push({ type: 'function_call', call_id: id, name: call.name, arguments: JSON.stringify(call.args) });
      return;
    }
    case 'text': {
      const thoughtText = geminiGenerateContentThoughtText(part);
      if (thoughtText !== null) {
        flush();
        items.push({ type: 'reasoning', id: reasoningId(turnIndex, partIndex), summary: [thoughtText] });
        return;
      }
      const visible = geminiGenerateContentVisibleText(part);
      if (visible !== null) pending.push({ type: 'text', text: visible });
      return;
    }
    case 'inline_data':
      // A model part has no media variant on any target; the current routes
      // reject it rather than flattening it.
      throw new TranslatorInputError('"inline_data" parts are not supported in model content.');
    default:
      throw new TranslatorInputError(`"${kind}" parts are not supported in model content.`);
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
  ids: GeminiGenerateContentUnmatchedCallIds,
): IRInputTurn[] => turn.role === 'assistant'
  ? [{
      kind: 'assistant',
      items: turn.items.flatMap((content, index) => (content.parts?.length ?? 0) === 0
        ? [{ type: 'message' as const, content: [{ type: 'text' as const, text: '' }] }]
        : assistantItems(content, contentIndex + index, ids)),
    }]
  : [{
      kind: 'client',
      items: turn.items.flatMap((content, index) => {
        if (content.role !== 'user' && content.role !== undefined) {
          throw new TranslatorInputError(`"${(content as { role: string }).role}" is not a supported content role.`);
        }
        return (content.parts?.length ?? 0) === 0
          ? [{ type: 'message' as const, content: [] }]
          : userParts(content, contentIndex + index, ids);
      }),
    }];

/** A GenerateContent system instruction is the conversation's leading prompt. */
const geminiGenerateContentSystemToIR = (content: GeminiGenerateContentContent | undefined): IRInputTurn | undefined => {
  const parts = systemParts(content);
  return parts.length === 0 ? undefined : { kind: 'client', items: [{ type: 'prompt', role: 'system', content: parts }] };
};

const partitionContents = (payload: GeminiGenerateContentPayload): GeminiGenerateContentTurn[] => partitionGeminiGenerateContentTurns(payload.contents ?? []);

// GenerateContent declares functions in groups and narrows them through
// `toolConfig.functionCallingConfig`. The IR states that narrowing as
// `allowed_tools`, so a target keeps the permitted declarations visible and the
// choice arm says only how freely the model may choose among them.
// https://github.com/googleapis/googleapis/blob/master/google/ai/generativelanguage/v1beta/content.proto
// (FunctionCallingConfig: `allowed_function_names` only applies to ANY and
// VALIDATED, and limits which functions the model calls.)
const toolsToIR = (payload: GeminiGenerateContentPayload): Pick<IRInputRequestHeader, 'tools' | 'tool_choice'> => {
  const declarations = payload.tools?.flatMap(group => group.functionDeclarations ?? []) ?? [];
  const config = payload.toolConfig?.functionCallingConfig;
  const allowedNames = config?.allowedFunctionNames;
  const restrictable = config?.mode === 'ANY' || config?.mode === 'VALIDATED';
  const permitted = restrictable && allowedNames !== undefined && allowedNames.length > 0 ? new Set(allowedNames) : undefined;

  const tools: IRInputTool[] = declarations
    .filter(declaration => permitted === undefined || permitted.has(declaration.name))
    .map(declaration => {
      const parameters = geminiFunctionParameters(declaration) as Readonly<Record<string, unknown>> | undefined;
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
  else if (config?.mode === 'AUTO' || config?.mode === 'VALIDATED') toolChoice = 'auto';
  else if (config?.mode === 'ANY') {
    // A single permitted function is the one the model must call; several leave
    // the choice to the model among them.
    toolChoice = permitted?.size === 1 ? { type: 'function', name: [...permitted][0] } : 'required';
  }

  return {
    ...(tools.length === 0 ? {} : { tools }),
    ...(toolChoice === undefined ? {} : { tool_choice: toolChoice }),
  };
};

/**
 * A GenerateContent request read into the turns a writer consumes.
 *
 * Reading a GenerateContent conversation is stateful in two ways. A
 * `functionResponse` part states a call id only when the caller has one and
 * otherwise answers the oldest call of that name, so the reader tracks which
 * calls it has already matched. A call id the source omitted is invented from
 * the position of the content and the part, which the reader counts across the
 * whole request.
 *
 * A sidecar-resolved assistant turn never passes through this reader, but it
 * did consume source contents, and the calls it states are keyed by ids the
 * reader would otherwise not know. Both counters live in a closure each turn's
 * `toIRInputTurns` captures, so the reading stays a plain value.
 */
export const geminiGenerateContentRead = (payload: GeminiGenerateContentRequest): Reading<GeminiGenerateContentAssistantTurn> => {
  const ids: GeminiGenerateContentUnmatchedCallIds = Object.create(null);
  let contentIndex = 0;
  const prompt = geminiGenerateContentSystemToIR(payload.systemInstruction);

  // Reading is stateful: an id-less `functionResponse` answers the oldest call
  // of its name, and an omitted id is invented from the position the content
  // and part occupy. Both have to advance over every turn, which is why the
  // thunks close over the position they were created at.
  const turnSlotFor = (turn: GeminiGenerateContentTurn): TurnSlot<GeminiGenerateContentAssistantTurn> => {
    const at = contentIndex;
    contentIndex += turn.items.length;
    const toIRInputTurns = () => turnToIRTurns(turn, at, ids);
    if (turn.role !== 'assistant') return { kind: 'client', toIRInputTurns };
    return { kind: 'assistant', assistantTurn: turn.items, toIRInputTurns };
  };

  return {
    request: {
      settings: geminiGenerateContentSettingsToIR(payload),
      ...toolsToIR(payload),
    },
    turns: [
      ...(prompt === undefined ? [] : [{ kind: 'client' as const, toIRInputTurns: () => [prompt] }]),
      ...partitionContents(payload).map(turnSlotFor),
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
  const statedLevel = geminiGenerateContentThinkingLevelEffort(config?.thinkingConfig);
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
    ...(effort !== undefined && effort !== 'none' && config?.thinkingConfig?.includeThoughts === true ? { reasoning_summary: 'detailed' } : {}),
  };
};

const geminiGenerateContentToolCallId = (turnIndex: number, partIndex: number): string => `gemini_call_${turnIndex}_${partIndex}`;

export type GeminiGenerateContentUnmatchedCallIds = Record<string, string[]>;

export type GeminiGenerateContentFunctionCall = NonNullable<GeminiGenerateContentPart['functionCall']>;
export type GeminiGenerateContentFunctionResponse = NonNullable<GeminiGenerateContentPart['functionResponse']>;

export interface GeminiGenerateContentFunctionCallMatch {
  call: GeminiGenerateContentFunctionCall;
  id: string;
}

export interface GeminiGenerateContentFunctionResponseMatch {
  response: GeminiGenerateContentFunctionResponse;
  // Absent when the source stated no id and no call this reader saw is still
  // awaiting this answer: a target then pairs the result by order, which is
  // what makes it answer a call only a restored turn stated.
  id: string | undefined;
}

export const geminiGenerateContentFunctionCallMatch = (part: GeminiGenerateContentPart, ids: GeminiGenerateContentUnmatchedCallIds, turnIndex: number, partIndex: number): GeminiGenerateContentFunctionCallMatch | null => {
  const call = part.functionCall;
  if (!call) return null;

  const id = call.id ?? geminiGenerateContentToolCallId(turnIndex, partIndex);
  ids[call.name] ??= [];
  ids[call.name].push(id);

  return { call, id };
};

export const geminiGenerateContentFunctionResponseMatch = (part: GeminiGenerateContentPart, ids: GeminiGenerateContentUnmatchedCallIds, turnIndex: number, partIndex: number, remove: 'first' | 'last' = 'first'): GeminiGenerateContentFunctionResponseMatch | null => {
  const response = part.functionResponse;
  if (!response) return null;

  const unmatched = ids[response.name];
  if (response.id !== undefined) {
    const index = remove === 'first' ? unmatched?.indexOf(response.id) ?? -1 : unmatched?.lastIndexOf(response.id) ?? -1;
    if (index >= 0) unmatched?.splice(index, 1);
    return { response, id: response.id };
  }

  // An id-less answer pairs with the oldest call of its name this reader has
  // seen. When none is left, the call it answers came from a turn a sidecar
  // restored, so the result states no id and the target pairs it by position.
  return { response, id: unmatched?.shift() };
};

const GEMINI_GENERATE_CONTENT_SUPPORTED_IMAGE_MIME_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'] as const;

const GEMINI_GENERATE_CONTENT_AUDIO_MIME_TYPES = ['audio/wav', 'audio/mp3', 'audio/mpeg'] as const;

type GeminiGenerateContentAudioMimeType = (typeof GEMINI_GENERATE_CONTENT_AUDIO_MIME_TYPES)[number];

const isAudioMimeType = (value: string): value is GeminiGenerateContentAudioMimeType =>
  (GEMINI_GENERATE_CONTENT_AUDIO_MIME_TYPES as readonly string[]).includes(value);

export type GeminiGenerateContentSupportedImageMimeType = (typeof GEMINI_GENERATE_CONTENT_SUPPORTED_IMAGE_MIME_TYPES)[number];

export type GeminiGenerateContentInlineData =
  | { kind: 'image'; mimeType: GeminiGenerateContentSupportedImageMimeType; data: string }
  | { kind: 'pdf'; mimeType: 'application/pdf'; data: string }
  | { kind: 'audio'; mimeType: GeminiGenerateContentAudioMimeType; data: string }
  // Any other MIME type: carried as a file and left for the target to judge.
  | { kind: 'other'; mimeType: string; data: string };

export type GeminiGenerateContentPartKind = 'text' | 'inline_data' | 'function_call' | 'function_response' | 'file_data' | 'executable_code' | 'code_execution_result' | 'tool_call' | 'tool_response';

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
export const geminiGenerateContentPartKind = (part: GeminiGenerateContentPart): GeminiGenerateContentPartKind | null => {
  const presentFields = GEMINI_GENERATE_CONTENT_PART_DATA_FIELDS.filter(field => part[field] !== undefined);
  if (presentFields.length === 1) return GEMINI_GENERATE_CONTENT_PART_FIELD_TO_KIND[presentFields[0]];
  if (presentFields.length > 1) {
    throw new Error(`Gemini generateContent part sets conflicting content fields: ${presentFields.join(', ')}.`);
  }
  if (part.thoughtSignature !== undefined) return null;
  const keys = Object.keys(part);
  throw new Error(`Gemini generateContent part has no recognized content. Keys present: ${keys.length ? keys.join(', ') : '(none)'}.`);
};

export const geminiGenerateContentPartText = (part: GeminiGenerateContentPart): string | null => (typeof part.text === 'string' ? part.text : null);

export const geminiGenerateContentThoughtText = (part: GeminiGenerateContentPart): string | null => (part.thought === true && typeof part.text === 'string' ? part.text : null);

export const geminiGenerateContentVisibleText = (part: GeminiGenerateContentPart): string | null => (part.thought === true ? null : geminiGenerateContentPartText(part));

export const geminiGenerateContentText = (content?: GeminiGenerateContentContent): string | null => {
  const texts = content?.parts?.map(geminiGenerateContentPartText).filter((text): text is string => text !== null);

  return texts?.length ? texts.join('\n\n') : null;
};

export const geminiGenerateContentInlineData = (part: GeminiGenerateContentPart): GeminiGenerateContentInlineData | null => {
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
