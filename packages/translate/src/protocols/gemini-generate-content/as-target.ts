import type { GeminiGenerateContentInputAssistantTurn } from './as-target/assistant-turn.ts';
import { readGeminiGenerateContentErrorBody } from './as-target/error.ts';
import { readGeminiGenerateContentEvents } from './as-target/events.ts';
import { geminiGenerateContentPayloadFromIR, type GeminiGenerateContentMatchedCall } from './as-target/input-from.ts';
import type { TargetProtocol } from '../../composition/index.ts';
import type { RestoredAssistantTurn } from '../../composition/reading.ts';
import { assignCallIds, type IRInputToolResultItemWithCallId, type MatchedCall, type PendingCall } from '../../composition/request/call-ids.ts';
import { allocateToolNames, type ToolNameContext } from '../../composition/request/tool-names.ts';
import type { IRInputRequestHeader, IRInputTurn } from '../../ir/input/types.ts';
import type { GeminiGenerateContentRequest, GeminiGenerateContentStreamEvent } from '@floway-dev/protocols/gemini-generate-content';

interface GeminiTargetContext extends ToolNameContext {
  readonly fallbackModel: string;
}

interface RestoredGeminiCall extends PendingCall {
  readonly wireId?: string;
}

const restoredCallsOf = (
  piece: RestoredAssistantTurn<GeminiGenerateContentInputAssistantTurn>,
): readonly RestoredGeminiCall[] => {
  const calls = piece.turn.flatMap(entry => (entry.parts ?? []).flatMap(part => (part.functionCall === undefined ? [] : [part.functionCall])));
  if (calls.length !== piece.sourceCallIds.length) {
    throw new Error('Authenticated round-trip call IDs do not match restored Gemini GenerateContent function calls');
  }
  return calls.map((call, index): RestoredGeminiCall => {
    const sourceCallId = piece.sourceCallIds[index];
    if (call.id !== undefined && call.id !== '') {
      if (sourceCallId !== call.id) {
        throw new Error('Authenticated round-trip call ID does not match restored Gemini GenerateContent wire call ID');
      }
      return { callId: call.id, name: call.name, wireId: call.id };
    }
    return {
      ...(sourceCallId === undefined ? {} : { callId: sourceCallId }),
      name: call.name,
    };
  });
};

export const geminiGenerateContentTargetProtocol: TargetProtocol<
  'geminiGenerateContent',
  GeminiGenerateContentRequest,
  GeminiGenerateContentStreamEvent,
  GeminiTargetContext
> = {
  name: 'geminiGenerateContent',
  write: (
    request: IRInputRequestHeader,
    turns: readonly (IRInputTurn | RestoredAssistantTurn<GeminiGenerateContentInputAssistantTurn>)[],
  ) => {
    const restoredCallCounts = new Map<RestoredAssistantTurn<GeminiGenerateContentInputAssistantTurn>, number>();
    const matched = new Map<IRInputToolResultItemWithCallId, MatchedCall<RestoredGeminiCall>>();
    const assigned = assignCallIds(turns, piece => {
      const calls = restoredCallsOf(piece);
      restoredCallCounts.set(piece, calls.length);
      return calls;
    }, {
      onMatch: (result, match) => {
        matched.set(result, match);
      },
    });
    const flattened = allocateToolNames(request, assigned);
    // Call positions stay invariant across `assignCallIds` and `allocateToolNames`,
    // so indexing non-restored calls by `match.order` binds every `tool_result`
    // to its allocated wire name without re-matching.
    const assistantWireNameByOrder: (string | undefined)[] = [];
    let order = 0;
    for (const piece of flattened.turns) {
      if (piece.kind === 'restored') {
        order += restoredCallCounts.get(piece)!;
      } else if (piece.kind === 'assistant') {
        for (const item of piece.items) {
          if (item.type === 'function_call' || item.type === 'custom_tool_call') {
            assistantWireNameByOrder[order++] = item.name;
          }
        }
      }
    }
    const matchedToolResults = new Map<IRInputToolResultItemWithCallId, GeminiGenerateContentMatchedCall>();
    for (const [result, match] of matched) {
      matchedToolResults.set(result, match.restored !== undefined
        ? { name: match.restored.name, ...(match.restored.wireId === undefined ? {} : { wireId: match.restored.wireId }), order: match.order }
        : { name: assistantWireNameByOrder[match.order]!, wireId: match.callId, order: match.order });
    }
    const payload = geminiGenerateContentPayloadFromIR(
      flattened.request,
      flattened.turns,
      matchedToolResults,
    );
    return {
      payload,
      context: { ...flattened.context, fallbackModel: payload.model },
    };
  },
  readEvents: (frames, context, roundTripReader) =>
    readGeminiGenerateContentEvents(frames, {
      ...context,
      roundTrip: roundTripReader,
    }),
  readError: readGeminiGenerateContentErrorBody,
};
