import { jsonrepair } from 'jsonrepair';

import type { MergeState, MergeUsage, ActiveHostedTool, HostedToolRewrite, HostedToolDispatcher, UpstreamTerminal, HostedToolLifecycleEvent, HostedToolOutputItem, HostedToolResultSlot, HostedToolTerminal, HostedToolLoopState, TurnSummary, InterceptedFunctionCall, DispatchedHostedToolSlot, SynthesizedTerminal } from './types.ts';
import { truncatePreservingCodePoints } from '../../../shared/text.ts';
import type { OpenAIResponsesStatefulStore } from '../items/store.ts';
import { eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import { createRandomOpenAIResponsesItemId, type OpenAIResponsesOutputItem, type OpenAIResponsesResult, type OpenAIResponsesToolChoice, type OpenAIResponsesTool, type OpenAIResponsesInputItem, type OpenAIResponsesHostedTool, type CanonicalOpenAIResponsesPayload, type OpenAIResponsesStreamEvent, type OpenAIResponsesOutputFunctionCall } from '@floway-dev/protocols/openai-responses';

export const createMergeState = (): MergeState => ({
  sequenceNumber: 0,
  outputIndex: 0,
  accumulatedOutput: new Map(),
  accumulatedUsage: {},
  lastSeenModel: null,
  synthesizedResponseId: `resp_hosted_${crypto.randomUUID().replace(/-/g, '')}`,
  upstreamResponseSnapshot: undefined,
});

export const materializeAccumulatedOutput = (state: MergeState): OpenAIResponsesOutputItem[] => {
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

const usageForWire = (state: MergeState): NonNullable<OpenAIResponsesResult['usage']> | undefined => {
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

const usageOf = (usage: OpenAIResponsesResult['usage']): MergeUsage => {
  if (usage == null) return {};
  const out: MergeUsage = {};
  if (usage.input_tokens !== undefined) out.input_tokens = usage.input_tokens;
  if (usage.output_tokens !== undefined) out.output_tokens = usage.output_tokens;
  if (usage.total_tokens !== undefined) out.total_tokens = usage.total_tokens;
  if (usage.input_tokens_details !== undefined) out.input_tokens_details = usage.input_tokens_details;
  if (usage.output_tokens_details !== undefined) out.output_tokens_details = usage.output_tokens_details;
  return out;
};

export const rewriteHostedToolChoice = (
  toolChoice: OpenAIResponsesToolChoice | null | undefined,
  active: readonly ActiveHostedTool[],
): OpenAIResponsesToolChoice | null | undefined => {
  if (toolChoice == null || typeof toolChoice === 'string') return toolChoice;
  if (toolChoice.type === 'allowed_tools' && Array.isArray(toolChoice.tools)) {
    const tools = toolChoice.tools.map(selector => {
      if (typeof selector !== 'object' || selector === null || typeof selector.type !== 'string' || selector.namespace !== undefined) return selector;
      const type = selector.type;
      const entry = active.find(entry => entry.hosted?.hostedTypes.includes(type));
      return entry === undefined ? selector : { ...selector, type: 'function', name: entry.toolName };
    });
    return tools.some((tool, index) => tool !== toolChoice.tools[index]) ? { ...toolChoice, tools } : toolChoice;
  }
  for (const entry of active) {
    if (entry.hosted === undefined) continue;
    if (entry.hosted.hostedTypes.includes(toolChoice.type)) return { type: 'function', name: entry.toolName };
  }
  return toolChoice;
};

export const hostedToolChoiceToRestore = (
  choice: OpenAIResponsesToolChoice | null | undefined,
  hosted: HostedToolRewrite | undefined,
  toolName: string,
): Exclude<OpenAIResponsesToolChoice, string> | undefined => {
  if (hosted === undefined || typeof choice !== 'object' || choice === null) return undefined;
  if (hosted.hostedTypes.includes(choice.type)) return choice;
  if (choice.type !== 'allowed_tools' || !Array.isArray(choice.tools)) return undefined;

  const selectsHostedTool = choice.tools.some(selector => {
    if (typeof selector?.type !== 'string' || selector.namespace !== undefined) return false;
    if (hosted.hostedTypes.includes(selector.type)) return true;
    return choice.mode === 'required' && selector.type === 'function' && selector.name === toolName;
  });
  return selectsHostedTool ? choice : undefined;
};

export const isForcedHostedToolChoice = (
  choice: OpenAIResponsesToolChoice | null | undefined,
  dispatchers: ReadonlyMap<string, HostedToolDispatcher>,
): boolean => {
  if (choice === 'required') return true;
  if (typeof choice !== 'object' || choice === null) return false;
  if (choice.type === 'function') return choice.namespace === undefined && dispatchers.has(choice.name);
  if (choice.type !== 'allowed_tools' || choice.mode !== 'required' || !Array.isArray(choice.tools)) return false;
  return choice.tools.some(selector => selector?.type === 'function' && selector.namespace === undefined
    && typeof selector.name === 'string' && dispatchers.has(selector.name));
};

// The dispatcher demotes forced choice to `auto` after the first turn, so synthesized
// echoes restore the captured client shape rather than the final upstream echo.
const restoreEchoedToolChoice = (
  toolChoice: OpenAIResponsesToolChoice | null | undefined,
  active: readonly ActiveHostedTool[],
): OpenAIResponsesToolChoice | null | undefined => {
  for (const entry of active) {
    if (entry.originalToolChoice !== undefined) return entry.originalToolChoice;
  }
  return toolChoice;
};

// Restore top-level hosted declarations in the response.tools echo.
// Unmatched entries pass through unchanged, preserving any fields returned
// by upstream for ordinary client tools.
const restoreEchoedTools = (
  tools: readonly OpenAIResponsesTool[] | undefined,
  active: readonly ActiveHostedTool[],
): OpenAIResponsesTool[] | undefined => {
  if (tools === undefined) return undefined;
  return tools.map(tool => {
    if (tool.type !== 'function' || ('namespace' in tool && tool.namespace !== undefined)) return tool;
    for (const entry of active) {
      if (entry.canonicalHostedTool !== undefined && tool.name === entry.toolName) {
        return entry.canonicalHostedTool;
      }
    }
    return tool;
  });
};

export const resolveHostedToolName = (
  baseName: string,
  tools: readonly OpenAIResponsesTool[],
  input: readonly OpenAIResponsesInputItem[] = [],
  choice?: OpenAIResponsesToolChoice | null,
): string => {
  const MAX_NAME_RESOLUTION_ATTEMPTS = 1000;
  const taken = new Set<string>();
  // Reserve callable leaf names in every scope. A provider may fold flat
  // functions into a namespace; synthetic helpers must not introduce an
  // identity collision even when that provider's naming policy is unknown here.
  const reserveTools = (inventory: readonly OpenAIResponsesTool[]) => {
    for (const tool of inventory) {
      if (tool.type === 'function' || tool.type === 'custom') taken.add(tool.name);
      else if (tool.type === 'namespace' && Array.isArray(tool.tools)) {
        for (const child of tool.tools) {
          if (typeof child === 'object' && child !== null && (child.type === 'function' || child.type === 'custom')) taken.add(child.name);
        }
      }
    }
  };
  reserveTools(tools);
  for (const item of input) {
    if (item.type === 'function_call' || item.type === 'custom_tool_call') taken.add(item.name);
    else if ((item.type === 'tool_search_output' || item.type === 'additional_tools') && Array.isArray(item.tools)) reserveTools(item.tools);
  }
  if (typeof choice === 'object' && choice !== null) {
    const selectors = choice.type === 'allowed_tools' ? (Array.isArray(choice.tools) ? choice.tools : []) : [choice];
    for (const selector of selectors) {
      if (typeof selector === 'object' && selector !== null
        && (selector.type === 'function' || selector.type === 'custom') && typeof selector.name === 'string') {
        // Only the canonical unqualified function name can select this helper.
        // Other selectors must not acquire it through an allocated alias.
        const selectsHelper = selector.type === 'function' && selector.name === baseName
          && (!('namespace' in selector) || selector.namespace === undefined);
        if (!selectsHelper) taken.add(selector.name);
      }
    }
  }
  if (!taken.has(baseName)) return baseName;
  for (let i = 2; i <= MAX_NAME_RESOLUTION_ATTEMPTS; i++) {
    const candidate = `${baseName}_${i}`;
    if (!taken.has(candidate)) return candidate;
  }
  throw new Error(`Unable to resolve a free hosted tool function name for ${baseName} within ${MAX_NAME_RESOLUTION_ATTEMPTS} attempts`);
};

export const historicalClientCallableUsesName = (name: string, input: readonly OpenAIResponsesInputItem[]): boolean =>
  input.some(item => {
    if (item.type === 'additional_tools' || item.type === 'tool_search_output') {
      return Array.isArray(item.tools) && item.tools.some(tool =>
        tool != null && (tool.type === 'function' || tool.type === 'custom') && tool.name === name
        && (!('namespace' in tool) || tool.namespace === undefined));
    }
    return (item.type === 'function_call' || item.type === 'custom_tool_call')
      && item.namespace === undefined && item.name === name;
  });

// Collapse matching hosted declarations within each tools array. Keep the
// last declaration's configuration at the first matching slot so unrelated
// tools retain their relative order.
export const rewriteHostedTools = (
  tools: readonly OpenAIResponsesTool[],
  hosted: HostedToolRewrite,
  toolName: string,
): { rewritten: OpenAIResponsesTool[]; canonicalHostedTool: OpenAIResponsesHostedTool } => {
  const rewritten: OpenAIResponsesTool[] = [];
  let canonicalHostedTool: OpenAIResponsesHostedTool | undefined = undefined;
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
    throw new Error('Hosted hosted-tool registration did not match any request tool');
  }
  rewritten[replacementIndex] = hosted.buildFunctionTool(canonicalHostedTool, toolName);
  return { rewritten, canonicalHostedTool };
};

export const rewriteHostedDeclarations = (
  payload: CanonicalOpenAIResponsesPayload,
  hosted: HostedToolRewrite,
  toolName: string,
): { payload: CanonicalOpenAIResponsesPayload; canonicalTopLevelHostedTool: OpenAIResponsesHostedTool | undefined } => {
  let canonicalHostedTool: OpenAIResponsesHostedTool | undefined;
  const rewrite = (tools: OpenAIResponsesTool[]): OpenAIResponsesTool[] => {
    if (!tools.some(tool => hosted.canonicalize(tool) !== undefined)) return tools;
    const result = rewriteHostedTools(tools, hosted, toolName);
    canonicalHostedTool = result.canonicalHostedTool;
    return result.rewritten;
  };
  const tools = Array.isArray(payload.tools) ? rewrite(payload.tools) : undefined;
  const canonicalTopLevelHostedTool = canonicalHostedTool;
  const input = payload.input.map(item => {
    if (item.type !== 'additional_tools' && item.type !== 'tool_search_output') return item;
    const rewritten = rewrite(item.tools);
    return rewritten === item.tools ? item : { ...item, tools: rewritten };
  });
  if (canonicalHostedTool === undefined) {
    throw new Error('Hosted hosted-tool registration did not match any request tool');
  }
  return {
    payload: { ...payload, ...(tools === undefined ? {} : { tools }), input },
    canonicalTopLevelHostedTool,
  };
};

export const parseHostedToolArguments = (argumentsJson: string): Record<string, unknown> | null => {
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

const syntheticPrologueResponse = (
  state: MergeState,
  id: string,
  model: string,
  active: readonly ActiveHostedTool[],
  status: 'queued' | 'in_progress',
): OpenAIResponsesResult => {
  if (state.upstreamResponseSnapshot === undefined) {
    throw new Error('Hosted-tool execution cannot synthesize an OpenAI Responses prologue envelope before an upstream response snapshot is captured.');
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
    status,
    error: null,
    incomplete_details: null,
    ...(restoredTools !== undefined ? { tools: restoredTools } : {}),
    ...(restoredToolChoice !== undefined ? { tool_choice: restoredToolChoice } : {}),
  };
};

const rewriteOutputIndex = (
  event: OpenAIResponsesStreamEvent,
  openItems: Map<number, number>,
  openItemIds: Map<number, string>,
  merge: MergeState,
): OpenAIResponsesStreamEvent | null => {
  const indexed = event as OpenAIResponsesStreamEvent & { output_index?: unknown; item_id?: unknown };
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
  } as OpenAIResponsesStreamEvent;
};

const captureTerminalEvent = (
  event: OpenAIResponsesStreamEvent,
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

const stampHostedToolEvent = (
  merge: MergeState,
  outputIndex: number,
  itemId: string,
  event: HostedToolLifecycleEvent,
): ProtocolFrame<OpenAIResponsesStreamEvent> =>
  eventFrame({
    ...event,
    output_index: outputIndex,
    item_id: itemId,
    sequence_number: merge.sequenceNumber++,
  } as OpenAIResponsesStreamEvent);

const attachHostedToolItemId = (item: HostedToolOutputItem, id: string): OpenAIResponsesOutputItem => ({ ...item, id } as OpenAIResponsesOutputItem);

const hostedToolStartFrames = (
  merge: MergeState,
  outputIndex: number,
  slot: HostedToolResultSlot,
): ProtocolFrame<OpenAIResponsesStreamEvent>[] => [
  eventFrame({
    type: 'response.output_item.added',
    output_index: outputIndex,
    item: attachHostedToolItemId(slot.startItem, slot.id),
    sequence_number: merge.sequenceNumber++,
  } as OpenAIResponsesStreamEvent),
  ...slot.startEvents.map(event => stampHostedToolEvent(merge, outputIndex, slot.id, event)),
];

const hostedToolEndFrames = (
  merge: MergeState,
  outputIndex: number,
  slot: HostedToolResultSlot,
  result: HostedToolTerminal,
): ProtocolFrame<OpenAIResponsesStreamEvent>[] => {
  const frames = [
    ...result.endEvents.map(event => stampHostedToolEvent(merge, outputIndex, slot.id, event)),
    eventFrame({
      type: 'response.output_item.done',
      output_index: outputIndex,
      item: attachHostedToolItemId(result.item, slot.id),
      sequence_number: merge.sequenceNumber++,
    } as OpenAIResponsesStreamEvent),
  ];
  merge.accumulatedOutput.set(outputIndex, attachHostedToolItemId(result.item, slot.id));
  return frames;
};

export const transformHostedToolItems = (
  items: OpenAIResponsesInputItem[],
  active: readonly ActiveHostedTool[],
): OpenAIResponsesInputItem[] => {
  let next = items;
  for (const entry of active) {
    if (entry.transformItems !== undefined) next = entry.transformItems(next, entry.toolName);
  }
  return next;
};

export const consumeTurnStreaming = async function* (
  frames: AsyncIterable<ProtocolFrame<OpenAIResponsesStreamEvent>>,
  merge: MergeState,
  isFirstTurn: boolean,
  dispatchers: ReadonlyMap<string, HostedToolDispatcher>,
  loopState: HostedToolLoopState,
  active: readonly ActiveHostedTool[],
): AsyncGenerator<ProtocolFrame<OpenAIResponsesStreamEvent>, TurnSummary> {
  const dispatched: Array<{ intercepted: InterceptedFunctionCall; slots: DispatchedHostedToolSlot[] }> = [];
  let sawClientToolCall = false;
  let turnUsage: MergeUsage = {};
  let terminalStatus: UpstreamTerminal | undefined = undefined;

  const openItems = new Map<number, number>();
  const openItemIds = new Map<number, string>();
  // `argumentsJson` accumulates `function_call_arguments.delta` chunks
  // until the closing `.done` parses them into `intercepted.arguments`.
  // Kept on the entry (not on `InterceptedFunctionCall`) because it's
  // streaming state, not part of the dispatcher's input.
  const interceptedByUpstreamIndex = new Map<number, {
    intercepted: InterceptedFunctionCall;
    addedItem: OpenAIResponsesOutputFunctionCall;
    reservedOutputIndex: number;
    argumentsJson: string;
    bufferedEvents: OpenAIResponsesStreamEvent[];
  }>();

  const ensureModel = (): string => {
    if (merge.lastSeenModel === null) {
      throw new Error('Hosted-tool execution cannot synthesize an OpenAI Responses envelope because upstream `response.created` did not report a `model` field.');
    }
    return merge.lastSeenModel;
  };

  const stamp = (event: OpenAIResponsesStreamEvent): ProtocolFrame<OpenAIResponsesStreamEvent> =>
    eventFrame({
      ...event,
      sequence_number: merge.sequenceNumber++,
    } as OpenAIResponsesStreamEvent);

  for await (const frame of frames) {
    if (frame.type !== 'event') {
      yield frame;
      continue;
    }
    const event = frame.event;

    if (event.type === 'response.queued' || event.type === 'response.created') {
      const reportedModel = event.response.model;
      if (typeof reportedModel === 'string' && reportedModel.length > 0) merge.lastSeenModel = reportedModel;
      merge.upstreamResponseSnapshot = event.response;
      ensureModel();
      if (isFirstTurn) {
        const status = event.type === 'response.queued' ? 'queued' : 'in_progress';
        yield stamp({
          type: event.type,
          response: syntheticPrologueResponse(merge, merge.synthesizedResponseId, ensureModel(), active, status),
        } as OpenAIResponsesStreamEvent);
      }
      continue;
    }

    if (event.type === 'response.in_progress') {
      if (isFirstTurn) {
        yield stamp({
          type: 'response.in_progress',
          response: syntheticPrologueResponse(merge, merge.synthesizedResponseId, ensureModel(), active, 'in_progress'),
        });
      }
      continue;
    }

    if (event.type === 'error') {
      const e = event as Extract<OpenAIResponsesStreamEvent, { type: 'error' }>;
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
        if (dispatchers.has(item.name)) {
          // Reserve the downstream index the dispatcher call occupies now, at
          // `.added`; the actual slot count is only known at `.done`,
          // where slot 0 takes this reserved index and any further slots
          // take fresh ones. Those stay contiguous because OpenAI Responses
          // output items stream sequentially — one item's `.added`…`.done`
          // completes before the next item's `.added`, so nothing
          // allocates a downstream index between this reservation and the
          // dispatch below. Buffer a colliding namespaced client call too:
          // the completed item owns the final dispatch identity.
          interceptedByUpstreamIndex.set(upstreamIndex, {
            addedItem: item,
            reservedOutputIndex: merge.outputIndex++,
            argumentsJson: '',
            bufferedEvents: [],
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
      const wireItemId = (item as { id?: unknown }).id;
      const itemId = typeof wireItemId === 'string' && wireItemId.length > 0
        ? wireItemId
        : item.type === 'message'
          ? createRandomOpenAIResponsesItemId('message')
          : undefined;
      if (itemId !== undefined) openItemIds.set(upstreamIndex, itemId);
      yield stamp({
        type: 'response.output_item.added',
        output_index: downstreamIndex,
        item: itemId !== undefined && wireItemId !== itemId ? { ...item, id: itemId } as OpenAIResponsesOutputItem : item,
      });
      continue;
    }

    if (event.type === 'response.output_item.done') {
      const upstreamIndex = event.output_index;
      const intercepted = interceptedByUpstreamIndex.get(upstreamIndex);
      if (intercepted !== undefined) {
        if (event.item.type !== 'function_call' || event.item.name !== intercepted.intercepted.name
          || event.item.call_id !== intercepted.intercepted.callId || event.item.id !== intercepted.addedItem.id) {
          throw new Error('Upstream changed a hosted-tool function identity before closing its call.');
        }
        const finalDispatcher = event.item.namespace === undefined ? dispatchers.get(event.item.name) : undefined;
        if (finalDispatcher === undefined) {
          const downstreamIndex = intercepted.reservedOutputIndex;
          const itemId = intercepted.addedItem.id ?? event.item.id;
          const doneItem = itemId === undefined ? event.item : { ...event.item, id: itemId };
          openItems.set(upstreamIndex, downstreamIndex);
          if (itemId !== undefined) openItemIds.set(upstreamIndex, itemId);
          sawClientToolCall = true;
          yield stamp({
            type: 'response.output_item.added', output_index: downstreamIndex,
            item: { ...doneItem, arguments: '', status: 'in_progress' },
          });
          for (const buffered of intercepted.bufferedEvents) {
            const rewritten = rewriteOutputIndex(buffered, openItems, openItemIds, merge);
            if (rewritten !== null) yield stamp(rewritten);
          }
          yield stamp({ type: 'response.output_item.done', output_index: downstreamIndex, item: doneItem });
          merge.accumulatedOutput.set(downstreamIndex, doneItem);
          interceptedByUpstreamIndex.delete(upstreamIndex);
          continue;
        }
        intercepted.intercepted.name = event.item.name;
        intercepted.argumentsJson = event.item.arguments;
        intercepted.intercepted.arguments = parseHostedToolArguments(intercepted.argumentsJson);
        const slots = finalDispatcher({ intercepted: intercepted.intercepted, loopState });
        if (loopState.remainingToolCalls !== undefined) loopState.remainingToolCalls -= 1;
        const dispatchedSlots: DispatchedHostedToolSlot[] = [];
        for (const [slotIndex, slot] of slots.entries()) {
          const outputIndex = slotIndex === 0 ? intercepted.reservedOutputIndex : merge.outputIndex++;
          dispatchedSlots.push({ intercepted: intercepted.intercepted, slot, outputIndex });
          yield* hostedToolStartFrames(merge, outputIndex, slot);
        }
        dispatched.push({ intercepted: intercepted.intercepted, slots: dispatchedSlots });
        continue;
      }

      const downstreamIndex = openItems.get(upstreamIndex);
      if (downstreamIndex === undefined) continue;
      const itemId = openItemIds.get(upstreamIndex);
      const upstreamDoneItemId = (event.item as { id?: unknown }).id;
      const doneItem: OpenAIResponsesOutputItem = itemId !== undefined && upstreamDoneItemId !== itemId
        ? { ...event.item, id: itemId } as OpenAIResponsesOutputItem
        : event.item;
      yield stamp({ type: 'response.output_item.done', output_index: downstreamIndex, item: doneItem });
      merge.accumulatedOutput.set(downstreamIndex, doneItem);
      continue;
    }

    if (event.type === 'response.function_call_arguments.delta') {
      const intercepted = interceptedByUpstreamIndex.get(event.output_index);
      if (intercepted !== undefined) {
        intercepted.argumentsJson += event.delta;
        intercepted.bufferedEvents.push(event);
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
        intercepted.bufferedEvents.push(event);
        continue;
      }
      const rewritten = rewriteOutputIndex(event, openItems, openItemIds, merge);
      if (rewritten !== null) yield stamp(rewritten);
      continue;
    }

    const maybeIndexedForIntercepted = event as OpenAIResponsesStreamEvent & { output_index?: unknown };
    const pending = typeof maybeIndexedForIntercepted.output_index === 'number'
      ? interceptedByUpstreamIndex.get(maybeIndexedForIntercepted.output_index) : undefined;
    if (pending !== undefined) {
      pending.bufferedEvents.push(event);
      continue;
    }

    // Filler a transport injects to hold a connection open. It has to be named
    // here, because the positionless fall-through below forwards whatever it
    // does not recognize. `keepalive` is openai-node's name for the same frame.
    // https://github.com/openai/openai-node/blob/d77cf24d9f3885739c6cba76bc009abf0ab97428/src/lib/responses/ResponseAccumulator.ts#L382-L386
    if ((event.type as string) === 'ping' || (event.type as string) === 'keepalive') continue;

    const rewriteResult = rewriteOutputIndex(event, openItems, openItemIds, merge);
    if (rewriteResult !== null) {
      const maybeItemEvent = rewriteResult as OpenAIResponsesStreamEvent & { output_index?: number; item?: unknown };
      if (maybeItemEvent.item !== undefined && typeof maybeItemEvent.output_index === 'number' && (rewriteResult.type.endsWith('.added') || rewriteResult.type.endsWith('.done'))) {
        merge.accumulatedOutput.set(maybeItemEvent.output_index, maybeItemEvent.item as Parameters<MergeState['accumulatedOutput']['set']>[1]);
      }
      yield stamp(rewriteResult);
      continue;
    }

    // No event of the current protocol reaches here; every positionless type is
    // answered above. This line is for what the protocol grows:
    // `parseOpenAIResponsesStream` classifies by deny-list so an unrecognized type
    // survives as structured, and dropping it here would spend that guarantee.
    yield stamp(event);
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
          message: `Upstream emitted ${priorLabel} without closing dispatcher call items at upstream output_index ${unmatched.join(', ')}.`,
          code: 'server_error',
        },
        incomplete_details: null,
      },
    };
  }

  return { dispatched, sawClientToolCall, turnUsage, terminalStatus };
};

const MAX_BODY_EXCERPT_CHARS = 512;

/** What a refusal mid-loop becomes on the synthesized terminal. An upstream that wrote an
 *  OpenAI-shaped envelope is quoted verbatim — its own code, type and sentence — because that is
 *  what a client reads; anything else is reported as the status plus an excerpt of what came. */
export const buildErrorFromRefusal = (
  status: number,
  body: string,
): NonNullable<OpenAIResponsesResult['error']> => {
  const result = { status, body };
  const decoded = body;
  let parsed: unknown = undefined;
  try {
    parsed = JSON.parse(decoded);
  } catch {
    parsed = undefined;
  }
  const err = typeof parsed === 'object' && parsed !== null ? (parsed as { error?: unknown }).error : undefined;
  if (typeof err === 'object' && err !== null) {
    const e = err as Record<string, unknown>;
    const out: NonNullable<OpenAIResponsesResult['error']> = {
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

const SYNTHESIZED_TERMINAL_FRAME: Record<SynthesizedTerminal['kind'], { type: 'response.completed' | 'response.failed' | 'response.incomplete'; status: OpenAIResponsesResult['status'] }> = {
  completed: { type: 'response.completed', status: 'completed' },
  failed: { type: 'response.failed', status: 'failed' },
  incomplete: { type: 'response.incomplete', status: 'incomplete' },
};

export const synthesizeTerminalEnvelope = (
  state: MergeState,
  kind: SynthesizedTerminal,
  active: readonly ActiveHostedTool[],
): ProtocolFrame<OpenAIResponsesStreamEvent> => {
  if (state.lastSeenModel === null) {
    throw new Error('Hosted-tool execution cannot synthesize an OpenAI Responses terminal envelope before upstream `response.created` reports a model.');
  }
  if (state.upstreamResponseSnapshot === undefined) {
    throw new Error('Hosted-tool execution cannot synthesize an OpenAI Responses terminal envelope before upstream `response.created` is captured.');
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
  } as OpenAIResponsesStreamEvent);
};

export async function* materializeHostedToolItems(
  dispatched: ReadonlyArray<{ slots: DispatchedHostedToolSlot[] }>,
  merge: MergeState,
  store: OpenAIResponsesStatefulStore,
): AsyncGenerator<ProtocolFrame<OpenAIResponsesStreamEvent>, void> {
  for (const d of dispatched) {
    for (const { slot, outputIndex } of d.slots) {
      const lifecycle = slot.run();
      try {
        let step = await lifecycle.next();
        while (!step.done) {
          yield stampHostedToolEvent(merge, outputIndex, slot.id, step.value);
          step = await lifecycle.next();
        }
        // Register dispatcher state before item.done makes its stored row reusable.
        store.registerPrivatePayload(slot.id, step.value.privatePayload);
        yield* hostedToolEndFrames(merge, outputIndex, slot, step.value);
      } finally {
        await lifecycle.return(undefined as never);
      }
    }
  }
}
