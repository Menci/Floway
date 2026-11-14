import { jsonrepair } from 'jsonrepair';

import type { MergeState, MergeUsage, ActiveHostedTool, HostedToolRewrite, HostedToolDispatcher, HostedToolHistoryExpansion, UpstreamTerminal, HostedToolLifecycleEvent, HostedToolOutputItem, HostedToolResultSlot, HostedToolSlotResult, HostedToolLoopState, TurnSummary, InterceptedFunctionCall, DispatchedHostedToolSlot, SynthesizedTerminal } from './types.ts';
import { mintedErrorEnvelope, renderFailure, type Failure } from '../../../pipeline/facts.ts';
import { eventFrame, isJsonObject, type ProtocolFrame } from '@floway-dev/protocols/common';
import {
  createRandomOpenAIResponsesItemId,
  isOpenAIResponsesAssistantInputItem,
  isOpenAIResponsesTerminalEvent,
  type CanonicalOpenAIResponsesInputItem,
  type CanonicalOpenAIResponsesPayload,
  type OpenAIResponsesErrorEx,
  type OpenAIResponsesErrorPayload,
  type OpenAIResponsesHostedTool,
  type OpenAIResponsesOutputFunctionCallEx,
  type OpenAIResponsesOutputItemEx,
  type OpenAIResponsesResultEx,
  type OpenAIResponsesStreamEventEx,
  type OpenAIResponsesTool,
  type OpenAIResponsesToolChoice,
} from '@floway-dev/protocols/openai-responses';
import type { SidecarCodec } from '@floway-dev/translate';

interface OpenAIResponsesHostedToolCallPayload {
  v: 1;
  type: string;
  functionCall: OpenAIResponsesOutputFunctionCallEx;
  data?: unknown;
}

const HOSTED_TOOL_REPLAY_VERSION = 1;

export const createMergeState = (): MergeState => ({
  sequenceNumber: 0,
  outputIndex: 0,
  accumulatedOutput: new Map(),
  accumulatedUsage: {},
  lastSeenModel: null,
  synthesizedResponseId: `resp_hosted_${crypto.randomUUID().replace(/-/g, '')}`,
  upstreamResponseSnapshot: undefined,
});

export const materializeAccumulatedOutput = (state: MergeState): OpenAIResponsesOutputItemEx[] => {
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

const usageForWire = (state: MergeState): NonNullable<OpenAIResponsesResultEx['usage']> | undefined => {
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

const usageOf = (usage: OpenAIResponsesResultEx['usage']): MergeUsage => {
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
  input: readonly CanonicalOpenAIResponsesInputItem[] = [],
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

export const historicalClientCallableUsesName = (name: string, input: readonly CanonicalOpenAIResponsesInputItem[]): boolean =>
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
    const canonical = hosted.recognizeHostedTool(raw);
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
    if (!tools.some(tool => hosted.recognizeHostedTool(tool) !== undefined)) return tools;
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
): OpenAIResponsesResultEx => {
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
  event: OpenAIResponsesStreamEventEx,
  openItems: Map<number, number>,
  openItemIds: Map<number, string>,
  merge: MergeState,
): OpenAIResponsesStreamEventEx | null => {
  const indexed = event as OpenAIResponsesStreamEventEx & { output_index?: unknown; item_id?: unknown };
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
  } as OpenAIResponsesStreamEventEx;
};

const captureTerminalEvent = (
  event: OpenAIResponsesStreamEventEx,
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
): ProtocolFrame<OpenAIResponsesStreamEventEx> =>
  eventFrame({
    ...event,
    output_index: outputIndex,
    item_id: itemId,
    sequence_number: merge.sequenceNumber++,
  } as OpenAIResponsesStreamEventEx);

const attachHostedToolItemId = (item: HostedToolOutputItem, id: string): OpenAIResponsesOutputItemEx => ({ ...item, id } as OpenAIResponsesOutputItemEx);

const hostedToolStartFrames = (
  merge: MergeState,
  outputIndex: number,
  slot: HostedToolResultSlot,
): ProtocolFrame<OpenAIResponsesStreamEventEx>[] => [
  eventFrame({
    type: 'response.output_item.added',
    output_index: outputIndex,
    item: attachHostedToolItemId(slot.startItem, slot.id),
    sequence_number: merge.sequenceNumber++,
  } as OpenAIResponsesStreamEventEx),
  ...slot.startEvents.map(event => stampHostedToolEvent(merge, outputIndex, slot.id, event)),
];

const hostedToolEndFrames = (
  merge: MergeState,
  outputIndex: number,
  slot: HostedToolResultSlot,
  result: HostedToolSlotResult,
): ProtocolFrame<OpenAIResponsesStreamEventEx>[] => {
  const frames = [
    ...result.endEvents.map(event => stampHostedToolEvent(merge, outputIndex, slot.id, event)),
    eventFrame({
      type: 'response.output_item.done',
      output_index: outputIndex,
      item: attachHostedToolItemId(result.item, slot.id),
      sequence_number: merge.sequenceNumber++,
    } as OpenAIResponsesStreamEventEx),
  ];
  merge.accumulatedOutput.set(outputIndex, attachHostedToolItemId(result.item, slot.id));
  return frames;
};

const isCallBatchItem = (item: CanonicalOpenAIResponsesInputItem): boolean =>
  item.type === 'function_call' || item.type === 'custom_tool_call';

/**
 * Rewrites hosted items in the history into the function call and output the upstream reads.
 *
 * Within each assistant turn, every signed reasoning carrier is decoded once and consumed before
 * ordinary items; the nth carrier pairs with the nth hosted item it matches by type, so per-turn
 * ordinals and the user-side boundaries survive. Returns the input itself when nothing in it is
 * a carrier or a hosted item.
 */
export const expandHostedToolHistory = async (
  items: CanonicalOpenAIResponsesInputItem[],
  active: readonly ActiveHostedTool[],
  codec: SidecarCodec,
): Promise<CanonicalOpenAIResponsesInputItem[]> => {
  const result: CanonicalOpenAIResponsesInputItem[] = [];
  let changed = false;
  for (let start = 0; start < items.length;) {
    if (!isOpenAIResponsesAssistantInputItem(items[start])) {
      result.push(items[start++]);
      continue;
    }
    let end = start + 1;
    while (end < items.length && isOpenAIResponsesAssistantInputItem(items[end])) end++;
    const turn = items.slice(start, end);
    start = end;

    const decoded = await Promise.all(turn.flatMap(item => item.type === 'reasoning' && typeof item.encrypted_content === 'string'
      ? [codec.decode(item.encrypted_content)] : []));
    const replays: OpenAIResponsesHostedToolCallPayload[] = [];
    const content: CanonicalOpenAIResponsesInputItem[] = [];
    let decodedIndex = 0;
    for (const item of turn) {
      const value = item.type === 'reasoning' && typeof item.encrypted_content === 'string' ? decoded[decodedIndex++] : undefined;
      if (value === undefined) { content.push(item); continue; }
      if (!isJsonObject(value) || value.v !== HOSTED_TOOL_REPLAY_VERSION || typeof value.type !== 'string' || !isJsonObject(value.functionCall)
        || value.functionCall.type !== 'function_call' || typeof value.functionCall.call_id !== 'string'
        || typeof value.functionCall.name !== 'string' || typeof value.functionCall.arguments !== 'string') {
        throw new TypeError('Invalid hosted-tool replay data');
      }
      replays.push(value as unknown as OpenAIResponsesHostedToolCallPayload);
      changed = true;
    }

    const feedback: CanonicalOpenAIResponsesInputItem[] = [];
    let carrierIndex = 0;
    for (const item of content) {
      const candidate = replays[carrierIndex];
      const replay = candidate?.type === item.type ? candidate : undefined;
      // A recognized replay owns its hosted item ordinal even when no active
      // tool claims the item. Otherwise a later hosted call would consume this
      // carrier and restore the wrong original call.
      if (replay !== undefined) carrierIndex++;
      const toolReplay = replay === undefined ? undefined : { data: replay.data };
      let ownedExpansion: { toolName: string; expansion: HostedToolHistoryExpansion } | undefined;
      for (const entry of active) {
        const expansion = entry.expandHistoryItem?.(item, toolReplay);
        if (expansion !== undefined) { ownedExpansion = { toolName: entry.toolName, expansion }; break; }
      }
      if (ownedExpansion !== undefined) {
        const { toolName, expansion } = ownedExpansion;
        let functionCall: OpenAIResponsesOutputFunctionCallEx;
        if (expansion.callSource === 'replay') {
          if (replay === undefined) throw new TypeError('Hosted-tool history expansion matched an absent replay');
          functionCall = replay.functionCall;
        } else {
          functionCall = {
            type: 'function_call', call_id: expansion.synthesizedCall.callId, name: toolName,
            arguments: expansion.synthesizedCall.arguments, status: 'completed',
          };
        }
        changed = true;
        result.push(functionCall);
        feedback.push({ type: 'function_call_output', call_id: functionCall.call_id, output: expansion.output }, ...expansion.feedback ?? []);
        continue;
      }
      if (!isCallBatchItem(item)) {
        result.push(...feedback);
        feedback.length = 0;
      }
      result.push(item);
    }
    result.push(...feedback);
  }
  return changed ? result : items;
};

const deferHostedCallBatch = async function* (
  frames: AsyncIterable<ProtocolFrame<OpenAIResponsesStreamEventEx>>,
  dispatchers: ReadonlyMap<string, HostedToolDispatcher>,
): AsyncGenerator<ProtocolFrame<OpenAIResponsesStreamEventEx>> {
  let deferring = false;
  const deferredIndexes = new Set<number>();
  const pending = new Map<number, ProtocolFrame<OpenAIResponsesStreamEventEx>[]>();
  // A hosted item combines a call and its result. Keep subsequent assistant
  // content ahead of that result, while preserving order inside the call batch.
  // Otherwise echoing the public output loses the assistant/tool boundaries.
  try {
    for await (const frame of frames) {
      if (frame.type === 'done' || isOpenAIResponsesTerminalEvent(frame.event) || frame.event.type === 'error') {
        for (const batch of pending.values()) yield* batch;
        pending.clear();
        yield frame;
        continue;
      }
      const event = frame.event;
      if (event.type === 'response.output_item.added') {
        if (event.item.type === 'function_call' && event.item.namespace === undefined && dispatchers.has(event.item.name)) deferring = true;
        if (deferring && (event.item.type === 'function_call' || event.item.type === 'custom_tool_call')) deferredIndexes.add(event.output_index);
      }
      if ('output_index' in event && typeof event.output_index === 'number' && deferredIndexes.has(event.output_index)) {
        const batch = pending.get(event.output_index) ?? [];
        batch.push(frame);
        pending.set(event.output_index, batch);
      } else yield frame;
    }
  } catch (error) {
    for (const batch of pending.values()) yield* batch;
    throw error;
  }
  for (const batch of pending.values()) yield* batch;
};

export const consumeTurnStreaming = async function* (
  frames: AsyncIterable<ProtocolFrame<OpenAIResponsesStreamEventEx>>,
  merge: MergeState,
  isFirstTurn: boolean,
  dispatchers: ReadonlyMap<string, HostedToolDispatcher>,
  loopState: HostedToolLoopState,
  active: readonly ActiveHostedTool[],
): AsyncGenerator<ProtocolFrame<OpenAIResponsesStreamEventEx>, TurnSummary> {
  const dispatchedSlots: DispatchedHostedToolSlot[] = [];
  let sawHostedToolCall = false;
  let sawClientToolCall = false;
  let turnUsage: MergeUsage = {};
  let terminalStatus: UpstreamTerminal | undefined = undefined;
  let errorEvent: Extract<OpenAIResponsesStreamEventEx, { type: 'error' }> | undefined;

  const openItems = new Map<number, number>();
  const openItemIds = new Map<number, string>();
  const interceptedByUpstreamIndex = new Map<number, {
    addedItem: OpenAIResponsesOutputFunctionCallEx;
    reservedOutputIndex: number;
    bufferedEvents: OpenAIResponsesStreamEventEx[];
  }>();

  const ensureModel = (): string => {
    if (merge.lastSeenModel === null) {
      throw new Error('Hosted-tool execution cannot synthesize an OpenAI Responses envelope because upstream `response.created` did not report a `model` field.');
    }
    return merge.lastSeenModel;
  };

  const stamp = (event: OpenAIResponsesStreamEventEx): ProtocolFrame<OpenAIResponsesStreamEventEx> =>
    eventFrame({
      ...event,
      sequence_number: merge.sequenceNumber++,
    } as OpenAIResponsesStreamEventEx);

  for await (const frame of deferHostedCallBatch(frames, dispatchers)) {
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
        } as OpenAIResponsesStreamEventEx);
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
      errorEvent = event;
      yield stamp(event);
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
          // The deferred batch is grouped by first appearance, so its calls
          // allocate adjacent replay/item pairs even for interleaved deltas.
          // A final namespace can still identify a colliding client call;
          // reserve only one index until the completed identity is known.
          interceptedByUpstreamIndex.set(upstreamIndex, {
            addedItem: item,
            reservedOutputIndex: merge.outputIndex++,
            bufferedEvents: [],
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
        item: itemId !== undefined && wireItemId !== itemId ? { ...item, id: itemId } as OpenAIResponsesOutputItemEx : item,
      });
      continue;
    }

    if (event.type === 'response.output_item.done') {
      const upstreamIndex = event.output_index;
      const intercepted = interceptedByUpstreamIndex.get(upstreamIndex);
      if (intercepted !== undefined) {
        if (event.item.type !== 'function_call' || event.item.name !== intercepted.addedItem.name
          || event.item.call_id !== intercepted.addedItem.call_id || event.item.id !== intercepted.addedItem.id) {
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
        const call: InterceptedFunctionCall = { functionCall: event.item, parsedArguments: parseHostedToolArguments(event.item.arguments) };
        const slots = finalDispatcher({ intercepted: call, loopState });
        sawHostedToolCall = true;
        interceptedByUpstreamIndex.delete(upstreamIndex);
        if (loopState.remainingToolCalls !== undefined) loopState.remainingToolCalls -= 1;
        for (const [slotIndex, slot] of slots.entries()) {
          const carrierIndex = slotIndex === 0 ? intercepted.reservedOutputIndex : merge.outputIndex++;
          const outputIndex = merge.outputIndex++;
          const carrierId = createRandomOpenAIResponsesItemId('reasoning');
          dispatchedSlots.push({ intercepted: call, slot, outputIndex, carrierIndex, carrierId });
          yield stamp({ type: 'response.output_item.added', output_index: carrierIndex, item: { type: 'reasoning', id: carrierId, summary: [] } });
          yield* hostedToolStartFrames(merge, outputIndex, slot);
        }
        continue;
      }

      const downstreamIndex = openItems.get(upstreamIndex);
      if (downstreamIndex === undefined) continue;
      const itemId = openItemIds.get(upstreamIndex);
      const upstreamDoneItemId = (event.item as { id?: unknown }).id;
      const doneItem: OpenAIResponsesOutputItemEx = itemId !== undefined && upstreamDoneItemId !== itemId
        ? { ...event.item, id: itemId } as OpenAIResponsesOutputItemEx
        : event.item;
      yield stamp({ type: 'response.output_item.done', output_index: downstreamIndex, item: doneItem });
      merge.accumulatedOutput.set(downstreamIndex, doneItem);
      continue;
    }

    if (event.type === 'response.function_call_arguments.delta') {
      const intercepted = interceptedByUpstreamIndex.get(event.output_index);
      if (intercepted !== undefined) {
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
        intercepted.bufferedEvents.push(event);
        continue;
      }
      const rewritten = rewriteOutputIndex(event, openItems, openItemIds, merge);
      if (rewritten !== null) yield stamp(rewritten);
      continue;
    }

    const maybeIndexedForIntercepted = event as OpenAIResponsesStreamEventEx & { output_index?: unknown };
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
      const maybeItemEvent = rewriteResult as OpenAIResponsesStreamEventEx & { output_index?: number; item?: unknown };
      if (maybeItemEvent.item !== undefined && typeof maybeItemEvent.output_index === 'number' && (rewriteResult.type.endsWith('.added') || rewriteResult.type.endsWith('.done'))) {
        merge.accumulatedOutput.set(maybeItemEvent.output_index, maybeItemEvent.item as Parameters<MergeState['accumulatedOutput']['set']>[1]);
      }
      yield stamp(rewriteResult);
      continue;
    }

    // Preserve positionless events and unknown types admitted by
    // parseOpenAIResponsesStream so the stage retains the parser's pass-through contract.
    yield stamp(event);
  }

  if (terminalStatus === undefined) {
    if (errorEvent !== undefined) {
      terminalStatus = { kind: 'error', event: errorEvent };
    } else if (merge.lastSeenModel === null) {
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

  if (interceptedByUpstreamIndex.size > 0) {
    const unmatched = [...interceptedByUpstreamIndex.keys()];
    const priorKind = terminalStatus.kind;
    const priorLabel = priorKind === 'error' ? 'an error event' : priorKind === 'bare-error-pre-shell' ? 'a pre-shell bare error' : `response.${priorKind}`;
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

  return { dispatchedSlots, sawHostedToolCall, sawClientToolCall, turnUsage, terminalStatus };
};

/** A descent that refused, as the `error` event that precedes the failed terminal. Its body is
 *  what the edge would have answered with: the refusing upstream's own words when it sent any. */
export const errorEventFromRefusal = (failure: Failure): Extract<OpenAIResponsesStreamEventEx, { type: 'error' }> =>
  ({ ...renderFailure(failure, mintedErrorEnvelope).body, type: 'error' }) as Extract<OpenAIResponsesStreamEventEx, { type: 'error' }>;

export const responseErrorFromEvent = (
  event: Extract<OpenAIResponsesStreamEventEx, { type: 'error' }>,
): OpenAIResponsesErrorEx | null => {
  const { type: _type, sequence_number: _sequenceNumber, ...fields } = event;
  const payload = ('error' in fields && isJsonObject(fields.error) ? fields.error : fields) as OpenAIResponsesErrorPayload;
  return typeof payload.code === 'string' ? { ...payload, code: payload.code, message: payload.message } : null;
};

const SYNTHESIZED_TERMINAL_FRAME: Record<SynthesizedTerminal['kind'], { type: 'response.completed' | 'response.failed' | 'response.incomplete'; status: OpenAIResponsesResultEx['status'] }> = {
  completed: { type: 'response.completed', status: 'completed' },
  failed: { type: 'response.failed', status: 'failed' },
  incomplete: { type: 'response.incomplete', status: 'incomplete' },
};

export const synthesizeTerminalEnvelope = (
  state: MergeState,
  kind: SynthesizedTerminal,
  active: readonly ActiveHostedTool[],
): ProtocolFrame<OpenAIResponsesStreamEventEx> => {
  if (state.lastSeenModel === null) {
    throw new Error('Hosted-tool execution cannot synthesize an OpenAI Responses terminal envelope before upstream `response.created` reports a model.');
  }
  if (state.upstreamResponseSnapshot === undefined) {
    throw new Error('Hosted-tool execution cannot synthesize an OpenAI Responses terminal envelope before upstream `response.created` is captured.');
  }
  const output = materializeAccumulatedOutput(state);
  const usage = usageForWire(state);
  const frame = SYNTHESIZED_TERMINAL_FRAME[kind.kind];
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
      ...(restoredTools !== undefined ? { tools: restoredTools } : {}),
      ...(restoredToolChoice !== undefined ? { tool_choice: restoredToolChoice } : {}),
      ...(usage !== undefined ? { usage } : {}),
      ...(kind.kind === 'failed' ? { error: kind.error } : {}),
      ...(kind.kind === 'incomplete' ? { incomplete_details: kind.incompleteDetails } : {}),
    },
  } as OpenAIResponsesStreamEventEx);
};

export async function* materializeHostedToolItems(
  dispatchedSlots: readonly DispatchedHostedToolSlot[],
  merge: MergeState,
  codec: SidecarCodec,
): AsyncGenerator<ProtocolFrame<OpenAIResponsesStreamEventEx>, void> {
  for (const { intercepted, slot, outputIndex, carrierIndex, carrierId } of dispatchedSlots) {
    const lifecycle = slot.run();
    let result: HostedToolSlotResult;
    try {
      let step = await lifecycle.next();
      while (!step.done) {
        yield stampHostedToolEvent(merge, outputIndex, slot.id, step.value);
        step = await lifecycle.next();
      }
      result = step.value;
    } finally {
      await lifecycle.return(undefined as never);
    }
    const replayItem: OpenAIResponsesOutputItemEx = {
      type: 'reasoning', id: carrierId, summary: [],
      encrypted_content: await codec.encode({
        v: HOSTED_TOOL_REPLAY_VERSION,
        type: result.item.type,
        functionCall: intercepted.functionCall,
        ...(result.replayData === undefined ? {} : { data: result.replayData }),
      }),
    };
    merge.accumulatedOutput.set(carrierIndex, replayItem);
    yield eventFrame({ type: 'response.output_item.done', output_index: carrierIndex, item: replayItem, sequence_number: merge.sequenceNumber++ });
    yield* hostedToolEndFrames(merge, outputIndex, slot, result);
  }
}
