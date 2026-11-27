import type { GeminiGenerateContentInputAssistantTurn } from './as-target/assistant-turn.ts';
import { readGeminiGenerateContentErrorBody } from './as-target/error.ts';
import { readGeminiGenerateContentEvents } from './as-target/events.ts';
import type { GeminiGenerateContentMatchedCall, GeminiGenerateContentToolResultLookup } from './as-target/input-from.ts';
import { geminiGenerateContentPayloadFromSegments } from './as-target/segmented-request.ts';
import type { TargetProtocol } from '../../composition/index.ts';
import type { RestoredAssistantTurn } from '../../composition/reading.ts';
import { assignCallIds, type IRInputToolResultItemWithCallId, type IRInputTurnWithCallIds, type PendingCall } from '../../composition/request/call-ids.ts';
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
  const pending: RestoredGeminiCall[] = [];
  let callIndex = 0;
  for (const entry of piece.turn) {
    for (const part of entry.parts ?? []) {
      const call = part.functionCall;
      if (call === undefined) continue;
      if (callIndex >= piece.sourceCallIds.length) {
        throw new Error('Authenticated round-trip call IDs do not match restored Gemini GenerateContent function calls');
      }
      const sourceCallId = piece.sourceCallIds[callIndex++];
      if (call.id !== undefined && call.id !== '') {
        if (sourceCallId !== call.id) {
          throw new Error('Authenticated round-trip call ID does not match restored Gemini GenerateContent wire call ID');
        }
        pending.push({ callId: call.id, name: call.name, wireId: call.id });
        continue;
      }
      pending.push({
        ...(sourceCallId === undefined ? {} : { callId: sourceCallId }),
        name: call.name,
      });
    }
  }
  if (callIndex !== piece.sourceCallIds.length) {
    throw new Error('Authenticated round-trip call IDs do not match restored Gemini GenerateContent function calls');
  }
  return pending;
};

// Pair every `tool_result` with its exact pending call in conversation order so
// repeated `call_id`s across separate turns never overwrite earlier bindings and
// parallel `functionResponse` runs can be ordered to match their original calls.
const resolveToolResults = (
  turns: readonly (IRInputTurnWithCallIds | RestoredAssistantTurn<GeminiGenerateContentInputAssistantTurn>)[],
  restoredCallsByPiece: ReadonlyMap<RestoredAssistantTurn<GeminiGenerateContentInputAssistantTurn>, readonly RestoredGeminiCall[]>,
  restoredMatches: ReadonlyMap<IRInputToolResultItemWithCallId, RestoredGeminiCall>,
): GeminiGenerateContentToolResultLookup => {
  const restoredOrder = new Map<RestoredGeminiCall, number>();
  const pendingOrdinary: { readonly callId: string; readonly name: string; readonly order: number }[] = [];
  const matched = new Map<IRInputToolResultItemWithCallId, GeminiGenerateContentMatchedCall>();
  let nextOrder = 0;

  for (const piece of turns) {
    if (piece.kind === 'restored') {
      for (const call of restoredCallsByPiece.get(piece) ?? []) {
        restoredOrder.set(call, nextOrder++);
      }
      continue;
    }
    if (piece.kind === 'assistant') {
      for (const item of piece.items) {
        if (item.type === 'function_call' || item.type === 'custom_tool_call') {
          pendingOrdinary.push({ callId: item.call_id, name: item.name, order: nextOrder++ });
        }
      }
      continue;
    }
    for (const item of piece.items) {
      if (item.type !== 'tool_result') continue;
      const restoredCall = restoredMatches.get(item);
      if (restoredCall !== undefined) {
        const order = restoredOrder.get(restoredCall);
        if (order === undefined) {
          throw new Error(`Matched restored Gemini GenerateContent call '${restoredCall.name}' has no conversation order.`);
        }
        matched.set(item, {
          name: restoredCall.name,
          ...(restoredCall.wireId === undefined ? {} : { wireId: restoredCall.wireId }),
          order,
        });
        continue;
      }
      const index = pendingOrdinary.findIndex(call => call.callId === item.call_id);
      if (index < 0) {
        throw new Error(`Matched ordinary Gemini GenerateContent tool result for unknown call_id '${item.call_id}'.`);
      }
      const [entry] = pendingOrdinary.splice(index, 1);
      matched.set(item, { name: entry.name, wireId: entry.callId, order: entry.order });
    }
  }

  return matched;
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
    const restoredMatches = new Map<IRInputToolResultItemWithCallId, RestoredGeminiCall>();
    const assigned = assignCallIds(turns, piece => {
      const calls = restoredCallsOf(piece);
      restoredCallsByPiece.set(piece, calls);
      return calls;
    }, {
      onMatch: (result, call) => {
        restoredMatches.set(result, call);
      },
    });
    const flattened = allocateToolNames(request, assigned);
    const matchedToolResults = resolveToolResults(flattened.turns, restoredCallsByPiece, restoredMatches);
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
