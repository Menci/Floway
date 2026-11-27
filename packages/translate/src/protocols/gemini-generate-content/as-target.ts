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
import { TranslateInputException } from '../../shared/input-error.ts';
import type { GeminiGenerateContentRequest, GeminiGenerateContentStreamEvent } from '@floway-dev/protocols/gemini-generate-content';

interface GeminiTargetContext extends ToolNameContext {
  readonly fallbackModel: string;
}

interface RestoredGeminiCall extends PendingCall {
  readonly wireId?: string;
}

const statedCallIdsOf = (
  turns: readonly (IRInputTurn | RestoredAssistantTurn<GeminiGenerateContentInputAssistantTurn>)[],
): Set<string> => {
  const claimed = new Set<string>();
  for (const piece of turns) {
    if (piece.kind === 'restored') {
      for (const id of piece.synthesizedCallIds ?? []) {
        if (id !== null) claimed.add(id);
      }
      for (const entry of piece.turn) {
        for (const part of entry.parts ?? []) {
          if (part.functionCall?.id !== undefined && part.functionCall.id !== '') {
            claimed.add(part.functionCall.id);
          }
        }
      }
      continue;
    }
    if (piece.kind === 'assistant') {
      for (const item of piece.items) {
        if ((item.type === 'function_call' || item.type === 'custom_tool_call') && item.call_id !== undefined) {
          claimed.add(item.call_id);
        }
      }
    }
  }
  return claimed;
};

const collectRestoredCalls = (
  turns: readonly (IRInputTurn | RestoredAssistantTurn<GeminiGenerateContentInputAssistantTurn>)[],
): ReadonlyMap<GeminiGenerateContentInputAssistantTurn, readonly RestoredGeminiCall[]> => {
  const claimed = statedCallIdsOf(turns);
  const callsByTurn = new Map<GeminiGenerateContentInputAssistantTurn, readonly RestoredGeminiCall[]>();
  let allocated = 0;

  for (const piece of turns) {
    if (piece.kind !== 'restored') continue;
    const pending: RestoredGeminiCall[] = [];
    let idlessIndex = 0;
    for (const entry of piece.turn) {
      for (const part of entry.parts ?? []) {
        const call = part.functionCall;
        if (call === undefined) continue;
        if (call.id !== undefined && call.id !== '') {
          pending.push({ callId: call.id, name: call.name, wireId: call.id });
          continue;
        }
        const synthesizedId = piece.synthesizedCallIds?.[idlessIndex++] ?? undefined;
        if (synthesizedId !== undefined) {
          pending.push({ callId: synthesizedId, name: call.name });
          continue;
        }
        let fallbackId: string;
        do {
          allocated += 1;
          fallbackId = `gemini_idless_call_${allocated}`;
        } while (claimed.has(fallbackId));
        claimed.add(fallbackId);
        pending.push({ callId: fallbackId, name: call.name });
      }
    }
    callsByTurn.set(piece.turn, pending);
  }

  return callsByTurn;
};

// Pair every `tool_result` with its exact pending call in conversation order so
// repeated `call_id`s across separate turns never overwrite earlier bindings and
// parallel `functionResponse` runs can be ordered to match their original calls.
const resolveToolResults = (
  turns: readonly (IRInputTurnWithCallIds | RestoredAssistantTurn<GeminiGenerateContentInputAssistantTurn>)[],
  restoredCallsByTurn: ReadonlyMap<GeminiGenerateContentInputAssistantTurn, readonly RestoredGeminiCall[]>,
): GeminiGenerateContentToolResultLookup => {
  const pending: (GeminiGenerateContentMatchedCall & { readonly callId: string })[] = [];
  const matched = new Map<IRInputToolResultItemWithCallId, GeminiGenerateContentMatchedCall>();
  let nextOrder = 0;

  for (const piece of turns) {
    if (piece.kind === 'restored') {
      for (const call of restoredCallsByTurn.get(piece.turn) ?? []) {
        pending.push({
          callId: call.callId,
          name: call.name,
          ...(call.wireId === undefined ? {} : { wireId: call.wireId }),
          order: nextOrder++,
        });
      }
      continue;
    }
    if (piece.kind === 'assistant') {
      for (const item of piece.items) {
        if (item.type === 'function_call' || item.type === 'custom_tool_call') {
          pending.push({
            callId: item.call_id,
            name: item.name,
            wireId: item.call_id,
            order: nextOrder++,
          });
        }
      }
      continue;
    }
    for (const item of piece.items) {
      if (item.type !== 'tool_result') continue;
      const index = pending.findIndex(call => call.callId === item.call_id);
      if (index < 0) {
        throw new TranslateInputException(`Cannot translate tool result for unknown call_id '${item.call_id}' to Gemini GenerateContent.`);
      }
      const [entry] = pending.splice(index, 1);
      matched.set(item, {
        name: entry.name,
        ...(entry.wireId === undefined ? {} : { wireId: entry.wireId }),
        order: entry.order,
      });
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
    const restoredCallsByTurn = collectRestoredCalls(turns);
    const assigned = assignCallIds(turns, turn => restoredCallsByTurn.get(turn) ?? []);
    const flattened = allocateToolNames(request, assigned);
    const matchedToolResults = resolveToolResults(flattened.turns, restoredCallsByTurn);
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
