import type { GeminiGenerateContentInputAssistantTurn } from './as-target/assistant-turn.ts';
import { readGeminiGenerateContentErrorBody } from './as-target/error.ts';
import { readGeminiGenerateContentEvents } from './as-target/events.ts';
import type { GeminiGenerateContentMatchedCall } from './as-target/input-from.ts';
import { geminiGenerateContentPayloadFromSegments } from './as-target/segmented-request.ts';
import type { TargetProtocol } from '../../composition/index.ts';
import type { RestoredAssistantTurn } from '../../composition/reading.ts';
import { assignCallIds, type IRInputToolResultItemWithCallId, type PendingCall } from '../../composition/request/call-ids.ts';
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
    const restoredCallsByPiece = new Map<RestoredAssistantTurn<GeminiGenerateContentInputAssistantTurn>, readonly RestoredGeminiCall[]>();
    const matchedOrder = new Map<IRInputToolResultItemWithCallId, number>();
    const assigned = assignCallIds(turns, piece => {
      const calls = restoredCallsOf(piece);
      restoredCallsByPiece.set(piece, calls);
      return calls;
    }, {
      onMatch: (result, match) => {
        matchedOrder.set(result, match.order);
      },
    });
    const flattened = allocateToolNames(request, assigned);
    // Call positions stay invariant across `assignCallIds` and `allocateToolNames`,
    // so indexing by `match.order` binds every `tool_result` to its allocated wire
    // name, optional wire ID, and original call order without re-matching.
    const callsByOrder: GeminiGenerateContentMatchedCall[] = [];
    for (const piece of flattened.turns) {
      if (piece.kind === 'restored') {
        for (const call of restoredCallsByPiece.get(piece) ?? []) {
          callsByOrder.push({
            name: call.name,
            ...(call.wireId === undefined ? {} : { wireId: call.wireId }),
            order: callsByOrder.length,
          });
        }
      } else if (piece.kind === 'assistant') {
        for (const item of piece.items) {
          if (item.type === 'function_call' || item.type === 'custom_tool_call') {
            callsByOrder.push({ name: item.name, wireId: item.call_id, order: callsByOrder.length });
          }
        }
      }
    }
    const matchedToolResults: Map<IRInputToolResultItemWithCallId, GeminiGenerateContentMatchedCall> = new Map();
    for (const [result, order] of matchedOrder) {
      matchedToolResults.set(result, callsByOrder[order]!);
    }
    const payload = geminiGenerateContentPayloadFromSegments(
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
