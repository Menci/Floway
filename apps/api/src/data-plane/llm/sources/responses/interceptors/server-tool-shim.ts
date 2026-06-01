import { jsonrepair } from 'jsonrepair';

import type { InterceptorRun, RequestContext, ResponsesInterceptor, ResponsesInvocation, StatefulResponsesContext } from '../../../interceptors.ts';
import type { EventResult, EventResultMetadata, ExecuteResult } from '../../../shared/errors/result.ts';
import { truncatePreservingCodePoints } from '../../../shared/text.ts';
import { eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import type {
  ResponsesInputItem,
  ResponsesOutputItem,
  ResponsesPayload,
  ResponsesResult,
  RawResponsesStreamEvent,
  ResponsesStreamEvent,
  ResponsesTool,
  ResponsesToolChoice,
} from '@floway-dev/protocols/responses';

export interface MergeUsage {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  input_tokens_details: { cached_tokens: number };
  output_tokens_details: { reasoning_tokens: number };
}

export interface MergeState {
  sequenceNumber: number;
  outputIndex: number;
  accumulatedOutput: Map<number, ResponsesOutputItem>;
  accumulatedUsage: Partial<MergeUsage>;
  lastSeenModel: string | null;
  synthesizedResponseId: string;
  upstreamResponseSnapshot: ResponsesResult | undefined;
}

export interface InterceptedFunctionCall {
  callId: string;
  name: string;
  argumentsJson: string;
  arguments: Record<string, unknown> | null;
}

export interface ServerToolResultSlot {
  id: string;
  startItem: ServerToolOutputItem;
  startEvents: ServerToolLifecycleEvent[];
  result: Promise<{
    item: ServerToolOutputItem;
    endEvents: ServerToolLifecycleEvent[];
    /**
     * Optional server-only blob registered on `request.statefulResponsesContext.privatePayload`
     * under `slot.id` before the slot's wire item leaves materialize. The
     * persistence layer stores it in `payload.private`; the replay-side
     * `transformItems` reads it back to reconstruct full state across turns.
     */
    privatePayload?: unknown;
  }>;
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

// The three members of a hosted interception move together: to run the
// ReAct loop we must recognize the hosted tool (`isHostedTool`), replace
// it with a callable function tool the upstream model can invoke
// (`buildFunctionTool`), and execute the model's calls (`dispatcher`).
// Grouping them makes a partial declaration a compile error instead of a
// registration that silently never dispatches.
export interface ServerToolHostedDispatch {
  isHostedTool: (tool: ResponsesTool) => boolean;
  buildFunctionTool: (toolName: string) => ResponsesTool;
  dispatcher: ServerToolDispatcher;
}

export type ServerToolPrepareResult =
  | { type: 'inactive' }
  | { type: 'invalid-request'; message: string; param: string }
  | {
    type: 'active';
    baseToolName: string;
    // History rewrite, applied whether or not the tool is hosted this
    // turn so replayed items (e.g. an echoed `web_search_call`) become
    // upstream-readable even on a request that no longer declares the
    // hosted tool.
    transformItems?: (items: ResponsesInputItem[], toolName: string) => ResponsesInputItem[];
    // Present only when the request actually declares this tool's hosted
    // form; absent for replay-only activation.
    hosted?: ServerToolHostedDispatch;
  };

export type ServerToolRegistration = (ctx: ResponsesInvocation, request: RequestContext) => ServerToolPrepareResult | Promise<ServerToolPrepareResult>;

type ActiveServerTool = Extract<ServerToolPrepareResult, { type: 'active' }> & {
  toolName: string;
  hasHostedTool: boolean;
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
  turnUsage: Partial<MergeUsage>;
  terminalStatus: UpstreamTerminal;
}

interface LatestMetadata {
  modelIdentity: EventResultMetadata['modelIdentity'];
  performance: EventResultMetadata['performance'];
}

const synthesizeShimResponseId = (): string =>
  `resp_shim_${crypto.randomUUID().replace(/-/g, '')}`;

export const createMergeState = (): MergeState => ({
  sequenceNumber: 0,
  outputIndex: 0,
  accumulatedOutput: new Map(),
  accumulatedUsage: {},
  lastSeenModel: null,
  synthesizedResponseId: synthesizeShimResponseId(),
  upstreamResponseSnapshot: undefined,
});

export const materializeAccumulatedOutput = (state: MergeState): ResponsesOutputItem[] => {
  const sorted = [...state.accumulatedOutput.keys()].sort((a, b) => a - b);
  return sorted.map(k => state.accumulatedOutput.get(k)!);
};

export const rebuildOutputText = (items: readonly ResponsesOutputItem[]): string => {
  let out = '';
  for (const item of items) {
    if (item.type !== 'message') continue;
    for (const block of item.content) {
      if (block.type === 'output_text') out += block.text;
    }
  }
  return out;
};

export const sumUsage = (a: Partial<MergeUsage>, b: Partial<MergeUsage>): Partial<MergeUsage> => {
  const out: Partial<MergeUsage> = {};
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

export const usageForWire = (state: MergeState): ResponsesResult['usage'] => {
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

export const usageOf = (usage: ResponsesResult['usage']): Partial<MergeUsage> => {
  if (usage === undefined) return {};
  const out: Partial<MergeUsage> = {};
  if (usage.input_tokens !== undefined) out.input_tokens = usage.input_tokens;
  if (usage.output_tokens !== undefined) out.output_tokens = usage.output_tokens;
  if (usage.total_tokens !== undefined) out.total_tokens = usage.total_tokens;
  if (usage.input_tokens_details !== undefined) out.input_tokens_details = usage.input_tokens_details;
  if (usage.output_tokens_details !== undefined) out.output_tokens_details = usage.output_tokens_details;
  return out;
};

const serverToolChoiceType = (toolChoice: ResponsesToolChoice | undefined): string | undefined =>
  typeof toolChoice === 'object' && toolChoice !== null && typeof toolChoice.type === 'string'
    ? toolChoice.type
    : undefined;

const rewriteHostedToolChoice = (
  toolChoice: ResponsesToolChoice | undefined,
  active: readonly ActiveServerTool[],
): ResponsesToolChoice | undefined => {
  const choiceType = serverToolChoiceType(toolChoice);
  if (choiceType === undefined) return toolChoice;
  for (const entry of active) {
    if (!entry.hasHostedTool) continue;
    // A hosted `tool_choice` is `{ type }` on the wire, the same
    // discriminant a hosted tool carries, so a type-only probe is a
    // faithful (if sparse) tool object: hosted Responses tools are
    // identified by `type`. `isHostedTool` must therefore classify on
    // `type` alone.
    if (entry.hosted?.isHostedTool({ type: choiceType } as ResponsesTool)) return { type: 'function', name: entry.toolName };
  }
  return toolChoice;
};

// Bound on the suffix search; defends against a pathological tools list
// that somehow occupies every `<baseName>_<n>` candidate.
const MAX_NAME_RESOLUTION_ATTEMPTS = 1000;

export const resolveServerToolName = (baseName: string, tools: readonly ResponsesTool[]): string => {
  const taken = new Set(tools.flatMap(tool => (tool.type === 'function' || tool.type === 'custom') ? [tool.name] : []));
  if (!taken.has(baseName)) return baseName;
  // `baseName` was attempt 1; suffixes `_2`…`_MAX` make up the rest, so
  // the bound is inclusive and the total names tried equals MAX.
  for (let i = 2; i <= MAX_NAME_RESOLUTION_ATTEMPTS; i++) {
    const candidate = `${baseName}_${i}`;
    if (!taken.has(candidate)) return candidate;
  }
  throw new Error(`Unable to resolve a free server tool function name for ${baseName} within ${MAX_NAME_RESOLUTION_ATTEMPTS} attempts`);
};

const replaceHostedToolsWithFunctionTool = (
  tools: readonly ResponsesTool[],
  isHostedTool: (tool: ResponsesTool) => boolean,
  functionTool: ResponsesTool,
): ResponsesTool[] => {
  const rewritten: ResponsesTool[] = [];
  let injected = false;
  for (const tool of tools) {
    if (isHostedTool(tool)) {
      if (!injected) {
        rewritten.push(functionTool);
        injected = true;
      }
      continue;
    }
    rewritten.push(tool);
  }
  return rewritten;
};

export const parseServerToolArguments = (argumentsJson: string): Record<string, unknown> | null => {
  if (argumentsJson === '') return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonrepair(argumentsJson));
  } catch {
    return null;
  }
  return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : null;
};

const syntheticInProgressResponse = (state: MergeState, id: string, model: string): ResponsesResult => {
  if (state.upstreamResponseSnapshot === undefined) {
    throw new Error('Server-tool shim cannot synthesize a Responses in-progress envelope before upstream `response.created` is captured.');
  }
  return {
    ...state.upstreamResponseSnapshot,
    id,
    object: 'response',
    model,
    output: [],
    status: 'in_progress',
    error: null,
    incomplete_details: null,
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
): { status: UpstreamTerminal; usage: Partial<MergeUsage> } | null => {
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
): ProtocolFrame<RawResponsesStreamEvent> =>
  eventFrame({
    ...event,
    output_index: outputIndex,
    item_id: itemId,
    sequence_number: merge.sequenceNumber++,
  } as RawResponsesStreamEvent);

export const serverToolResultSlot = (args: {
  id: string;
  startItem: ServerToolOutputItem;
  startEvents: readonly ServerToolLifecycleEvent[];
  result: Promise<{
    item: ServerToolOutputItem;
    endEvents: readonly ServerToolLifecycleEvent[];
  }>;
}): ServerToolResultSlot => ({
  id: args.id,
  startItem: args.startItem,
  startEvents: [...args.startEvents],
  result: args.result.then(result => ({
    item: result.item,
    endEvents: [...result.endEvents],
  })),
});

const serverToolStartFrames = (
  merge: MergeState,
  outputIndex: number,
  slot: ServerToolResultSlot,
): ProtocolFrame<RawResponsesStreamEvent>[] => [
  eventFrame({
    type: 'response.output_item.added',
    output_index: outputIndex,
    item: attachServerToolItemId(slot.startItem, slot.id),
    sequence_number: merge.sequenceNumber++,
  } as RawResponsesStreamEvent),
  ...slot.startEvents.map(event => stampServerToolEvent(merge, outputIndex, slot.id, event)),
];

const serverToolEndFrames = (
  merge: MergeState,
  outputIndex: number,
  slot: ServerToolResultSlot,
  result: Awaited<ServerToolResultSlot['result']>,
): ProtocolFrame<RawResponsesStreamEvent>[] => {
  const frames = [
    ...result.endEvents.map(event => stampServerToolEvent(merge, outputIndex, slot.id, event)),
    eventFrame({
      type: 'response.output_item.done',
      output_index: outputIndex,
      item: attachServerToolItemId(result.item, slot.id),
      sequence_number: merge.sequenceNumber++,
    } as RawResponsesStreamEvent),
  ];
  merge.accumulatedOutput.set(outputIndex, attachServerToolItemId(result.item, slot.id));
  return frames;
};

const attachServerToolItemId = (item: ServerToolOutputItem, id: string): ResponsesOutputItem => ({ ...item, id } as ResponsesOutputItem);

const responsesInputItemsOf = (input: ResponsesPayload['input']): ResponsesInputItem[] =>
  Array.isArray(input) ? input : [{ type: 'message', role: 'user', content: input }];

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
  frames: AsyncIterable<ProtocolFrame<RawResponsesStreamEvent>>,
  merge: MergeState,
  isFirstTurn: boolean,
  dispatchers: ReadonlyMap<string, ServerToolDispatcher>,
  loopState: ServerToolLoopState,
): AsyncGenerator<ProtocolFrame<RawResponsesStreamEvent>, TurnSummary> {
  const dispatched: Array<{ intercepted: InterceptedFunctionCall; slots: DispatchedServerToolSlot[] }> = [];
  let sawClientToolCall = false;
  let turnUsage: Partial<MergeUsage> = {};
  let terminalStatus: UpstreamTerminal | undefined = undefined;

  const openItems = new Map<number, number>();
  const openItemIds = new Map<number, string>();
  const interceptedByUpstreamIndex = new Map<number, { intercepted: InterceptedFunctionCall; dispatcher: ServerToolDispatcher; reservedOutputIndex: number }>();

  const ensureModel = (): string => {
    if (merge.lastSeenModel === null) {
      throw new Error('Server-tool shim cannot synthesize a Responses envelope because upstream `response.created` did not report a `model` field.');
    }
    return merge.lastSeenModel;
  };

  const stamp = (event: ResponsesStreamEvent): ProtocolFrame<RawResponsesStreamEvent> =>
    eventFrame({
      ...event,
      sequence_number: merge.sequenceNumber++,
    } as RawResponsesStreamEvent);

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
          response: syntheticInProgressResponse(merge, merge.synthesizedResponseId, ensureModel()),
        });
      }
      continue;
    }

    if (event.type === 'response.in_progress') {
      if (isFirstTurn) {
        yield stamp({
          type: 'response.in_progress',
          response: syntheticInProgressResponse(merge, merge.synthesizedResponseId, ensureModel()),
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
          // Reserve the downstream index the umbrella occupies now, at
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
            intercepted: {
              callId: item.call_id,
              name: item.name,
              argumentsJson: '',
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
        if (event.item.type === 'function_call') intercepted.intercepted.argumentsJson = event.item.arguments;
        intercepted.intercepted.arguments = parseServerToolArguments(intercepted.intercepted.argumentsJson);
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
        intercepted.intercepted.argumentsJson += event.delta;
        continue;
      }
      const rewritten = rewriteOutputIndex(event, openItems, openItemIds, merge);
      if (rewritten !== null) yield stamp(rewritten);
      continue;
    }

    if (event.type === 'response.function_call_arguments.done') {
      const intercepted = interceptedByUpstreamIndex.get(event.output_index);
      if (intercepted !== undefined) {
        intercepted.intercepted.argumentsJson = event.arguments;
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
    terminalStatus = {
      kind: 'failed',
      response: {
        id: merge.synthesizedResponseId,
        object: 'response',
        model: ensureModel(),
        output: [],
        status: 'failed',
        error: {
          message: `Upstream emitted ${UPSTREAM_TERMINAL_LABEL[terminalStatus.kind]} without closing umbrella function_call items at upstream output_index ${unmatched.join(', ')}.`,
          code: 'server_error',
        },
        incomplete_details: null,
      },
    };
  }

  return { dispatched, sawClientToolCall, turnUsage, terminalStatus };
};

const UPSTREAM_TERMINAL_LABEL: Record<UpstreamTerminal['kind'], string> = {
  completed: 'response.completed',
  failed: 'response.failed',
  incomplete: 'response.incomplete',
  'bare-error-pre-shell': 'a pre-shell bare error',
};

const MAX_BODY_EXCERPT_CHARS = 512;

export const buildErrorFromResult = (
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

export const invalidRequestEnvelope = (
  message: string,
  param: string,
): ExecuteResult<ProtocolFrame<RawResponsesStreamEvent>> => {
  const body = JSON.stringify({
    error: {
      message,
      type: 'invalid_request_error',
      param,
      code: 'invalid_request_error',
    },
  });
  return {
    type: 'upstream-error',
    status: 400,
    headers: new Headers({ 'content-type': 'application/json' }),
    body: new TextEncoder().encode(body),
  };
};

export const overlayOnSnapshot = (
  state: MergeState,
  overlay: Partial<ResponsesResult> & Pick<ResponsesResult, 'id' | 'object' | 'model' | 'status' | 'output'>,
): ResponsesResult => {
  if (state.upstreamResponseSnapshot === undefined) {
    throw new Error('Server-tool shim cannot overlay on an undefined upstream snapshot.');
  }
  return { ...state.upstreamResponseSnapshot, ...overlay };
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

export const synthesizeTerminalEnvelope = (
  state: MergeState,
  kind: SynthesizedTerminal,
): ProtocolFrame<RawResponsesStreamEvent> => {
  if (state.lastSeenModel === null) {
    throw new Error('Server-tool shim cannot synthesize a Responses terminal envelope before upstream `response.created` reports a model.');
  }
  const output = materializeAccumulatedOutput(state);
  const usage = usageForWire(state);
  const frame = SYNTHESIZED_TERMINAL_FRAME[kind.kind];
  return eventFrame({
    type: frame.type,
    sequence_number: state.sequenceNumber++,
    response: overlayOnSnapshot(state, {
      id: state.synthesizedResponseId,
      object: 'response',
      model: state.lastSeenModel,
      status: frame.status,
      output,
      output_text: rebuildOutputText(output),
      ...(usage !== undefined ? { usage } : {}),
      ...(kind.kind === 'failed' ? { error: kind.error } : {}),
      ...(kind.kind === 'incomplete' ? { incomplete_details: kind.incompleteDetails } : {}),
    }),
  } as RawResponsesStreamEvent);
};

async function* materializeServerToolItems(
  dispatched: ReadonlyArray<{ slots: DispatchedServerToolSlot[] }>,
  merge: MergeState,
  statefulResponsesContext: StatefulResponsesContext,
): AsyncGenerator<ProtocolFrame<RawResponsesStreamEvent>, void> {
  for (const d of dispatched) {
    for (const { slot, outputIndex } of d.slots) {
      const result = await slot.result;
      // The slot item is gateway-synthesized, not upstream-emitted; register
      // its id so persistence stores it with no upstream identity even on a
      // native Responses stream. The private payload (when the dispatcher
      // produced one) registers under the same id so persistence captures it
      // and the next loop turn's replay-side `transformItems` finds it by the
      // accumulated output item's id.
      statefulResponsesContext.newSyntheticIds.add(slot.id);
      if (result.privatePayload !== undefined) statefulResponsesContext.privatePayload.set(slot.id, result.privatePayload);
      yield* serverToolEndFrames(merge, outputIndex, slot, result);
    }
  }
}

async function* runMultiTurnLoop(args: {
  ctx: ResponsesInvocation;
  run: InterceptorRun<ExecuteResult<ProtocolFrame<RawResponsesStreamEvent>>>;
  merge: MergeState;
  loopState: ServerToolLoopState;
  demoteForcedServerToolChoiceAfterFirstTurn: boolean;
  turn1Iter: AsyncGenerator<ProtocolFrame<RawResponsesStreamEvent>, TurnSummary>;
  dispatchers: ReadonlyMap<string, ServerToolDispatcher>;
  statefulResponsesContext: StatefulResponsesContext;
  canonicalInput: ResponsesInputItem[];
  active: readonly ActiveServerTool[];
  metadata: LatestMetadata;
  resolveFinalMetadata: (m: EventResultMetadata) => void;
}): AsyncGenerator<ProtocolFrame<RawResponsesStreamEvent>> {
  const { ctx, run, merge, loopState, demoteForcedServerToolChoiceAfterFirstTurn, turn1Iter, dispatchers, statefulResponsesContext, active, metadata, resolveFinalMetadata } = args;
  const baseInput = args.canonicalInput;
  let midStreamError: unknown = undefined;
  try {
    let currentTurn: TurnSummary = yield* turn1Iter;
    merge.accumulatedUsage = sumUsage(merge.accumulatedUsage, currentTurn.turnUsage);
    while (true) {
      const turn = currentTurn;
      const executedShim = turn.dispatched.length > 0;

      if (turn.terminalStatus.kind === 'failed') {
        if (executedShim) yield* materializeServerToolItems(turn.dispatched, merge, statefulResponsesContext);
        yield synthesizeTerminalEnvelope(merge, { kind: 'failed', error: turn.terminalStatus.response.error });
        return;
      }
      if (turn.terminalStatus.kind === 'incomplete') {
        if (executedShim) yield* materializeServerToolItems(turn.dispatched, merge, statefulResponsesContext);
        yield synthesizeTerminalEnvelope(merge, { kind: 'incomplete', incompleteDetails: turn.terminalStatus.response.incomplete_details });
        return;
      }
      if (turn.terminalStatus.kind === 'bare-error-pre-shell') {
        yield synthesizeTerminalEnvelope(merge, {
          kind: 'failed',
          error: { code: turn.terminalStatus.error.code, message: turn.terminalStatus.error.message },
        });
        return;
      }
      if (!executedShim && !turn.sawClientToolCall) {
        yield synthesizeTerminalEnvelope(merge, { kind: 'completed' });
        return;
      }

      yield* materializeServerToolItems(turn.dispatched, merge, statefulResponsesContext);
      if (turn.sawClientToolCall) {
        yield synthesizeTerminalEnvelope(merge, { kind: 'completed' });
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
      const nextPayload: ResponsesPayload = { ...ctx.payload, input: transformServerToolItems(nextCanonicalInput, active) };
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
        yield synthesizeTerminalEnvelope(merge, { kind: 'failed', error: buildErrorFromResult(nextResult) });
        return;
      }
      metadata.modelIdentity = nextResult.modelIdentity;
      metadata.performance = nextResult.performance;
      currentTurn = yield* consumeTurnStreaming(nextResult.events, merge, false, dispatchers, loopState);
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
    });
  } finally {
    if (midStreamError === undefined) resolveFinalMetadata(metadata);
  }
}

export const withResponsesServerToolShim = (
  registrations: readonly ServerToolRegistration[],
): ResponsesInterceptor => async (ctx, request, run) => {
  const active: ActiveServerTool[] = [];

  for (const prepareServerTool of registrations) {
    const prepared = await prepareServerTool(ctx, request);
    if (prepared.type === 'inactive') continue;
    if (prepared.type === 'invalid-request') return invalidRequestEnvelope(prepared.message, prepared.param);
    const currentTools = Array.isArray(ctx.payload.tools) ? ctx.payload.tools : [];
    const toolName = resolveServerToolName(prepared.baseToolName, currentTools);
    const hasHostedTool = prepared.hosted !== undefined && currentTools.some(prepared.hosted.isHostedTool);
    if (hasHostedTool && prepared.hosted !== undefined) {
      ctx.payload = {
        ...ctx.payload,
        tools: replaceHostedToolsWithFunctionTool(currentTools, prepared.hosted.isHostedTool, prepared.hosted.buildFunctionTool(toolName)),
      };
    }
    active.push({ ...prepared, toolName, hasHostedTool });
  }

  if (active.length === 0) return await run();

  const rewrittenToolChoice = rewriteHostedToolChoice(ctx.payload.tool_choice, active);
  if (rewrittenToolChoice !== ctx.payload.tool_choice) {
    ctx.payload = rewrittenToolChoice === undefined
      ? { ...ctx.payload, tool_choice: undefined }
      : { ...ctx.payload, tool_choice: rewrittenToolChoice };
  }

  const canonicalInput = responsesInputItemsOf(ctx.payload.input);
  const inputArray = Array.isArray(ctx.payload.input) ? ctx.payload.input : undefined;
  if (inputArray !== undefined) {
    const nextInput = transformServerToolItems(inputArray, active);
    if (nextInput !== inputArray) ctx.payload = { ...ctx.payload, input: nextInput };
  }

  const hostedActive = active.filter(entry => entry.hasHostedTool && entry.hosted !== undefined);
  if (hostedActive.length === 0) return await run();

  const dispatchers = new Map<string, ServerToolDispatcher>();
  for (const entry of hostedActive) dispatchers.set(entry.toolName, entry.hosted!.dispatcher);
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
  const firstResultRaw = await run();
  if (firstResultRaw.type !== 'events') return firstResultRaw;
  const firstResult: EventResult<ProtocolFrame<RawResponsesStreamEvent>> = firstResultRaw;
  const turn1Iter = consumeTurnStreaming(firstResult.events, merge, true, dispatchers, loopState);

  let resolveFinalMetadata!: (m: EventResultMetadata) => void;
  const shimFinalMetadata = new Promise<EventResultMetadata>(resolve => {
    resolveFinalMetadata = resolve;
  });
  const metadata: LatestMetadata = {
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
      statefulResponsesContext: request.statefulResponsesContext,
      canonicalInput,
      active,
      metadata,
      resolveFinalMetadata,
    }),
    finalMetadata: shimFinalMetadata,
  };
};
