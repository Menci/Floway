import { jsonrepair } from 'jsonrepair';

import { openAIResponsesError } from './error.ts';
import { openAIResponsesExit, openAIResponsesFactSpace } from './facts.ts';
import { registerImageGeneration } from './hosted-tools/image-generation.ts';
import { registerWebSearch } from './hosted-tools/web-search.ts';
import { openAIResponsesTargetFor } from './target.ts';
import type { PipelineAuthFacts, ServeCandidate } from '../../../pipeline/facts.ts';
import type { GatewayServices } from '../../../pipeline/services.ts';
import { readProtocolFrames } from '../../pipeline/protocol-frames.ts';
import { SidecarDomain } from '../../shared/sidecar-codec.ts';
import type { HttpRequestFact } from '@floway-dev/http';
import { move, type Pipeline } from '@floway-dev/pipeline';
import { eventFrame, isJsonObject, type ProtocolFrame } from '@floway-dev/protocols/common';
import {
  createRandomOpenAIResponsesItemId,
  isOpenAIResponsesAssistantInputItem,
  isOpenAIResponsesTerminalEvent,
  type CanonicalOpenAIResponsesPayload,
  type OpenAIResponsesFunctionTool,
  type OpenAIResponsesFunctionCallOutputItem,
  type OpenAIResponsesHostedTool,
  type CanonicalOpenAIResponsesInputItem,
  type OpenAIResponsesOutputFunctionCallEx,
  type OpenAIResponsesOutputItemEx,
  type OpenAIResponsesResultEx,
  type OpenAIResponsesErrorEx,
  type OpenAIResponsesErrorPayload,
  type OpenAIResponsesStreamEventEx,
  type OpenAIResponsesTool,
  type OpenAIResponsesToolChoice,
} from '@floway-dev/protocols/openai-responses';
import { internalDebugErrorFields, toInternalDebugError, type ProtocolError, type ProtocolStreamError } from '@floway-dev/provider';
import type { SidecarCodec } from '@floway-dev/translate';

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
  accumulatedOutput: Map<number, OpenAIResponsesOutputItemEx>;
  outputSizes: Map<number, number>;
  outputBytes: number;
  accumulatedUsage: MergeUsage;
  lastSeenModel: string | null;
  synthesizedResponseId: string;
  upstreamResponseSnapshot: OpenAIResponsesResultEx | undefined;
}

export interface InterceptedFunctionCall {
  functionCall: OpenAIResponsesOutputFunctionCallEx;
  /**
   * Parsed and jsonrepair-cleaned `arguments` object. `null` when the
   * raw upstream string is not a JSON object even after jsonrepair —
   * dispatchers handle that case via their own error path. Execution uses
   * this repaired value; history replays the original functionCall.
   */
  parsedArguments: Record<string, unknown> | null;
}

export interface ServerToolSlotResult {
  item: ServerToolOutputItem;
  endEvents: ServerToolLifecycleEvent[];
  replayData?: unknown;
}

interface OpenAIResponsesHostedToolCallPayload {
  v: 1;
  type: string;
  functionCall: OpenAIResponsesOutputFunctionCallEx;
  data?: unknown;
}

const SERVER_TOOL_REPLAY_VERSION = 1;

export type ServerToolHistoryExpansion = (
  | { callSource: 'replay' }
  | { callSource: 'synthesized'; synthesizedCall: { callId: string; arguments: string } }
) & {
  output: OpenAIResponsesFunctionCallOutputItem['output'];
  feedback?: Array<Extract<CanonicalOpenAIResponsesInputItem, { type: 'message' }> & { role: 'user' }>;
};

export interface ServerToolResultSlot {
  id: string;
  startItem: ServerToolOutputItem;
  startEvents: readonly ServerToolLifecycleEvent[];
  // The deferred portion of a slot's lifecycle, driven at materialization
  // time. It yields any intermediate lifecycle events as they arrive — e.g.
  // progressively-rendered `image_generation_call.partial_image` frames a
  // streamed backend delivers over the course of the call — and returns the
  // terminal item plus its closing events and replay data. A tool with no
  // progressive output simply yields nothing and returns immediately.
  run: () => AsyncGenerator<ServerToolLifecycleEvent, ServerToolSlotResult>;
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
  carrierIndex: number;
  carrierId: string;
}

export type ServerToolDispatcher = (args: {
  intercepted: InterceptedFunctionCall;
  loopState: ServerToolLoopState;
  runner: HostedToolRunner;
}) => ServerToolResultSlot[];

// Keep hosted matching, function injection, and dispatch atomic so a
// registration cannot silently omit part of a server-tool family.
// The builder receives the declaration its own family recognized, so each
// family states its declaration type; method members keep that per-family
// parameter assignable to the shared registration.
export interface ServerToolHostedDispatch {
  hostedTypes: readonly string[];
  recognizeHostedTool(raw: OpenAIResponsesTool): OpenAIResponsesHostedTool | undefined;
  buildFunctionTool(canonical: OpenAIResponsesHostedTool, toolName: string): OpenAIResponsesFunctionTool;
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
    // Return undefined for items this tool does not own. The shim restores the
    // original call and pairs its output before appending tool-specific feedback.
    expandHistoryItem?: (item: CanonicalOpenAIResponsesInputItem, replay?: { data: unknown }) => ServerToolHistoryExpansion | undefined;
    // Present only when the request declares this hosted tool; absent for
    // replay-only activation.
    hosted?: ServerToolHostedDispatch;
  };

export interface HostedToolRunner {
  readonly signal: AbortSignal;
  readonly run: <I, O>(pipeline: Pipeline<I, O, GatewayServices>, facts: NoInfer<I>) => Promise<O>;
  readonly abort: (key: object) => void;
}

export interface HostedToolInvocation {
  payload: CanonicalOpenAIResponsesPayload;
  readonly targetProtocol: NonNullable<ReturnType<typeof openAIResponsesTargetFor>>;
  readonly candidate: ServeCandidate;
}

export interface HostedToolContext {
  readonly auth: PipelineAuthFacts;
  readonly http: HttpRequestFact;
  readonly signal: AbortSignal;
}

export type ServerToolRegistration = (invocation: HostedToolInvocation, context: HostedToolContext) => ServerToolPrepareResult | Promise<ServerToolPrepareResult>;

type ActiveServerTool = Extract<ServerToolPrepareResult, { type: 'active' }> & {
  toolName: string;
  // Hosted entries are rewritten at their input-item positions; only
  // top-level replacements participate in response.tools restoration.
  canonicalHostedTool: OpenAIResponsesHostedTool | undefined;
  // Captures the exact forced choice shape before request rewriting.
  originalToolChoice: Exclude<OpenAIResponsesToolChoice, string> | undefined;
};

// How a single upstream turn ended, as observed while consuming its
// stream. Carries the raw upstream `response` for failed/incomplete so
// the loop can lift its error and usage. Error notifications remain separate
// from a response resource, including when no resource follows. Distinct from
// `SynthesizedTerminal`, which is the shim's own outgoing terminal.
export type UpstreamTerminal =
  | { kind: 'completed' }
  | { kind: 'failed'; response: OpenAIResponsesResultEx }
  | { kind: 'incomplete'; response: OpenAIResponsesResultEx }
  | { kind: 'error'; event: Extract<OpenAIResponsesStreamEventEx, { type: 'error' }> }
  | { kind: 'bare-error-pre-shell'; error: OpenAIResponsesErrorEx };

export interface TurnSummary {
  dispatchedSlots: DispatchedServerToolSlot[];
  sawServerToolCall: boolean;
  sawClientToolCall: boolean;
  turnUsage: MergeUsage;
  terminalStatus: UpstreamTerminal;
}

const { defineStage } = openAIResponsesFactSpace<GatewayServices>();

const MAX_RETAINED_HOSTED_TOOL_BYTES = 64 * 1024 * 1024;
const MAX_BUFFERED_HOSTED_TOOL_FRAMES = 1_000_000;
const utf8 = new TextEncoder();
const retainedSize = (value: unknown) => utf8.encode(JSON.stringify(value)).byteLength;

const retainOutput = (state: MergeState, index: number, item: OpenAIResponsesOutputItemEx): void => {
  const size = retainedSize(item);
  state.outputBytes += size - (state.outputSizes.get(index) ?? 0);
  if (state.outputBytes > MAX_RETAINED_HOSTED_TOOL_BYTES) throw new RangeError('OpenAI Responses hosted tool output exceeded 64 MiB');
  state.outputSizes.set(index, size);
  state.accumulatedOutput.set(index, item);
};

const createFrameBudget = () => {
  let bytes = 0;
  let frames = 0;
  return (value: unknown): void => {
    bytes += retainedSize(value);
    if (++frames > MAX_BUFFERED_HOSTED_TOOL_FRAMES || bytes > MAX_RETAINED_HOSTED_TOOL_BYTES) {
      throw new RangeError('OpenAI Responses hosted tool frame buffer exceeded its limit');
    }
  };
};

export const createMergeState = (): MergeState => ({
  sequenceNumber: 0,
  outputIndex: 0,
  accumulatedOutput: new Map(),
  outputSizes: new Map(),
  outputBytes: 0,
  accumulatedUsage: {},
  lastSeenModel: null,
  synthesizedResponseId: `resp_shim_${crypto.randomUUID().replace(/-/g, '')}`,
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

const rewriteHostedToolChoice = (
  toolChoice: OpenAIResponsesToolChoice | null,
  active: readonly ActiveServerTool[],
): OpenAIResponsesToolChoice | null => {
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

const hostedToolChoiceToRestore = (
  choice: OpenAIResponsesToolChoice | null | undefined,
  hosted: ServerToolHostedDispatch | undefined,
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

const isForcedServerToolChoice = (
  choice: OpenAIResponsesToolChoice | null | undefined,
  dispatchers: ReadonlyMap<string, ServerToolDispatcher>,
): boolean => {
  if (choice === 'required') return true;
  if (typeof choice !== 'object' || choice === null) return false;
  if (choice.type === 'function') return dispatchers.has(choice.name);
  if (choice.type !== 'allowed_tools' || choice.mode !== 'required' || !Array.isArray(choice.tools)) return false;
  return choice.tools.some(selector => selector?.type === 'function' && selector.namespace === undefined
    && typeof selector.name === 'string' && dispatchers.has(selector.name));
};

// The shim demotes forced choice to `auto` after the first turn, so synthesized
// echoes restore the captured client shape rather than the final upstream echo.
const restoreEchoedToolChoice = (
  toolChoice: OpenAIResponsesToolChoice | null | undefined,
  active: readonly ActiveServerTool[],
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
  active: readonly ActiveServerTool[],
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

export const resolveServerToolName = (
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
  throw new Error(`Unable to resolve a free server tool function name for ${baseName} within ${MAX_NAME_RESOLUTION_ATTEMPTS} attempts`);
};

const historicalClientCallableUsesName = (name: string, input: readonly CanonicalOpenAIResponsesInputItem[]): boolean =>
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
const rewriteToolsForHostedShim = (
  tools: readonly OpenAIResponsesTool[],
  hosted: ServerToolHostedDispatch,
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
    throw new Error('Hosted server-tool registration did not match any request tool');
  }
  rewritten[replacementIndex] = hosted.buildFunctionTool(canonicalHostedTool, toolName);
  return { rewritten, canonicalHostedTool };
};

const rewriteHostedDeclarations = (
  payload: CanonicalOpenAIResponsesPayload,
  hosted: ServerToolHostedDispatch,
  toolName: string,
): { payload: CanonicalOpenAIResponsesPayload; canonicalTopLevelHostedTool: OpenAIResponsesHostedTool | undefined } => {
  let canonicalHostedTool: OpenAIResponsesHostedTool | undefined;
  const rewrite = (tools: OpenAIResponsesTool[]): OpenAIResponsesTool[] => {
    if (!tools.some(tool => hosted.recognizeHostedTool(tool) !== undefined)) return tools;
    const result = rewriteToolsForHostedShim(tools, hosted, toolName);
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
    throw new Error('Hosted server-tool registration did not match any request tool');
  }
  return {
    payload: { ...payload, ...(tools === undefined ? {} : { tools }), input },
    canonicalTopLevelHostedTool,
  };
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

const syntheticPrologueResponse = (
  state: MergeState,
  id: string,
  model: string,
  active: readonly ActiveServerTool[],
  status: 'queued' | 'in_progress',
): OpenAIResponsesResultEx => {
  if (state.upstreamResponseSnapshot === undefined) {
    throw new Error('Server-tool shim cannot synthesize an OpenAI Responses prologue envelope before an upstream response snapshot is captured.');
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

const stampServerToolEvent = (
  merge: MergeState,
  outputIndex: number,
  itemId: string,
  event: ServerToolLifecycleEvent,
): ProtocolFrame<OpenAIResponsesStreamEventEx> =>
  eventFrame({
    ...event,
    output_index: outputIndex,
    item_id: itemId,
    sequence_number: merge.sequenceNumber++,
  } as OpenAIResponsesStreamEventEx);

const attachServerToolItemId = (item: ServerToolOutputItem, id: string): OpenAIResponsesOutputItemEx => ({ ...item, id } as OpenAIResponsesOutputItemEx);

const serverToolStartFrames = (
  merge: MergeState,
  outputIndex: number,
  slot: ServerToolResultSlot,
): ProtocolFrame<OpenAIResponsesStreamEventEx>[] => [
  eventFrame({
    type: 'response.output_item.added',
    output_index: outputIndex,
    item: attachServerToolItemId(slot.startItem, slot.id),
    sequence_number: merge.sequenceNumber++,
  } as OpenAIResponsesStreamEventEx),
  ...slot.startEvents.map(event => stampServerToolEvent(merge, outputIndex, slot.id, event)),
];

const serverToolEndFrames = (
  merge: MergeState,
  outputIndex: number,
  slot: ServerToolResultSlot,
  result: ServerToolSlotResult,
): ProtocolFrame<OpenAIResponsesStreamEventEx>[] => {
  const frames = [
    ...result.endEvents.map(event => stampServerToolEvent(merge, outputIndex, slot.id, event)),
    eventFrame({
      type: 'response.output_item.done',
      output_index: outputIndex,
      item: attachServerToolItemId(result.item, slot.id),
      sequence_number: merge.sequenceNumber++,
    } as OpenAIResponsesStreamEventEx),
  ];
  retainOutput(merge, outputIndex, attachServerToolItemId(result.item, slot.id));
  return frames;
};

const isCallBatchItem = (item: CanonicalOpenAIResponsesInputItem): boolean =>
  item.type === 'function_call' || item.type === 'custom_tool_call';

const expandServerToolHistory = async (
  items: CanonicalOpenAIResponsesInputItem[],
  active: readonly ActiveServerTool[],
  codec: SidecarCodec,
): Promise<CanonicalOpenAIResponsesInputItem[]> => {
  const result: CanonicalOpenAIResponsesInputItem[] = [];
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
      if (!isJsonObject(value) || value.v !== SERVER_TOOL_REPLAY_VERSION || typeof value.type !== 'string' || !isJsonObject(value.functionCall)
        || value.functionCall.type !== 'function_call' || typeof value.functionCall.call_id !== 'string'
        || typeof value.functionCall.name !== 'string' || typeof value.functionCall.arguments !== 'string') {
        throw new TypeError('Invalid hosted-tool replay data');
      }
      replays.push(value as unknown as OpenAIResponsesHostedToolCallPayload);
    }

    const feedback: CanonicalOpenAIResponsesInputItem[] = [];
    let carrierIndex = 0;
    for (const item of content) {
      const candidate = replays[carrierIndex];
      const replay = candidate?.type === item.type ? candidate : undefined;
      // A recognized replay owns its hosted item ordinal even when no active
      // tool claims the item. Otherwise a later hosted call would consume this
      // carrier and restore the wrong original call.
      if (candidate !== undefined && replay !== undefined) carrierIndex++;
      const toolReplay = replay === undefined ? undefined : { data: replay.data };
      let ownedExpansion: { toolName: string; expansion: ServerToolHistoryExpansion } | undefined;
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
  return result;
};

const deferHostedCallBatch = async function* (
  frames: AsyncIterable<ProtocolFrame<OpenAIResponsesStreamEventEx>>,
  dispatchers: ReadonlyMap<string, ServerToolDispatcher>,
): AsyncGenerator<ProtocolFrame<OpenAIResponsesStreamEventEx>> {
  let deferring = false;
  const buffer = createFrameBudget();
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
        buffer(frame);
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
  dispatchers: ReadonlyMap<string, ServerToolDispatcher>,
  loopState: ServerToolLoopState,
  active: readonly ActiveServerTool[],
  runner: HostedToolRunner,
): AsyncGenerator<ProtocolFrame<OpenAIResponsesStreamEventEx>, TurnSummary> {
  const dispatchedSlots: DispatchedServerToolSlot[] = [];
  const buffer = createFrameBudget();
  let sawServerToolCall = false;
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
      throw new Error('Server-tool shim cannot synthesize an OpenAI Responses envelope because upstream `response.created` did not report a `model` field.');
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
          throw new Error('Upstream changed a server-tool function identity before closing its call.');
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
          retainOutput(merge, downstreamIndex, doneItem);
          interceptedByUpstreamIndex.delete(upstreamIndex);
          continue;
        }
        const call: InterceptedFunctionCall = { functionCall: event.item, parsedArguments: parseServerToolArguments(event.item.arguments) };
        const slots = finalDispatcher({ intercepted: call, loopState, runner });
        sawServerToolCall = true;
        interceptedByUpstreamIndex.delete(upstreamIndex);
        if (loopState.remainingToolCalls !== undefined) loopState.remainingToolCalls -= 1;
        for (const [slotIndex, slot] of slots.entries()) {
          const carrierIndex = slotIndex === 0 ? intercepted.reservedOutputIndex : merge.outputIndex++;
          const outputIndex = merge.outputIndex++;
          const carrierId = createRandomOpenAIResponsesItemId('reasoning');
          dispatchedSlots.push({ intercepted: call, slot, outputIndex, carrierIndex, carrierId });
          yield stamp({ type: 'response.output_item.added', output_index: carrierIndex, item: { type: 'reasoning', id: carrierId, summary: [] } });
          yield* serverToolStartFrames(merge, outputIndex, slot);
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
      retainOutput(merge, downstreamIndex, doneItem);
      continue;
    }

    if (event.type === 'response.function_call_arguments.delta') {
      const intercepted = interceptedByUpstreamIndex.get(event.output_index);
      if (intercepted !== undefined) {
        buffer(event);
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
        buffer(event);
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
      buffer(event);
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
        retainOutput(merge, maybeItemEvent.output_index, maybeItemEvent.item as Parameters<MergeState['accumulatedOutput']['set']>[1]);
      }
      yield stamp(rewriteResult);
      continue;
    }

    // Preserve positionless events and unknown types admitted by
    // parseOpenAIResponsesStream so the shim retains the parser's pass-through contract.
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
          message: `Upstream emitted ${priorLabel} without closing shim call items at upstream output_index ${unmatched.join(', ')}.`,
          code: 'server_error',
        },
        incomplete_details: null,
      },
    };
  }

  return { dispatchedSlots, sawServerToolCall, sawClientToolCall, turnUsage, terminalStatus };
};

const responseErrorFromEvent = (
  event: Extract<OpenAIResponsesStreamEventEx, { type: 'error' }>,
): OpenAIResponsesErrorEx | null => {
  const { type: _type, sequence_number: _sequenceNumber, ...fields } = event;
  const payload = ('error' in fields && isJsonObject(fields.error) ? fields.error : fields) as OpenAIResponsesErrorPayload;
  return typeof payload.code === 'string' ? { ...payload, code: payload.code, message: payload.message } : null;
};

// The terminal the shim emits downstream. Unlike `UpstreamTerminal`
// (what we observed), this carries only the already-extracted `error` /
// `incompleteDetails` the synthesized envelope needs; the output and
// usage come from accumulated shim state. There is no pre-shell variant
// here — synthesis always runs after a model is known.
type SynthesizedTerminal =
  | { kind: 'completed' }
  | { kind: 'failed'; error: OpenAIResponsesResultEx['error'] }
  | { kind: 'incomplete'; incompleteDetails: OpenAIResponsesResultEx['incomplete_details'] };

const SYNTHESIZED_TERMINAL_FRAME: Record<SynthesizedTerminal['kind'], { type: 'response.completed' | 'response.failed' | 'response.incomplete'; status: OpenAIResponsesResultEx['status'] }> = {
  completed: { type: 'response.completed', status: 'completed' },
  failed: { type: 'response.failed', status: 'failed' },
  incomplete: { type: 'response.incomplete', status: 'incomplete' },
};

const synthesizeTerminalEnvelope = (
  state: MergeState,
  kind: SynthesizedTerminal,
  active: readonly ActiveServerTool[],
): ProtocolFrame<OpenAIResponsesStreamEventEx> => {
  if (state.lastSeenModel === null) {
    throw new Error('Server-tool shim cannot synthesize an OpenAI Responses terminal envelope before upstream `response.created` reports a model.');
  }
  if (state.upstreamResponseSnapshot === undefined) {
    throw new Error('Server-tool shim cannot synthesize an OpenAI Responses terminal envelope before upstream `response.created` is captured.');
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

async function* materializeServerToolItems(
  dispatchedSlots: readonly DispatchedServerToolSlot[],
  merge: MergeState,
  codec: SidecarCodec,
): AsyncGenerator<ProtocolFrame<OpenAIResponsesStreamEventEx>, void> {
  for (const { intercepted, slot, outputIndex, carrierIndex, carrierId } of dispatchedSlots) {
    const lifecycle = slot.run();
    let step = await lifecycle.next();
    while (!step.done) {
      yield stampServerToolEvent(merge, outputIndex, slot.id, step.value);
      step = await lifecycle.next();
    }
    const replayItem: OpenAIResponsesOutputItemEx = {
      type: 'reasoning', id: carrierId, summary: [],
      encrypted_content: await codec.encode({
        v: SERVER_TOOL_REPLAY_VERSION,
        type: step.value.item.type,
        functionCall: intercepted.functionCall,
        ...(step.value.replayData === undefined ? {} : { data: step.value.replayData }),
      }),
    };
    retainOutput(merge, carrierIndex, replayItem);
    yield eventFrame({ type: 'response.output_item.done', output_index: carrierIndex, item: replayItem, sequence_number: merge.sequenceNumber++ });
    yield* serverToolEndFrames(merge, outputIndex, slot, step.value);
  }
}

const hostedToolRegistrations = [registerWebSearch, registerImageGeneration] as const;

export const hostOpenAIResponsesTools = defineStage({
  name: 'openaiResponses.hosted-tools',
  through: {
    request: {
      needs: ['request.http', 'request.openaiResponses', 'request.auth.apiKeyId', 'request.auth.user', 'request.auth.upstreamIds', 'request.auth.randomizeUpstreams', 'serve.candidate'],
      provides: ['request.openaiResponses'],
      consumes: [],
    },
    response: { needs: openAIResponsesExit, provides: ['response.openaiResponses'], consumes: [] },
  },
  return: { provides: openAIResponsesExit },
  async execute(facts, scope) {
    const candidate = facts['serve.candidate'];
    const targetProtocol = openAIResponsesTargetFor(candidate);
    if (targetProtocol === undefined) throw new TypeError('OpenAI Responses hosted tools require a selected target');
    const invocation: HostedToolInvocation = { payload: facts['request.openaiResponses'], candidate, targetProtocol };
    const context: HostedToolContext = {
      auth: {
        'request.auth.apiKeyId': facts['request.auth.apiKeyId'],
        'request.auth.user': facts['request.auth.user'],
        'request.auth.upstreamIds': facts['request.auth.upstreamIds'],
        'request.auth.randomizeUpstreams': facts['request.auth.randomizeUpstreams'],
      },
      http: facts['request.http'],
      signal: scope.signal,
    };
    const active: ActiveServerTool[] = [];
    const preparedTools: Array<Extract<ServerToolPrepareResult, { type: 'active' }>> = [];

    // Validate the original request before any hosted rewrite changes the
    // tool-array indexes used in error paths.
    for (const prepareServerTool of hostedToolRegistrations) {
      const prepared = await prepareServerTool(invocation, context);
      if (prepared.type === 'inactive') continue;
      if (prepared.type === 'invalid-request') {
        return openAIResponsesError(400, {
          error: {
            message: prepared.message,
            param: prepared.param,
            code: prepared.code === undefined ? 'invalid_request_error' : prepared.code,
            type: prepared.errorType ?? 'invalid_request_error',
          },
        });
      }
      preparedTools.push(prepared);
    }

    for (const prepared of preparedTools) {
      const currentTools = Array.isArray(invocation.payload.tools) ? invocation.payload.tools : [];
      const toolName = resolveServerToolName(prepared.baseToolName, currentTools, invocation.payload.input, invocation.payload.tool_choice);
      const { hosted } = prepared;
      const choice = invocation.payload.tool_choice;
      let helperFunctionChoice: { original: Exclude<OpenAIResponsesToolChoice, string>; rewritten: Exclude<OpenAIResponsesToolChoice, string> } | undefined;
      if (hosted !== undefined && toolName !== prepared.baseToolName
        && typeof choice === 'object' && choice !== null) {
        // Forced and allowed-tools selectors share the same ownership rule. A
        // bare helper spelling may be rebased only when no client owns it.
        const clientOwnsName = currentTools.some(tool =>
          (tool.type === 'function' || tool.type === 'custom') && tool.name === prepared.baseToolName
          && (!('namespace' in tool) || tool.namespace === undefined))
          || historicalClientCallableUsesName(prepared.baseToolName, invocation.payload.input);
        if (!clientOwnsName) {
          const rebaseSelector = <T>(selector: T): T => {
            if (typeof selector !== 'object' || selector === null || !('type' in selector) || selector.type !== 'function'
              || !('name' in selector) || selector.name !== prepared.baseToolName
              || ('namespace' in selector && selector.namespace !== undefined)) return selector;
            return { ...selector, name: toolName };
          };
          let rewritten = choice;
          if (choice.type === 'allowed_tools' && Array.isArray(choice.tools)) {
            const tools = choice.tools.map(rebaseSelector);
            if (tools.some((tool, index) => tool !== choice.tools[index])) rewritten = { ...choice, tools };
          } else rewritten = rebaseSelector(choice);
          if (rewritten !== choice) helperFunctionChoice = { original: choice, rewritten };
        }
      }
      let canonicalHostedTool: OpenAIResponsesHostedTool | undefined = undefined;
      if (hosted !== undefined) {
        const rewrite = rewriteHostedDeclarations(invocation.payload, hosted, toolName);
        canonicalHostedTool = rewrite.canonicalTopLevelHostedTool;
        invocation.payload = rewrite.payload;
      }
      const originalToolChoice = helperFunctionChoice?.original ?? hostedToolChoiceToRestore(choice, hosted, toolName);
      if (helperFunctionChoice !== undefined) {
        invocation.payload = { ...invocation.payload, tool_choice: helperFunctionChoice.rewritten };
      }
      active.push({ ...prepared, toolName, canonicalHostedTool, originalToolChoice });
    }

    if (invocation.payload.tool_choice !== undefined) {
      const rewrittenToolChoice = rewriteHostedToolChoice(invocation.payload.tool_choice, active);
      if (rewrittenToolChoice !== invocation.payload.tool_choice) invocation.payload = { ...invocation.payload, tool_choice: rewrittenToolChoice };
    }

    const canonicalInput = invocation.payload.input;
    const replayCodec = scope.services.sidecarCodecFactory.codecFor(SidecarDomain.OpenAIResponsesHostedToolCall);
    const input = await expandServerToolHistory(canonicalInput, active, replayCodec);
    invocation.payload = { ...invocation.payload, input };
    const dispatchers = new Map<string, ServerToolDispatcher>();
    for (const entry of active) if (entry.hosted !== undefined) dispatchers.set(entry.toolName, entry.hosted.dispatcher);

    const requestFacts = () => ({ ...facts, 'request.openaiResponses': move(invocation.payload) });
    const firstCall = scope.next(requestFacts());
    const first = await firstCall;
    const outcome = first['response.openaiResponses'];
    if (outcome.kind !== 'stream' || dispatchers.size === 0) return first;

    const merge = createMergeState();
    const loopState: ServerToolLoopState = {
      iterationCount: 1,
      remainingToolCalls: typeof invocation.payload.max_tool_calls === 'number' ? invocation.payload.max_tool_calls : undefined,
    };
    const demoteChoice = isForcedServerToolChoice(invocation.payload.tool_choice, dispatchers);
    const stream = scope.wrapStream<OpenAIResponsesStreamEventEx, ProtocolStreamError, OpenAIResponsesStreamEventEx, ProtocolStreamError>(outcome.stream, async function* (items, producer) {
      const firstSource = readProtocolFrames(items);
      const consumeTurn = async function* (
        source: ReturnType<typeof readProtocolFrames<OpenAIResponsesStreamEventEx>>,
        isFirstTurn: boolean,
        abort: () => void,
      ) {
        try {
          return yield* consumeTurnStreaming(source.frames(), merge, isFirstTurn, dispatchers, loopState, active, producer);
        } finally {
          if (!source.done) abort();
          await source.drain();
        }
      };
      try {
        const events = runHostedToolTurns({
          invocation,
          merge,
          loopState,
          active,
          replayCodec,
          canonicalInput,
          demoteChoice,
          firstTurn: consumeTurn(firstSource, true, () => { producer.abort(firstCall); }),
          signal: producer.signal,
          async *nextTurn() {
            const call = producer.next(requestFacts());
            const next = await call;
            const result = next['response.openaiResponses'];
            if (result.kind === 'error') return result;
            if (result.kind === 'result') throw new TypeError('A hosted tool continuation requires a generation stream');
            return yield* consumeTurn(readProtocolFrames(result.stream), false, () => { producer.abort(call); });
          },
        });
        for await (const frame of events) if (frame.type === 'event') yield { ok: true, value: frame.event };
      } catch (cause) {
        if (!producer.signal.aborted) {
          const failure = firstSource.failure;
          yield { ok: false, error: failure !== undefined && cause === failure ? failure : { kind: 'protocol', cause } };
        }
      }
      if (!firstSource.done) {
        producer.abort(firstCall);
        await firstSource.drain();
      }
    });
    return { ...first, 'response.openaiResponses': move({ kind: 'stream', stream } as const) };
  },
});

type ResponsesFrame = ProtocolFrame<OpenAIResponsesStreamEventEx>;

const runHostedToolTurns = async function* ({
  invocation, merge, loopState, active, replayCodec, canonicalInput, demoteChoice, firstTurn, nextTurn, signal,
}: {
  readonly invocation: HostedToolInvocation;
  readonly merge: MergeState;
  readonly loopState: ServerToolLoopState;
  readonly active: readonly ActiveServerTool[];
  readonly replayCodec: SidecarCodec;
  readonly canonicalInput: CanonicalOpenAIResponsesInputItem[];
  readonly demoteChoice: boolean;
  readonly firstTurn: AsyncGenerator<ResponsesFrame, TurnSummary>;
  readonly nextTurn: () => AsyncGenerator<ResponsesFrame, TurnSummary | ProtocolError>;
  readonly signal: AbortSignal;
}): AsyncGenerator<ResponsesFrame> {
  try {
    let turn = yield* firstTurn;
    while (!signal.aborted) {
      merge.accumulatedUsage = sumUsage(merge.accumulatedUsage, turn.turnUsage);
      const terminal = turn.terminalStatus;
      if (turn.sawServerToolCall) yield* materializeServerToolItems(turn.dispatchedSlots, merge, replayCodec);
      if (signal.aborted) return;

      switch (terminal.kind) {
      case 'failed':
        yield synthesizeTerminalEnvelope(merge, { kind: 'failed', error: terminal.response.error }, active);
        return;
      case 'incomplete':
        yield synthesizeTerminalEnvelope(merge, { kind: 'incomplete', incompleteDetails: terminal.response.incomplete_details }, active);
        return;
      case 'error':
        return;
      case 'bare-error-pre-shell':
        yield synthesizeTerminalEnvelope(merge, { kind: 'failed', error: terminal.error }, active);
        return;
      case 'completed':
        if (!turn.sawServerToolCall || turn.sawClientToolCall) {
          yield synthesizeTerminalEnvelope(merge, { kind: 'completed' }, active);
          return;
        }
      }

      const input = await expandServerToolHistory([
        ...canonicalInput,
        ...materializeAccumulatedOutput(merge) as CanonicalOpenAIResponsesInputItem[],
      ], active, replayCodec);
      const { max_tool_calls: _previousBudget, ...previous } = invocation.payload;
      const choice = previous.tool_choice;
      invocation.payload = {
        ...previous,
        input,
        ...(loopState.remainingToolCalls !== undefined && { max_tool_calls: Math.max(0, loopState.remainingToolCalls) }),
        ...(demoteChoice && {
          tool_choice: typeof choice === 'object' && choice?.type === 'allowed_tools' ? { ...choice, mode: 'auto' } : 'auto',
        }),
      };
      loopState.iterationCount++;
      const next = yield* nextTurn();
      if ('sawServerToolCall' in next) {
        turn = next;
        continue;
      }

      const event = { ...errorEvent(next), sequence_number: merge.sequenceNumber++ };
      yield eventFrame(event);
      yield synthesizeTerminalEnvelope(merge, { kind: 'failed', error: responseErrorFromEvent(event) }, active);
      return;
    }
  } catch (cause) {
    if (signal.aborted) return;
    if (merge.lastSeenModel === null) throw cause;
    const debug = toInternalDebugError(cause);
    const event = {
      type: 'error' as const,
      code: 'server_error',
      message: `Upstream stream failed mid-response: ${debug.message}`,
      param: null,
      provider_specific_fields: internalDebugErrorFields(debug),
      sequence_number: merge.sequenceNumber++,
    };
    yield eventFrame(event);
    yield synthesizeTerminalEnvelope(merge, { kind: 'failed', error: responseErrorFromEvent(event) }, active);
  }
};

const errorEvent = ({ error, cause }: ProtocolError): Extract<OpenAIResponsesStreamEventEx, { type: 'error' }> => {
  if (isJsonObject(error)) {
    if (isJsonObject(error.error) && typeof error.error.message === 'string') {
      return { type: 'error', error: { ...error.error, message: error.error.message } };
    }
    if (typeof error.message === 'string') return { ...error, type: 'error', message: error.message };
  }
  const debug = toInternalDebugError(cause ?? error);
  return { type: 'error', code: 'server_error', message: debug.message, param: null, provider_specific_fields: internalDebugErrorFields(debug) };
};
