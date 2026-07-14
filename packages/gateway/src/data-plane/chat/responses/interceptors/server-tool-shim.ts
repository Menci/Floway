import { jsonrepair } from 'jsonrepair';

import type { ResponsesInterceptor, ResponsesInvocation } from './types.ts';
import type { ChatGatewayCtx } from '../../shared/gateway-ctx.ts';
import { truncatePreservingCodePoints } from '../../shared/text.ts';
import type { StatefulResponsesStore } from '../items/store.ts';
import type { InterceptorRun } from '@floway-dev/interceptor';
import { eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import type {
  CanonicalResponsesPayload,
  ResponsesFunctionTool,
  ResponsesHostedTool,
  ResponsesInputItem,
  ResponsesOutputItem,
  ResponsesResult,
  ResponsesStreamEvent,
  ResponsesTool,
  ResponsesToolChoice,
} from '@floway-dev/protocols/responses';
import type { EventResultMetadata, ExecuteResult } from '@floway-dev/provider';

export interface MergeUsage {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  input_tokens_details?: { cached_tokens: number };
  output_tokens_details?: { reasoning_tokens: number };
}

export interface MergeState {
  sequenceNumber: number;
  outputIndex: number;
  accumulatedOutput: Map<number, ResponsesOutputItem>;
  accumulatedUsage: MergeUsage;
  lastSeenModel: string | null;
  synthesizedResponseId: string;
  upstreamResponseSnapshot: ResponsesResult | undefined;
}

export interface InterceptedFunctionCall {
  callId: string;
  name: string;
  /**
   * Parsed and jsonrepair-cleaned `arguments` object. `null` when the
   * raw upstream string is not a JSON object even after jsonrepair —
   * dispatchers handle that case via their own error path. Dispatchers
   * that persist function-call inputs across turns should serialize
   * this rather than the raw upstream string; replaying the raw form
   * would re-break the next turn the same way it broke this one.
   */
  arguments: Record<string, unknown> | null;
}

export interface ServerToolTerminal {
  item: ServerToolOutputItem;
  endEvents: ServerToolLifecycleEvent[];
  /**
   * Optional server-only blob registered on
   * `request.statefulResponsesStore` under `slot.id` before
   * the slot's wire item leaves materialize. The persistence layer stores it in
   * `payload.private`; the replay-side `transformItems` reads it back to
   * reconstruct the full IR.
   */
  privatePayload?: unknown;
}

export interface ServerToolResultSlot {
  id: string;
  startItem: ServerToolOutputItem;
  startEvents: readonly ServerToolLifecycleEvent[];
  // The deferred portion of a slot's lifecycle, driven at materialization
  // time. It yields any intermediate lifecycle events as they arrive — e.g.
  // progressively-rendered `image_generation_call.partial_image` frames a
  // streamed backend delivers over the course of the call — and returns the
  // terminal item plus its closing events (and an optional server-only
  // `privatePayload`). A tool with no progressive output simply yields nothing
  // and returns immediately.
  run: () => AsyncGenerator<ServerToolLifecycleEvent, ServerToolTerminal>;
}

export type ServerToolOutputItem = { type: string; id?: string; [key: string]: unknown };

export type ServerToolLifecycleEvent = { type: string; [key: string]: unknown };

export interface ServerToolLoopState {
  iterationCount: number;
  remainingToolCalls: number | undefined;
}

export interface DispatchedServerToolSlot {
  intercepted: InterceptedFunctionCall;
  slot: ServerToolResultSlot;
  outputIndex: number;
}

export type ServerToolDispatcher = (args: {
  intercepted: InterceptedFunctionCall;
  loopState: ServerToolLoopState;
}) => ServerToolResultSlot[];

// Keep hosted matching, function injection, and dispatch atomic so a
// registration cannot silently omit part of a server-tool family.
export interface ServerToolHostedDispatch {
  hostedTypes: readonly string[];
  canonicalize: (raw: ResponsesTool) => ResponsesHostedTool | undefined;
  buildFunctionTool: (canonical: ResponsesHostedTool, toolName: string) => ResponsesFunctionTool;
  dispatcher: ServerToolDispatcher;
}

export type ServerToolPrepareResult =
  | { type: 'inactive' }
  // `errorType` / `code` override the envelope for tools that emulate an
  // upstream's rejection vocabulary. An omitted code falls back to the
  // generic `invalid_request_error`; explicit null is preserved verbatim.
  | { type: 'invalid-request'; message: string; param: string | null; errorType?: string; code?: string | null }
  | {
    type: 'active';
    baseToolName: string;
    // History rewrite, applied whether or not the tool is hosted this
    // turn so items echoed from a previous turn's output become
    // upstream-readable even on a request that no longer declares the
    // hosted tool.
    transformItems?: (items: ResponsesInputItem[], toolName: string) => ResponsesInputItem[];
    // Present only when the request declares this hosted tool; absent for
    // replay-only activation.
    hosted?: ServerToolHostedDispatch;
  };

export type ServerToolRegistration = (invocation: ResponsesInvocation, gatewayCtx: ChatGatewayCtx) => ServerToolPrepareResult | Promise<ServerToolPrepareResult>;

type ActiveServerTool = Extract<ServerToolPrepareResult, { type: 'active' }> & {
  toolName: string;
  // Absent only for replay activation; otherwise drives `tools` echo restore.
  canonicalHostedTool: ResponsesHostedTool | undefined;
  // Captures the exact forced choice shape before request rewriting.
  originalToolChoice: Exclude<ResponsesToolChoice, string> | undefined;
};

// How a single upstream turn ended, as observed while consuming its
// stream. Carries the raw upstream `response` for failed/incomplete so
// the loop can lift the upstream `error` / `incomplete_details`, plus a
// `bare-error-pre-shell` variant for an `error` event that arrived
// before any `response.created` (no model known yet). Distinct from
// `SynthesizedTerminal`, which is the shim's own outgoing terminal.
export type UpstreamTerminal =
  | { kind: 'completed' }
  | { kind: 'failed'; response: ResponsesResult }
  | { kind: 'incomplete'; response: ResponsesResult }
  | { kind: 'bare-error-pre-shell'; error: { message: string; code: string } };

export interface TurnSummary {
  dispatched: Array<{ intercepted: InterceptedFunctionCall; slots: DispatchedServerToolSlot[] }>;
  sawClientToolCall: boolean;
  turnUsage: MergeUsage;
  terminalStatus: UpstreamTerminal;
}

type LatestUpstreamMetadata = Pick<EventResultMetadata, 'modelIdentity' | 'performance'>;

export const createMergeState = (): MergeState => ({
  sequenceNumber: 0,
  outputIndex: 0,
  accumulatedOutput: new Map(),
  accumulatedUsage: {},
  lastSeenModel: null,
  synthesizedResponseId: `resp_shim_${crypto.randomUUID().replace(/-/g, '')}`,
  upstreamResponseSnapshot: undefined,
});

export const materializeAccumulatedOutput = (state: MergeState): ResponsesOutputItem[] => {
  const sorted = [...state.accumulatedOutput.keys()].sort((a, b) => a - b);
  return sorted.map(k => state.accumulatedOutput.get(k)!);
};

export const sumUsage = (a: MergeUsage, b: MergeUsage): MergeUsage => {
  const out: MergeUsage = {};
  const sumScalar = (key: 'input_tokens' | 'output_tokens' | 'total_tokens') => {
    if (a[key] !== undefined || b[key] !== undefined) out[key] = (a[key] ?? 0) + (b[key] ?? 0);
  };
  sumScalar('input_tokens');
  sumScalar('output_tokens');
  sumScalar('total_tokens');
  if (a.input_tokens_details !== undefined || b.input_tokens_details !== undefined) {
    out.input_tokens_details = {
      cached_tokens: (a.input_tokens_details?.cached_tokens ?? 0) + (b.input_tokens_details?.cached_tokens ?? 0),
    };
  }
  if (a.output_tokens_details !== undefined || b.output_tokens_details !== undefined) {
    out.output_tokens_details = {
      reasoning_tokens: (a.output_tokens_details?.reasoning_tokens ?? 0) + (b.output_tokens_details?.reasoning_tokens ?? 0),
    };
  }
  return out;
};

const usageForWire = (state: MergeState): ResponsesResult['usage'] => {
  const u = state.accumulatedUsage;
  if (
    u.input_tokens === undefined
    && u.output_tokens === undefined
    && u.total_tokens === undefined
    && u.input_tokens_details === undefined
    && u.output_tokens_details === undefined
  ) {
    return undefined;
  }
  return {
    input_tokens: u.input_tokens ?? 0,
    output_tokens: u.output_tokens ?? 0,
    total_tokens: u.total_tokens ?? 0,
    ...(u.input_tokens_details !== undefined ? { input_tokens_details: u.input_tokens_details } : {}),
    ...(u.output_tokens_details !== undefined ? { output_tokens_details: u.output_tokens_details } : {}),
  };
};

const usageOf = (usage: ResponsesResult['usage']): MergeUsage => {
  if (usage === undefined) return {};
  const out: MergeUsage = {};
  if (usage.input_tokens !== undefined) out.input_tokens = usage.input_tokens;
  if (usage.output_tokens !== undefined) out.output_tokens = usage.output_tokens;
  if (usage.total_tokens !== undefined) out.total_tokens = usage.total_tokens;
  if (usage.input_tokens_details !== undefined) out.input_tokens_details = usage.input_tokens_details;
  if (usage.output_tokens_details !== undefined) out.output_tokens_details = usage.output_tokens_details;
  return out;
};

const rewriteHostedToolChoice = (
  toolChoice: ResponsesToolChoice | null | undefined,
  active: readonly ActiveServerTool[],
): ResponsesToolChoice | null | undefined => {
  if (toolChoice == null || typeof toolChoice === 'string') return toolChoice;
  for (const entry of active) {
    if (entry.hosted === undefined) continue;
    if (entry.hosted.hostedTypes.includes(toolChoice.type)) return { type: 'function', name: entry.toolName };
  }
  return toolChoice;
};

// The shim demotes forced choice to `auto` after the first turn, so synthesized
// echoes restore the captured client shape rather than the final upstream echo.
const restoreEchoedToolChoice = (
  toolChoice: ResponsesToolChoice | null | undefined,
  active: readonly ActiveServerTool[],
): ResponsesToolChoice | null | undefined => {
  for (const entry of active) {
    if (entry.originalToolChoice !== undefined) return entry.originalToolChoice;
  }
  return toolChoice;
};

// Inverse of the request-side hosted→function rewrite, applied to the
// upstream-echoed tools array. Non-injected entries pass through
// verbatim so upstream-side default enrichment on ordinary client
// function tools survives.
const restoreEchoedTools = (
  tools: readonly ResponsesTool[] | undefined,
  active: readonly ActiveServerTool[],
): ResponsesTool[] | undefined => {
  if (tools === undefined) return undefined;
  return tools.map(tool => {
    if (tool.type !== 'function') return tool;
    for (const entry of active) {
      if (entry.canonicalHostedTool !== undefined && tool.name === entry.toolName) {
        return entry.canonicalHostedTool;
      }
    }
    return tool;
  });
};

export const resolveServerToolName = (baseName: string, tools: readonly ResponsesTool[]): string => {
  const MAX_NAME_RESOLUTION_ATTEMPTS = 1000;
  const taken = new Set(tools.flatMap(tool => (tool.type === 'function' || tool.type === 'custom') ? [tool.name] : []));
  if (!taken.has(baseName)) return baseName;
  for (let i = 2; i <= MAX_NAME_RESOLUTION_ATTEMPTS; i++) {
    const candidate = `${baseName}_${i}`;
    if (!taken.has(candidate)) return candidate;
  }
  throw new Error(`Unable to resolve a free server tool function name for ${baseName} within ${MAX_NAME_RESOLUTION_ATTEMPTS} attempts`);
};

// Azure and Copilot both deduplicate repeated hosted-tool declarations as one
// family and retain the last complete declaration, including aliases and
// configuration. The replacement occupies the first declaration's array slot
// so unrelated tools retain their relative order.
// https://github.com/Menci/Floway/pull/172#issuecomment-4971739422
const rewriteToolsForHostedShim = (
  tools: readonly ResponsesTool[],
  hosted: ServerToolHostedDispatch,
  toolName: string,
): { rewritten: ResponsesTool[]; canonicalHostedTool: ResponsesHostedTool } => {
  const rewritten: ResponsesTool[] = [];
  let canonicalHostedTool: ResponsesHostedTool | undefined = undefined;
  let replacementIndex = -1;
  for (const raw of tools) {
    const canonical = hosted.canonicalize(raw);
    if (canonical === undefined) {
      rewritten.push(raw);
      continue;
    }
    if (replacementIndex === -1) {
      replacementIndex = rewritten.length;
      rewritten.push(raw);
    }
    canonicalHostedTool = canonical;
  }
  if (canonicalHostedTool === undefined) {
    throw new Error('Hosted server-tool registration did not match any request tool');
  }
  rewritten[replacementIndex] = hosted.buildFunctionTool(canonicalHostedTool, toolName);
  return { rewritten, canonicalHostedTool };
};

export const parseServerToolArguments = (argumentsJson: string): Record<string, unknown> | null => {
  if (argumentsJson === '') return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonrepair(argumentsJson));
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }
  return parsed as Record<string, unknown>;
};

const syntheticInProgressResponse = (
  state: MergeState,
  id: string,
  model: string,
  active: readonly ActiveServerTool[],
): ResponsesResult => {
  if (state.upstreamResponseSnapshot === undefined) {
    throw new Error('Server-tool shim cannot synthesize a Responses in-progress envelope before upstream `response.created` is captured.');
  }
  const snapshot = state.upstreamResponseSnapshot;
  const restoredTools = restoreEchoedTools(snapshot.tools, active);
  const restoredToolChoice = restoreEchoedToolChoice(snapshot.tool_choice, active);
  return {
    ...snapshot,
    id,
    object: 'response',
    model,
    output: [],
    status: 'in_progress',
    error: null,
    incomplete_details: null,
    ...(restoredTools !== undefined ? { tools: restoredTools } : {}),
    ...(restoredToolChoice !== undefined ? { tool_choice: restoredToolChoice } : {}),
  };
};

const rewriteOutputIndex = (
  event: ResponsesStreamEvent,
  openItems: Map<number, number>,
  openItemIds: Map<number, string>,
  merge: MergeState,
): ResponsesStreamEvent | null => {
  const indexed = event as ResponsesStreamEvent & { output_index?: unknown; item_id?: unknown };
  if (typeof indexed.output_index !== 'number') return null;
  let downstreamIndex = openItems.get(indexed.output_index);
  if (downstreamIndex === undefined) {
    downstreamIndex = merge.outputIndex++;
    openItems.set(indexed.output_index, downstreamIndex);
  }
  const downstreamItemId = openItemIds.get(indexed.output_index);
  return {
    ...event,
    output_index: downstreamIndex,
    ...(typeof indexed.item_id === 'string' && downstreamItemId !== undefined ? { item_id: downstreamItemId } : {}),
  } as ResponsesStreamEvent;
};

const captureTerminalEvent = (
  event: ResponsesStreamEvent,
  merge: MergeState,
): { status: UpstreamTerminal; usage: MergeUsage } | null => {
  if (event.type === 'response.completed') {
    merge.upstreamResponseSnapshot = event.response;
    return { status: { kind: 'completed' }, usage: usageOf(event.response.usage) };
  }
  if (event.type === 'response.failed') {
    if (merge.lastSeenModel === null && typeof event.response.model === 'string' && event.response.model.length > 0) merge.lastSeenModel = event.response.model;
    merge.upstreamResponseSnapshot = event.response;
    return { status: { kind: 'failed', response: event.response }, usage: usageOf(event.response.usage) };
  }
  if (event.type === 'response.incomplete') {
    if (merge.lastSeenModel === null && typeof event.response.model === 'string' && event.response.model.length > 0) merge.lastSeenModel = event.response.model;
    merge.upstreamResponseSnapshot = event.response;
    return { status: { kind: 'incomplete', response: event.response }, usage: usageOf(event.response.usage) };
  }
  return null;
};

const stampServerToolEvent = (
  merge: MergeState,
  outputIndex: number,
  itemId: string,
  event: ServerToolLifecycleEvent,
): ProtocolFrame<ResponsesStreamEvent> =>
  eventFrame({
    ...event,
    output_index: outputIndex,
    item_id: itemId,
    sequence_number: merge.sequenceNumber++,
  } as ResponsesStreamEvent);

const attachServerToolItemId = (item: ServerToolOutputItem, id: string): ResponsesOutputItem => ({ ...item, id } as ResponsesOutputItem);

const serverToolStartFrames = (
  merge: MergeState,
  outputIndex: number,
  slot: ServerToolResultSlot,
): ProtocolFrame<ResponsesStreamEvent>[] => [
  eventFrame({
    type: 'response.output_item.added',
    output_index: outputIndex,
    item: attachServerToolItemId(slot.startItem, slot.id),
    sequence_number: merge.sequenceNumber++,
  } as ResponsesStreamEvent),
  ...slot.startEvents.map(event => stampServerToolEvent(merge, outputIndex, slot.id, event)),
];

const serverToolEndFrames = (
  merge: MergeState,
  outputIndex: number,
  slot: ServerToolResultSlot,
  result: ServerToolTerminal,
): ProtocolFrame<ResponsesStreamEvent>[] => {
  const frames = [
    ...result.endEvents.map(event => stampServerToolEvent(merge, outputIndex, slot.id, event)),
    eventFrame({
      type: 'response.output_item.done',
      output_index: outputIndex,
      item: attachServerToolItemId(result.item, slot.id),
      sequence_number: merge.sequenceNumber++,
    } as ResponsesStreamEvent),
  ];
  merge.accumulatedOutput.set(outputIndex, attachServerToolItemId(result.item, slot.id));
  return frames;
};

const transformServerToolItems = (
  items: ResponsesInputItem[],
  active: readonly ActiveServerTool[],
): ResponsesInputItem[] => {
  let next = items;
  for (const entry of active) {
    if (entry.transformItems !== undefined) next = entry.transformItems(next, entry.toolName);
  }
  return next;
};

export const consumeTurnStreaming = async function* (
  frames: AsyncIterable<ProtocolFrame<ResponsesStreamEvent>>,
  merge: MergeState,
  isFirstTurn: boolean,
  dispatchers: ReadonlyMap<string, ServerToolDispatcher>,
  loopState: ServerToolLoopState,
  active: readonly ActiveServerTool[],
): AsyncGenerator<ProtocolFrame<ResponsesStreamEvent>, TurnSummary> {
  const dispatched: Array<{ intercepted: InterceptedFunctionCall; slots: DispatchedServerToolSlot[] }> = [];
  let sawClientToolCall = false;
  let turnUsage: MergeUsage = {};
  let terminalStatus: UpstreamTerminal | undefined = undefined;

  const openItems = new Map<number, number>();
  const openItemIds = new Map<number, string>();
  // `argumentsJson` accumulates `function_call_arguments.delta` chunks
  // until the closing `.done` parses them into `intercepted.arguments`.
  // Kept on the entry (not on `InterceptedFunctionCall`) because it's
  // streaming state, not part of the dispatcher's input.
  const interceptedByUpstreamIndex = new Map<number, { intercepted: InterceptedFunctionCall; dispatcher: ServerToolDispatcher; reservedOutputIndex: number; argumentsJson: string }>();

  const ensureModel = (): string => {
    if (merge.lastSeenModel === null) {
      throw new Error('Server-tool shim cannot synthesize a Responses envelope because upstream `response.created` did not report a `model` field.');
    }
    return merge.lastSeenModel;
  };

  const stamp = (event: ResponsesStreamEvent): ProtocolFrame<ResponsesStreamEvent> =>
    eventFrame({
      ...event,
      sequence_number: merge.sequenceNumber++,
    } as ResponsesStreamEvent);

  for await (const frame of frames) {
    if (frame.type !== 'event') {
      yield frame;
      continue;
    }
    const event = frame.event;

    if (event.type === 'response.created') {
      const reportedModel = event.response.model;
      if (typeof reportedModel === 'string' && reportedModel.length > 0) merge.lastSeenModel = reportedModel;
      merge.upstreamResponseSnapshot = event.response;
      ensureModel();
      if (isFirstTurn) {
        yield stamp({
          type: 'response.created',
          response: syntheticInProgressResponse(merge, merge.synthesizedResponseId, ensureModel(), active),
        });
      }
      continue;
    }

    if (event.type === 'response.in_progress') {
      if (isFirstTurn) {
        yield stamp({
          type: 'response.in_progress',
          response: syntheticInProgressResponse(merge, merge.synthesizedResponseId, ensureModel(), active),
        });
      }
      continue;
    }

    if (event.type === 'error') {
      const e = event as Extract<ResponsesStreamEvent, { type: 'error' }>;
      const code = typeof e.code === 'string' && e.code.length > 0 ? e.code : 'server_error';
      if (merge.lastSeenModel === null) {
        terminalStatus = { kind: 'bare-error-pre-shell', error: { message: e.message, code } };
      } else {
        terminalStatus = {
          kind: 'failed',
          response: {
            id: merge.synthesizedResponseId,
            object: 'response',
            model: ensureModel(),
            output: [],
            status: 'failed',
            error: { message: e.message, code },
            incomplete_details: null,
          },
        };
      }
      turnUsage = {};
      continue;
    }

    const terminal = captureTerminalEvent(event, merge);
    if (terminal !== null) {
      terminalStatus = terminal.status;
      turnUsage = terminal.usage;
      continue;
    }

    if (event.type === 'response.output_item.added') {
      const upstreamIndex = event.output_index;
      const item = event.item;
      if (item.type === 'function_call') {
        const dispatcher = dispatchers.get(item.name);
        if (dispatcher !== undefined) {
          // Reserve the downstream index the shim call occupies now, at
          // `.added`; the actual slot count is only known at `.done`,
          // where slot 0 takes this reserved index and any further slots
          // take fresh ones. Those stay contiguous because Responses
          // output items stream sequentially — one item's `.added`…`.done`
          // completes before the next item's `.added`, so nothing
          // allocates a downstream index between this reservation and the
          // dispatch below.
          interceptedByUpstreamIndex.set(upstreamIndex, {
            dispatcher,
            reservedOutputIndex: merge.outputIndex++,
            argumentsJson: '',
            intercepted: {
              callId: item.call_id,
              name: item.name,
              arguments: {},
            },
          });
          continue;
        }
      }

      if (item.type === 'function_call' || item.type === 'custom_tool_call') sawClientToolCall = true;

      const downstreamIndex = merge.outputIndex++;
      openItems.set(upstreamIndex, downstreamIndex);
      const upstreamItemId = (item as { id?: unknown }).id;
      const itemId = typeof upstreamItemId === 'string' && upstreamItemId.length > 0
        ? upstreamItemId
        : item.type === 'message'
          ? `msg_${downstreamIndex}`
          : undefined;
      if (itemId !== undefined) openItemIds.set(upstreamIndex, itemId);
      yield stamp({
        type: 'response.output_item.added',
        output_index: downstreamIndex,
        item: itemId !== undefined && upstreamItemId !== itemId ? { ...item, id: itemId } as ResponsesOutputItem : item,
      });
      continue;
    }

    if (event.type === 'response.output_item.done') {
      const upstreamIndex = event.output_index;
      const intercepted = interceptedByUpstreamIndex.get(upstreamIndex);
      if (intercepted !== undefined) {
        if (event.item.type === 'function_call') intercepted.argumentsJson = event.item.arguments;
        intercepted.intercepted.arguments = parseServerToolArguments(intercepted.argumentsJson);
        const slots = intercepted.dispatcher({ intercepted: intercepted.intercepted, loopState });
        if (loopState.remainingToolCalls !== undefined) loopState.remainingToolCalls -= 1;
        const dispatchedSlots: DispatchedServerToolSlot[] = [];
        for (const [slotIndex, slot] of slots.entries()) {
          const outputIndex = slotIndex === 0 ? intercepted.reservedOutputIndex : merge.outputIndex++;
          dispatchedSlots.push({ intercepted: intercepted.intercepted, slot, outputIndex });
          yield* serverToolStartFrames(merge, outputIndex, slot);
        }
        dispatched.push({ intercepted: intercepted.intercepted, slots: dispatchedSlots });
        continue;
      }

      const downstreamIndex = openItems.get(upstreamIndex);
      if (downstreamIndex === undefined) continue;
      const itemId = openItemIds.get(upstreamIndex);
      const upstreamDoneItemId = (event.item as { id?: unknown }).id;
      const doneItem: ResponsesOutputItem = itemId !== undefined && upstreamDoneItemId !== itemId
        ? { ...event.item, id: itemId } as ResponsesOutputItem
        : event.item;
      yield stamp({ type: 'response.output_item.done', output_index: downstreamIndex, item: doneItem });
      merge.accumulatedOutput.set(downstreamIndex, doneItem);
      continue;
    }

    if (event.type === 'response.function_call_arguments.delta') {
      const intercepted = interceptedByUpstreamIndex.get(event.output_index);
      if (intercepted !== undefined) {
        intercepted.argumentsJson += event.delta;
        continue;
      }
      const rewritten = rewriteOutputIndex(event, openItems, openItemIds, merge);
      if (rewritten !== null) yield stamp(rewritten);
      continue;
    }

    if (event.type === 'response.function_call_arguments.done') {
      const intercepted = interceptedByUpstreamIndex.get(event.output_index);
      if (intercepted !== undefined) {
        intercepted.argumentsJson = event.arguments;
        continue;
      }
      const rewritten = rewriteOutputIndex(event, openItems, openItemIds, merge);
      if (rewritten !== null) yield stamp(rewritten);
      continue;
    }

    const maybeIndexedForIntercepted = event as ResponsesStreamEvent & { output_index?: unknown };
    if (typeof maybeIndexedForIntercepted.output_index === 'number' && interceptedByUpstreamIndex.has(maybeIndexedForIntercepted.output_index)) {
      continue;
    }

    const rewriteResult = rewriteOutputIndex(event, openItems, openItemIds, merge);
    if (rewriteResult !== null) {
      const maybeItemEvent = rewriteResult as ResponsesStreamEvent & { output_index?: number; item?: unknown };
      if (maybeItemEvent.item !== undefined && typeof maybeItemEvent.output_index === 'number' && (rewriteResult.type.endsWith('.added') || rewriteResult.type.endsWith('.done'))) {
        merge.accumulatedOutput.set(maybeItemEvent.output_index, maybeItemEvent.item as Parameters<MergeState['accumulatedOutput']['set']>[1]);
      }
      yield stamp(rewriteResult);
      continue;
    }
  }

  if (terminalStatus === undefined) {
    if (merge.lastSeenModel === null) {
      terminalStatus = {
        kind: 'bare-error-pre-shell',
        error: { message: 'Upstream stream ended without a terminal event (no response.created observed)', code: 'server_error' },
      };
    } else {
      terminalStatus = {
        kind: 'failed',
        response: {
          id: merge.synthesizedResponseId,
          object: 'response',
          model: ensureModel(),
          output: [],
          status: 'failed',
          error: { message: 'Upstream stream ended without a terminal event.', code: 'server_error' },
          incomplete_details: null,
        },
      };
    }
  }

  if (interceptedByUpstreamIndex.size > dispatched.length) {
    const dispatchedSet = new Set(dispatched.map(d => d.intercepted));
    const unmatched = [...interceptedByUpstreamIndex.entries()]
      .filter(([, intercepted]) => !dispatchedSet.has(intercepted.intercepted))
      .map(([idx]) => idx);
    const priorKind = terminalStatus.kind;
    const priorLabel = priorKind === 'bare-error-pre-shell' ? 'a pre-shell bare error' : `response.${priorKind}`;
    terminalStatus = {
      kind: 'failed',
      response: {
        id: merge.synthesizedResponseId,
        object: 'response',
        model: ensureModel(),
        output: [],
        status: 'failed',
        error: {
          message: `Upstream emitted ${priorLabel} without closing shim call items at upstream output_index ${unmatched.join(', ')}.`,
          code: 'server_error',
        },
        incomplete_details: null,
      },
    };
  }

  return { dispatched, sawClientToolCall, turnUsage, terminalStatus };
};

const MAX_BODY_EXCERPT_CHARS = 512;

const buildErrorFromResult = (
  result: Exclude<ExecuteResult<unknown>, { type: 'events' }>,
): NonNullable<ResponsesResult['error']> => {
  if (result.type === 'internal-error') return { message: result.error.message, code: 'server_error' };
  const decoded = new TextDecoder('utf-8', { fatal: false }).decode(result.body);
  let parsed: unknown = undefined;
  try {
    parsed = JSON.parse(decoded);
  } catch {
    parsed = undefined;
  }
  const err = typeof parsed === 'object' && parsed !== null ? (parsed as { error?: unknown }).error : undefined;
  if (typeof err === 'object' && err !== null) {
    const e = err as Record<string, unknown>;
    const out: NonNullable<ResponsesResult['error']> = {
      message: typeof e.message === 'string' ? e.message : `Upstream returned HTTP ${result.status}`,
      code: typeof e.code === 'string' ? e.code : `upstream_${result.status}`,
    };
    if (typeof e.type === 'string') (out as Record<string, unknown>).type = e.type;
    return out;
  }
  const truncated = truncatePreservingCodePoints(decoded, MAX_BODY_EXCERPT_CHARS);
  const excerpt = truncated.length === decoded.length ? decoded : `${truncated}...`;
  return {
    message: excerpt.length > 0 ? `Upstream returned HTTP ${result.status}: ${excerpt}` : `Upstream returned HTTP ${result.status}`,
    code: `upstream_${result.status}`,
  };
};

const invalidRequestEnvelope = (
  message: string,
  param: string | null,
  code: string | null | undefined,
  errorType = 'invalid_request_error',
): ExecuteResult<ProtocolFrame<ResponsesStreamEvent>> => {
  const body = JSON.stringify({
    error: {
      message,
      type: errorType,
      param,
      code: code === undefined ? 'invalid_request_error' : code,
    },
  });
  return {
    type: 'api-error',
    source: 'gateway',
    status: 400,
    headers: new Headers({ 'content-type': 'application/json' }),
    body: new TextEncoder().encode(body),
  };
};

// The terminal the shim emits downstream. Unlike `UpstreamTerminal`
// (what we observed), this carries only the already-extracted `error` /
// `incompleteDetails` the synthesized envelope needs; the output and
// usage come from accumulated shim state. There is no pre-shell variant
// here — synthesis always runs after a model is known.
type SynthesizedTerminal =
  | { kind: 'completed' }
  | { kind: 'failed'; error: ResponsesResult['error'] }
  | { kind: 'incomplete'; incompleteDetails: ResponsesResult['incomplete_details'] };

const SYNTHESIZED_TERMINAL_FRAME: Record<SynthesizedTerminal['kind'], { type: 'response.completed' | 'response.failed' | 'response.incomplete'; status: ResponsesResult['status'] }> = {
  completed: { type: 'response.completed', status: 'completed' },
  failed: { type: 'response.failed', status: 'failed' },
  incomplete: { type: 'response.incomplete', status: 'incomplete' },
};

const synthesizeTerminalEnvelope = (
  state: MergeState,
  kind: SynthesizedTerminal,
  active: readonly ActiveServerTool[],
): ProtocolFrame<ResponsesStreamEvent> => {
  if (state.lastSeenModel === null) {
    throw new Error('Server-tool shim cannot synthesize a Responses terminal envelope before upstream `response.created` reports a model.');
  }
  if (state.upstreamResponseSnapshot === undefined) {
    throw new Error('Server-tool shim cannot synthesize a Responses terminal envelope before upstream `response.created` is captured.');
  }
  const output = materializeAccumulatedOutput(state);
  const usage = usageForWire(state);
  const frame = SYNTHESIZED_TERMINAL_FRAME[kind.kind];
  let outputText = '';
  for (const item of output) {
    if (item.type !== 'message') continue;
    for (const block of item.content) {
      if (block.type === 'output_text') outputText += block.text;
    }
  }
  const snapshot = state.upstreamResponseSnapshot;
  const restoredTools = restoreEchoedTools(snapshot.tools, active);
  const restoredToolChoice = restoreEchoedToolChoice(snapshot.tool_choice, active);
  return eventFrame({
    type: frame.type,
    sequence_number: state.sequenceNumber++,
    response: {
      ...snapshot,
      id: state.synthesizedResponseId,
      object: 'response',
      model: state.lastSeenModel,
      status: frame.status,
      output,
      output_text: outputText,
      ...(restoredTools !== undefined ? { tools: restoredTools } : {}),
      ...(restoredToolChoice !== undefined ? { tool_choice: restoredToolChoice } : {}),
      ...(usage !== undefined ? { usage } : {}),
      ...(kind.kind === 'failed' ? { error: kind.error } : {}),
      ...(kind.kind === 'incomplete' ? { incomplete_details: kind.incompleteDetails } : {}),
    },
  } as ResponsesStreamEvent);
};

async function* materializeServerToolItems(
  dispatched: ReadonlyArray<{ slots: DispatchedServerToolSlot[] }>,
  merge: MergeState,
  statefulResponsesStore: StatefulResponsesStore,
): AsyncGenerator<ProtocolFrame<ResponsesStreamEvent>, void> {
  for (const d of dispatched) {
    for (const { slot, outputIndex } of d.slots) {
      const lifecycle = slot.run();
      let step = await lifecycle.next();
      while (!step.done) {
        yield stampServerToolEvent(merge, outputIndex, slot.id, step.value);
        step = await lifecycle.next();
      }
      // The slot item is gateway-synthesized, not upstream-emitted; register
      // its id so persistence stores it with no upstream identity even on a
      // native Responses stream. The private payload (when the dispatcher
      // produced one) registers under the same id so persistence captures it
      // and the next loop turn's replay-side `transformItems` finds it by the
      // accumulated output item's id.
      statefulResponsesStore.addSyntheticItem(slot.id, step.value.privatePayload);
      yield* serverToolEndFrames(merge, outputIndex, slot, step.value);
    }
  }
}

async function* runMultiTurnLoop(args: {
  ctx: ResponsesInvocation;
  run: InterceptorRun<ExecuteResult<ProtocolFrame<ResponsesStreamEvent>>>;
  merge: MergeState;
  loopState: ServerToolLoopState;
  demoteForcedServerToolChoiceAfterFirstTurn: boolean;
  turn1Iter: AsyncGenerator<ProtocolFrame<ResponsesStreamEvent>, TurnSummary>;
  dispatchers: ReadonlyMap<string, ServerToolDispatcher>;
  statefulResponsesStore: StatefulResponsesStore;
  canonicalInput: ResponsesInputItem[];
  active: readonly ActiveServerTool[];
  metadata: LatestUpstreamMetadata;
  resolveFinalMetadata: (m: EventResultMetadata) => void;
}): AsyncGenerator<ProtocolFrame<ResponsesStreamEvent>> {
  const { ctx, run, merge, loopState, demoteForcedServerToolChoiceAfterFirstTurn, turn1Iter, dispatchers, statefulResponsesStore, active, metadata, resolveFinalMetadata } = args;
  const baseInput = args.canonicalInput;
  let midStreamError: unknown = undefined;
  try {
    let currentTurn: TurnSummary = yield* turn1Iter;
    merge.accumulatedUsage = sumUsage(merge.accumulatedUsage, currentTurn.turnUsage);
    while (true) {
      const turn = currentTurn;
      const executedShim = turn.dispatched.length > 0;

      if (turn.terminalStatus.kind === 'failed') {
        if (executedShim) yield* materializeServerToolItems(turn.dispatched, merge, statefulResponsesStore);
        yield synthesizeTerminalEnvelope(merge, { kind: 'failed', error: turn.terminalStatus.response.error }, active);
        return;
      }
      if (turn.terminalStatus.kind === 'incomplete') {
        if (executedShim) yield* materializeServerToolItems(turn.dispatched, merge, statefulResponsesStore);
        yield synthesizeTerminalEnvelope(merge, { kind: 'incomplete', incompleteDetails: turn.terminalStatus.response.incomplete_details }, active);
        return;
      }
      if (turn.terminalStatus.kind === 'bare-error-pre-shell') {
        yield synthesizeTerminalEnvelope(merge, {
          kind: 'failed',
          error: { code: turn.terminalStatus.error.code, message: turn.terminalStatus.error.message },
        }, active);
        return;
      }
      if (!executedShim && !turn.sawClientToolCall) {
        yield synthesizeTerminalEnvelope(merge, { kind: 'completed' }, active);
        return;
      }

      yield* materializeServerToolItems(turn.dispatched, merge, statefulResponsesStore);
      if (turn.sawClientToolCall) {
        yield synthesizeTerminalEnvelope(merge, { kind: 'completed' }, active);
        return;
      }

      // Accumulated output items are fed back as the next turn's input.
      // A Responses output item is a structural superset of the matching
      // input item for every shape we emit here (messages, reasoning,
      // function_call / function_call_output, and the server-tool items
      // the dispatchers produce), so the reuse is sound; the cast only
      // bridges the output/input naming.
      const nextCanonicalInput = [
        ...baseInput,
        ...materializeAccumulatedOutput(merge).map(item => item as ResponsesInputItem),
      ];
      const nextPayload: CanonicalResponsesPayload = { ...ctx.payload, input: transformServerToolItems(nextCanonicalInput, active) };
      if (loopState.remainingToolCalls !== undefined) {
        nextPayload.max_tool_calls = Math.max(0, loopState.remainingToolCalls);
      } else {
        delete nextPayload.max_tool_calls;
      }
      ctx.payload = nextPayload;

      if (demoteForcedServerToolChoiceAfterFirstTurn) ctx.payload = { ...ctx.payload, tool_choice: 'auto' };
      loopState.iterationCount += 1;

      const nextResult = await run();
      if (nextResult.type !== 'events') {
        yield synthesizeTerminalEnvelope(merge, { kind: 'failed', error: buildErrorFromResult(nextResult) }, active);
        return;
      }
      metadata.modelIdentity = nextResult.modelIdentity;
      metadata.performance = nextResult.performance;
      currentTurn = yield* consumeTurnStreaming(nextResult.events, merge, false, dispatchers, loopState, active);
      merge.accumulatedUsage = sumUsage(merge.accumulatedUsage, currentTurn.turnUsage);
    }
  } catch (error) {
    if (merge.lastSeenModel === null) {
      midStreamError = error;
      throw error;
    }
    yield synthesizeTerminalEnvelope(merge, {
      kind: 'failed',
      error: {
        code: 'server_error',
        message: `Upstream stream failed mid-response: ${error instanceof Error ? error.message : String(error)}`,
      },
    }, active);
  } finally {
    if (midStreamError === undefined) resolveFinalMetadata(metadata);
  }
}

export const withResponsesServerToolShim = (
  registrations: readonly ServerToolRegistration[],
): ResponsesInterceptor => async (ctx, gatewayCtx, run) => {
  const active: ActiveServerTool[] = [];

  for (const prepareServerTool of registrations) {
    const prepared = await prepareServerTool(ctx, gatewayCtx);
    if (prepared.type === 'inactive') continue;
    if (prepared.type === 'invalid-request') {
      return invalidRequestEnvelope(prepared.message, prepared.param, prepared.code, prepared.errorType);
    }
    const currentTools = Array.isArray(ctx.payload.tools) ? ctx.payload.tools : [];
    const toolName = resolveServerToolName(prepared.baseToolName, currentTools);
    const { hosted } = prepared;
    let canonicalHostedTool: ResponsesHostedTool | undefined = undefined;
    if (hosted !== undefined) {
      const rewrite = rewriteToolsForHostedShim(currentTools, hosted, toolName);
      canonicalHostedTool = rewrite.canonicalHostedTool;
      ctx.payload = { ...ctx.payload, tools: rewrite.rewritten };
    }
    const originalToolChoice = hosted !== undefined
      && typeof ctx.payload.tool_choice === 'object'
      && ctx.payload.tool_choice !== null
      && hosted.hostedTypes.includes(ctx.payload.tool_choice.type)
      ? ctx.payload.tool_choice
      : undefined;
    active.push({ ...prepared, toolName, canonicalHostedTool, originalToolChoice });
  }

  if (active.length === 0) return await run();

  const rewrittenToolChoice = rewriteHostedToolChoice(ctx.payload.tool_choice, active);
  if (rewrittenToolChoice !== ctx.payload.tool_choice) {
    ctx.payload = { ...ctx.payload, tool_choice: rewrittenToolChoice };
  }

  const canonicalInput = ctx.payload.input;
  const nextInput = transformServerToolItems(canonicalInput, active);
  if (nextInput !== canonicalInput) ctx.payload = { ...ctx.payload, input: nextInput };

  const hostedActive = active.filter(
    (entry): entry is ActiveServerTool & { hosted: ServerToolHostedDispatch } =>
      entry.hosted !== undefined,
  );
  if (hostedActive.length === 0) return await run();

  const dispatchers = new Map<string, ServerToolDispatcher>();
  for (const entry of hostedActive) dispatchers.set(entry.toolName, entry.hosted.dispatcher);
  const loopState: ServerToolLoopState = {
    iterationCount: 1,
    remainingToolCalls: typeof ctx.payload.max_tool_calls === 'number' ? ctx.payload.max_tool_calls : undefined,
  };
  const finalToolChoice = ctx.payload.tool_choice;
  const demoteForcedServerToolChoiceAfterFirstTurn = finalToolChoice === 'required'
    || (typeof finalToolChoice === 'object'
      && finalToolChoice !== null
      && finalToolChoice.type === 'function'
      && dispatchers.has(finalToolChoice.name));

  const merge = createMergeState();
  const firstResult = await run();
  if (firstResult.type !== 'events') return firstResult;
  const turn1Iter = consumeTurnStreaming(firstResult.events, merge, true, dispatchers, loopState, active);

  let resolveFinalMetadata!: (m: EventResultMetadata) => void;
  const shimFinalMetadata = new Promise<EventResultMetadata>(resolve => {
    resolveFinalMetadata = resolve;
  });
  const metadata: LatestUpstreamMetadata = {
    modelIdentity: firstResult.modelIdentity,
    performance: firstResult.performance,
  };

  return {
    ...firstResult,
    events: runMultiTurnLoop({
      ctx,
      run,
      merge,
      loopState,
      demoteForcedServerToolChoiceAfterFirstTurn,
      turn1Iter,
      dispatchers,
      statefulResponsesStore: gatewayCtx.store,
      canonicalInput,
      active,
      metadata,
      resolveFinalMetadata,
    }),
    finalMetadata: shimFinalMetadata,
  };
};
