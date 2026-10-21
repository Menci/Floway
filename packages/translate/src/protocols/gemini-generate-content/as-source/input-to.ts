import { geminiGenerateContentInlineData, geminiGenerateContentPartKind, geminiGenerateContentPartText, geminiGenerateContentText, geminiGenerateContentThoughtText, geminiGenerateContentVisibleText } from './content.ts';
import { partitionGeminiGenerateContentTurns, type GeminiGenerateContentConversationTurn as GeminiGenerateContentTurn } from './conversation-turns.ts';
import { geminiGenerateContentFunctionCallPart, geminiGenerateContentFunctionResponsePart, type GeminiGenerateContentToolCallIds } from './tools.ts';
import type {
  IRInputAssistantContentPart,
  IRInputAssistantItem,
  IRInputConversation,
  IRInputMedia,
  IRInputTextPart,
  IRInputToolResultItem,
  IRInputTurn,
  IRInputUserContentPart,
  IRInputUserItem,
} from '../../../ir/input/types.ts';
import { warnDroppedUnrecognizedAssistantReasoning } from '../../../round-trip/resolve.ts';
import { TranslatorInputError } from '../../../translator-input-error.ts';
import type { GeminiGenerateContentContent, GeminiGenerateContentPart, GeminiGenerateContentPayload } from '@floway-dev/protocols/gemini-generate-content';

const inlineMedia = (part: GeminiGenerateContentPart): IRInputMedia | null => {
  const inlineData = geminiGenerateContentInlineData(part);
  return inlineData === null ? null : { source_kind: 'base64', media_type: inlineData.mimeType, data: inlineData.data };
};

const inlinePart = (part: GeminiGenerateContentPart, target?: string): IRInputUserContentPart => {
  const inlineData = geminiGenerateContentInlineData(part);
  if (inlineData === null) throw new TranslatorInputError('Expected inline data.');
  switch (inlineData.kind) {
  case 'image': return { type: 'image', image: inlineMedia(part)! };
  case 'pdf': return { type: 'file', file: inlineMedia(part)! };
  case 'audio': return { type: 'audio', audio: { media_type: inlineData.mimeType, data: inlineData.data } };
  case 'unsupported': throw new TranslatorInputError(`Cannot translate Gemini generateContent inlineData MIME type '${inlineData.mimeType}'${target === undefined ? '.' : ` to ${target}.`}`);
  }
};

const userParts = (content: GeminiGenerateContentContent, turnIndex: number, ids: GeminiGenerateContentToolCallIds, target?: string): IRInputUserItem[] => {
  const items: IRInputUserItem[] = [];
  const pending: IRInputUserContentPart[] = [];
  const flush = (): void => {
    if (pending.length === 0) return;
    items.push({ type: 'message', role: 'user', content: pending.splice(0) });
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
      pending.push(inlinePart(part, target));
      return;
    default:
      throw new TranslatorInputError(`"${kind}" parts are not supported in user content.`);
    }
  });
  flush();
  return items;
};

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
        items.push({ type: 'reasoning', id: geminiGenerateContentReasoningId(turnIndex, partIndex), summary: [thoughtText] });
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

/**
 * One output IR turn per source content. A target that keeps its own message
 * boundaries (Messages) uses this so two adjacent GenerateContent contents do
 * not merge into one message.
 */
export const geminiGenerateContentContentsToIRTurns = (
  turn: GeminiGenerateContentTurn,
  contentIndex: number,
  ids: GeminiGenerateContentToolCallIds,
  target?: string,
): IRInputTurn[] => turn.items.map((content, index) => {
  if (turn.role === 'assistant') {
    return {
      role: 'assistant' as const,
      items: (content.parts?.length ?? 0) === 0
        ? [{ type: 'message' as const, content: [{ type: 'text' as const, text: '' }] }]
        : assistantItems(content, contentIndex + index, ids),
    };
  }
  if (content.role !== 'user' && content.role !== undefined) {
    throw new TranslatorInputError(`"${(content as { role: string }).role}" is not a supported content role.`);
  }
  return {
    role: 'user' as const,
    items: (content.parts?.length ?? 0) === 0
      ? [{ type: 'message' as const, role: 'user' as const, content: [] }]
      : userParts(content, contentIndex + index, ids, target),
  };
});

/** Turn-level entry point so a pair can splice a resolved assistant turn. */
/** Whether a turn carries a vendor-signed thought signature the output IR cannot hold. */
export const geminiGenerateContentReasoningId = (turnIndex: number, partIndex: number): string => `gemini_reasoning_${turnIndex}_${partIndex}`;

export const geminiGenerateContentDropsReasoning = (turn: GeminiGenerateContentTurn): boolean => turn.role === 'assistant'
  && turn.items.some(content => content.parts?.some(part => part.thoughtSignature !== undefined) ?? false);

export const geminiGenerateContentTurnToIR = (
  turn: GeminiGenerateContentTurn,
  contentIndex: number,
  ids?: GeminiGenerateContentToolCallIds,
  target?: string,
): IRInputTurn => {
  const toolIds = ids ?? Object.create(null);
  if (turn.role === 'assistant') {
    return {
      role: 'assistant',
      items: turn.items.flatMap((content, index) => (content.parts?.length ?? 0) === 0
        ? [{ type: 'message' as const, content: [{ type: 'text' as const, text: '' }] }]
        : assistantItems(content, contentIndex + index, toolIds)),
    };
  }
  return {
    role: 'user',
    items: turn.items.flatMap((content, index) => {
      if (content.role !== 'user' && content.role !== undefined) {
        throw new TranslatorInputError(`"${(content as { role: string }).role}" is not a supported content role.`);
      }
      return (content.parts?.length ?? 0) === 0
        ? [{ type: 'message' as const, role: 'user' as const, content: [] }]
        : userParts(content, contentIndex + index, toolIds, target);
    }),
  };
};

export const geminiGenerateContentInputToIR = (payload: GeminiGenerateContentPayload): IRInputConversation => {
  const ids: GeminiGenerateContentToolCallIds = Object.create(null);
  const turns: IRInputTurn[] = [];

  const system = systemParts(payload.systemInstruction);
  if (system.length > 0) turns.push({ role: 'user', items: [{ type: 'message', role: 'system', content: system }] });

  let contentIndex = 0;
  for (const turn of partitionGeminiGenerateContentTurns(payload.contents ?? [])) {
    for (const [index, content] of turn.items.entries()) {
      if (turn.role === 'assistant') {
        // A thought signature is a vendor-signed value with no cross-vendor
        // meaning, so it never reaches the output IR.
        void warnDroppedUnrecognizedAssistantReasoning;
        const items = assistantItems(content, contentIndex + index, ids);
        turns.push({ role: 'assistant', items });
        continue;
      }
      if (content.role !== 'user' && content.role !== undefined) {
        throw new TranslatorInputError(`"${(content as { role: string }).role}" is not a supported content role.`);
      }
      turns.push({ role: 'user', items: (content.parts?.length ?? 0) === 0 ? [{ type: 'message', role: 'user', content: [] }] : userParts(content, contentIndex + index, ids) });
    }
    contentIndex += turn.items.length;
  }
  return { turns };
};
