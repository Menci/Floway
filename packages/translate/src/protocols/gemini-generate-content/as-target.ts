import type { GeminiGenerateContentInputAssistantTurn } from './as-target/assistant-turn.ts';
import { readGeminiGenerateContentEvents } from './as-target/events.ts';
import type { GeminiGenerateContentCallLookup } from './as-target/input-from.ts';
import { geminiGenerateContentPayloadFromSegments } from './as-target/segmented-request.ts';
import type { TargetProtocol } from '../../composition/index.ts';
import type { RestoredAssistantTurn } from '../../composition/reading.ts';
import { assignCallIds, type PendingCall } from '../../composition/request/call-ids.ts';
import { allocateToolNames, type ToolNameContext } from '../../composition/request/tool-names.ts';
import type { IRInputRequestHeader, IRInputTurn } from '../../ir/input/types.ts';
import type { TranslateOptions } from '../../types.ts';
import type { GeminiGenerateContentRequest, GeminiGenerateContentStreamEvent } from '@floway-dev/protocols/gemini-generate-content';

interface GeminiTargetContext extends ToolNameContext {
  readonly fallbackModel: string;
}

const statedCallIdsOf = (
  turns: readonly (IRInputTurn | RestoredAssistantTurn<GeminiGenerateContentInputAssistantTurn>)[],
): Set<string> => {
  const claimed = new Set<string>();
  for (const piece of turns) {
    if (piece.kind === 'restored') {
      for (const entry of piece.turn) {
        for (const id of Object.values(entry.syntheticCallIds ?? {})) claimed.add(id);
        for (const part of entry.parts ?? []) {
          if (part.functionCall?.id !== undefined) claimed.add(part.functionCall.id);
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
): {
  readonly callsByTurn: ReadonlyMap<GeminiGenerateContentInputAssistantTurn, readonly PendingCall[]>;
  readonly callLookup: GeminiGenerateContentCallLookup;
} => {
  const claimed = statedCallIdsOf(turns);
  const callsByTurn = new Map<GeminiGenerateContentInputAssistantTurn, readonly PendingCall[]>();
  const callLookup: GeminiGenerateContentCallLookup = new Map();
  let allocated = 0;

  for (const piece of turns) {
    if (piece.kind !== 'restored') continue;
    const pending: PendingCall[] = [];
    for (const entry of piece.turn) {
      for (const [partIndex, part] of (entry.parts ?? []).entries()) {
        const call = part.functionCall;
        if (call === undefined) continue;
        if (call.id !== undefined && call.id !== '') {
          pending.push({ callId: call.id, name: call.name });
          callLookup.set(call.id, { name: call.name, id: call.id });
          continue;
        }
        const syntheticId = entry.syntheticCallIds?.[partIndex];
        if (syntheticId !== undefined) {
          pending.push({ callId: syntheticId, name: call.name });
          callLookup.set(syntheticId, { name: call.name });
          continue;
        }
        let fallbackId: string;
        do {
          allocated += 1;
          fallbackId = `gemini_idless_call_${allocated}`;
        } while (claimed.has(fallbackId));
        claimed.add(fallbackId);
        pending.push({ callId: fallbackId, name: call.name });
        callLookup.set(fallbackId, { name: call.name });
      }
    }
    callsByTurn.set(piece.turn, pending);
  }

  return { callsByTurn, callLookup };
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
    options: TranslateOptions,
  ) => {
    const { callsByTurn, callLookup } = collectRestoredCalls(turns);
    const assigned = assignCallIds(turns, turn => callsByTurn.get(turn) ?? []);
    const flattened = allocateToolNames(request, assigned);
    const payload = geminiGenerateContentPayloadFromSegments(
      flattened.request,
      flattened.turns,
      callLookup,
      { fallbackMaxOutputTokens: options.fallbackMaxOutputTokens },
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
};
