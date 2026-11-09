import { klona } from 'klona/json';

import { geminiGenerateContentInlineData, geminiGenerateContentPartKind, geminiGenerateContentPartText, geminiGenerateContentText, geminiGenerateContentThoughtText, geminiGenerateContentVisibleText } from './content.ts';
import { partitionGeminiGenerateContentTurns, type GeminiGenerateContentConversationTurn as GeminiGenerateContentTurn } from './conversation-turns.ts';
import { geminiGenerateContentReasoningEffort, geminiGenerateContentThinkingLevelEffort } from './reasoning.ts';
import { geminiFunctionParameters, geminiResponseSchema } from './schema.ts';
import { geminiGenerateContentFunctionCallPart, geminiGenerateContentFunctionResponsePart, type GeminiGenerateContentToolCallIds } from './tools.ts';
import type { IRInputLayout, IRInputSlot } from '../../../ir/input/layout.ts';
import type { GeminiGenerateContentAssistantTurn } from './round-trip.ts';
import type {
  IRInputAssistantContentPart,
  IRInputRequest,
  IRInputSettings,
  IRInputTool,
  IRInputToolChoice,
  IRInputOutputFormat,
  IRInputAssistantItem,
  IRInputMedia,
  IRInputTextPart,
  IRInputToolResultItem,
  IRInputTurn,
  IRInputUserContentPart,
  IRInputClientItem,
} from '../../../ir/input/types.ts';
import { TranslatorInputError } from '../../../translator-input-error.ts';
import type { GeminiGenerateContentContent, GeminiGenerateContentPart, GeminiGenerateContentPayload, GeminiGenerateContentRequest } from '@floway-dev/protocols/gemini-generate-content';

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
  case 'unsupported': return { type: 'file', file: inlineMedia(part)! };
  }
};

const userParts = (content: GeminiGenerateContentContent, turnIndex: number, ids: GeminiGenerateContentToolCallIds): IRInputClientItem[] => {
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
      const { response, id } = geminiGenerateContentFunctionResponsePart(part, ids, turnIndex, partIndex)!;
      flush();
      const result: IRInputToolResultItem = { type: 'tool_result', call_id: id, output: JSON.stringify(response.response) };
      items.push(result);
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

const assistantItems = (content: GeminiGenerateContentContent, turnIndex: number, ids: GeminiGenerateContentToolCallIds): IRInputAssistantItem[] => {
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
      const { call, id } = geminiGenerateContentFunctionCallPart(part, ids, turnIndex, partIndex)!;
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
  ids: GeminiGenerateContentToolCallIds,
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

/** Whether a turn carries a vendor-signed thought signature the input IR cannot hold. */
/** A GenerateContent system instruction is the conversation's leading prompt. */
const geminiGenerateContentSystemToIR = (content: GeminiGenerateContentContent | undefined): IRInputTurn | undefined => {
  const parts = systemParts(content);
  return parts.length === 0 ? undefined : { kind: 'client', items: [{ type: 'prompt', role: 'system', content: parts }] };
};

const partitionContents = (payload: GeminiGenerateContentPayload): GeminiGenerateContentTurn[] => partitionGeminiGenerateContentTurns(payload.contents ?? []);

// GenerateContent declares functions in groups and narrows them through
// `toolConfig.functionCallingConfig`. A target has no declaration-level
// selector arm it can reach here, so the narrowed set is what the model sees:
// the declarations the request permits, plus the mode that says how freely the
// model may choose among them.
// https://github.com/googleapis/googleapis/blob/master/google/ai/generativelanguage/v1beta/content.proto
// (FunctionCallingConfig: `allowed_function_names` only applies to ANY and
// VALIDATED, and limits which functions the model calls.)
const toolsToIR = (payload: GeminiGenerateContentPayload): Pick<IRInputRequest, 'tools' | 'tool_choice'> => {
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
 * A GenerateContent request prepared for translation.
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
 * reader would otherwise not know. Presenting the request, the conversation,
 * and the reader that owns both counters together keeps that state where it
 * belongs rather than in every route.
 */
export const geminiGenerateContentOpen = (payload: GeminiGenerateContentRequest): IRInputLayout<GeminiGenerateContentAssistantTurn> => {
  const ids: GeminiGenerateContentToolCallIds = Object.create(null);
  let contentIndex = 0;
  const prompt = geminiGenerateContentSystemToIR(payload.systemInstruction);

  // Reading is stateful: an id-less `functionResponse` answers the oldest call
  // of its name, and an omitted id is invented from the position the content
  // and part occupy. Both have to advance over every turn, which is why the
  // thunks close over the position they were created at.
  const slotFor = (turn: GeminiGenerateContentTurn): IRInputSlot<GeminiGenerateContentAssistantTurn> => {
    const at = contentIndex;
    contentIndex += turn.items.length;
    if (turn.role !== 'assistant') {
      return { kind: 'client', toIRTurn: () => turnToIRTurns(turn, at, ids) };
    }
    return {
      kind: 'assistant',
      assistantTurn: turn.items,
      toIRTurn: () => turnToIRTurns(turn, at, ids),
    };
  };

  return {
    request: {
      conversation: { turns: [] },
      settings: geminiGenerateContentSettingsToIR(payload),
      ...toolsToIR(payload),
    },
    slots: [
      ...(prompt === undefined ? [] : [{ kind: 'client' as const, toIRTurn: () => [prompt] }]),
      ...partitionContents(payload).map(slotFor),
    ],
    // A restored turn never passed through `turnToIRTurns`, so its calls are
    // registered here — with the ids the target states, which is what a later
    // id-less result has to name.
    observePendingCalls: pending => {
      for (const { callId, name } of pending) {
        ids[name] ??= [];
        ids[name].push(callId);
      }
    },
  };
};

/** GenerateContent keeps every sampling knob inside `generationConfig`. */
const geminiGenerateContentSettingsToIR = (payload: GeminiGenerateContentRequest): IRInputSettings => {
  const config = payload.generationConfig;
  const reasoningEffort = geminiGenerateContentReasoningEffort(config?.thinkingConfig);
  // A level stated outright replaces the one inferred from a budget; an empty
  // string states no level, so the budget's answer stands.
  const statedLevel = geminiGenerateContentThinkingLevelEffort(config?.thinkingConfig);
  const levelEffort = statedLevel === '' ? undefined : statedLevel;
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
    ...(config?.candidateCount === undefined ? {} : { candidate_count: config.candidateCount }),
    ...(config?.presencePenalty === undefined ? {} : { presence_penalty: config.presencePenalty }),
    ...(config?.frequencyPenalty === undefined ? {} : { frequency_penalty: config.frequencyPenalty }),
    ...(reasoningEffort === null ? {} : { reasoning_effort: reasoningEffort }),
    // A level and a token budget are different quantities, and a caller that
    // writes both means both: the level bounds how hard the model thinks and the
    // budget bounds what it may spend. A level stated outright replaces the one
    // inferred from the budget rather than adding a second axis — and a named
    // level is translated to the effort name the targets share.
    ...(levelEffort === undefined ? {} : { reasoning_effort: levelEffort }),
    ...(config?.thinkingConfig?.thinkingBudget === undefined || config.thinkingConfig.thinkingBudget <= 0 ? {} : { reasoning_budget: config.thinkingConfig.thinkingBudget }),
    // A negative budget is GenerateContent's way of saying the target chooses it.
    ...(config?.thinkingConfig?.thinkingBudget === undefined || config.thinkingConfig.thinkingBudget >= 0 ? {} : { reasoning_dynamic: true }),
    // GenerateContent states readable reasoning as a boolean; the neutral
    // spelling names how much of it the caller wants.
    ...(reasoningEffort !== null && reasoningEffort !== 'none' && config?.thinkingConfig?.includeThoughts === true ? { reasoning_summary: 'detailed' } : {}),
  };
};
