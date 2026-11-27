import { jsonrepair } from 'jsonrepair';

import { imageGenerationServerTool } from './hosted-tools/image-generation.ts';
import { openAIResponsesFailureEvents, openAIResponsesProtocolError } from './hosted-tools/stream-error.ts';
import { webSearchServerTool } from './hosted-tools/web-search.ts';
import type { GatewayServices } from '../../../pipeline/services.ts';
import { defineStage, type ChatRequestFacts } from '../../pipeline/facts.ts';
import { SidecarDomain } from '../../shared/sidecar-codec.ts';
import type { HttpRequestFact, HttpResponseFact } from '@floway-dev/http';
import type { Entry, Facts, ManagedStream, Result } from '@floway-dev/pipeline';
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
import type { SidecarCodec } from '@floway-dev/translate';
import type { ProtocolError, ProtocolStreamError } from '@floway-dev/upstream';

const hostedRequest = ['http', 'openaiResponses', 'model', 'chat.target'] as const;
type HostedToolRequest = Pick<ChatRequestFacts, typeof hostedRequest[number]>;

type HostedToolPreparation = { signal: AbortSignal; services: Readonly<GatewayServices> };

interface HostedToolScope extends HostedToolPreparation {
  abort(call: Promise<unknown>): void;
  run<Input, Output>(entry: Entry<Input, Output, GatewayServices>, facts: NoInfer<Input>): Promise<Output>;
  read<Event, Error>(source: ManagedStream<Event, Error>): AsyncIterableIterator<Result<Event, Error>>;
  discard(source: ManagedStream<unknown, unknown> | Facts): void;
}

export interface HostedToolContext {
  facts: HostedToolRequest;
  scope: HostedToolScope;
}

export const hostedToolRequest = (facts: Pick<HostedToolRequest, 'http'>, pathname: string): {
  http: HttpRequestFact;
  'serve.startedAt': number;
} => ({
  http: { method: 'POST', url: new URL(pathname, facts.http.url).href, headers: [], body: null },
  'serve.startedAt': Date.now(),
});

export const isHostedScalarAbort = (outcome: ProtocolError, http: HttpResponseFact | null, signal: AbortSignal): boolean =>
  signal.aborted && outcome.source === 'local' && (http === null || http.startedAt !== undefined);

const MAX_HOSTED_TOOL_BUFFER_BYTES = 64 * 1024 * 1024;
const encoder = new TextEncoder();
const retainedBytesOf = (value: unknown): number => encoder.encode(JSON.stringify(value)).byteLength;

const createHostedBufferBudget = () => {
  let retainedBytes = 0;
  return {
    retain(value: unknown): number {
      const bytes = retainedBytesOf(value);
      if (retainedBytes + bytes > MAX_HOSTED_TOOL_BUFFER_BYTES) {
        throw new RangeError(`OpenAI Responses hosted tool buffer exceeds the ${MAX_HOSTED_TOOL_BUFFER_BYTES}-byte limit`);
      }
      retainedBytes += bytes;
      return bytes;
    },
    release(bytes: number): void {
      retainedBytes -= bytes;
    },
  };
};

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

export type HostedToolFailure = ProtocolError | { kind: 'abort'; cause: unknown };

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
  run: () => AsyncGenerator<ServerToolLifecycleEvent, ServerToolSlotResult | { failure: HostedToolFailure }>;
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
  release(): void;
}

export type ServerToolDispatcher = (args: {
  intercepted: InterceptedFunctionCall;
  loopState: ServerToolLoopState;
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
  dispatcher: (args: Parameters<ServerToolDispatcher>[0], context: HostedToolContext) => ServerToolResultSlot[];
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

export type ServerToolRegistration = (
  facts: Pick<HostedToolRequest, 'openaiResponses' | 'model' | 'chat.target'>,
  scope: HostedToolPreparation,
) => ServerToolPrepareResult | Promise<ServerToolPrepareResult>;

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

export const createMergeState = (): MergeState => ({
  sequenceNumber: 0,
  outputIndex: 0,
  accumulatedOutput: new Map(),
  outputBytes: 0,
  accumulatedUsage: {},
  lastSeenModel: null,
  synthesizedResponseId: `resp_shim_${crypto.randomUUID().replace(/-/g, '')}`,
  upstreamResponseSnapshot: undefined,
});

const recordOutput = (state: MergeState, index: number, item: OpenAIResponsesOutputItemEx): void => {
  const previous = state.accumulatedOutput.get(index);
  const bytes = retainedBytesOf(item);
  state.outputBytes += bytes - (previous === undefined ? 0 : retainedBytesOf(previous));
  if (state.outputBytes > MAX_HOSTED_TOOL_BUFFER_BYTES) {
    throw new RangeError(`OpenAI Responses hosted tool history exceeds the ${MAX_HOSTED_TOOL_BUFFER_BYTES}-byte limit`);
  }
  state.accumulatedOutput.set(index, item);
};

const recordSnapshot = (state: MergeState, response: OpenAIResponsesResultEx): void => {
  const snapshot = { ...response, output: [] };
  if (retainedBytesOf(snapshot) > MAX_HOSTED_TOOL_BUFFER_BYTES) {
    throw new RangeError(`OpenAI Responses hosted tool response metadata exceeds the ${MAX_HOSTED_TOOL_BUFFER_BYTES}-byte limit`);
  }
  state.upstreamResponseSnapshot = snapshot;
};

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
  dispatchers: ReadonlyMap<string, unknown>,
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
    recordSnapshot(merge, event.response);
    return { status: { kind: 'completed' }, usage: usageOf(event.response.usage) };
  }
  if (event.type === 'response.failed') {
    if (merge.lastSeenModel === null && typeof event.response.model === 'string' && event.response.model.length > 0) merge.lastSeenModel = event.response.model;
    recordSnapshot(merge, event.response);
    return { status: { kind: 'failed', response: event.response }, usage: usageOf(event.response.usage) };
  }
  if (event.type === 'response.incomplete') {
    if (merge.lastSeenModel === null && typeof event.response.model === 'string' && event.response.model.length > 0) merge.lastSeenModel = event.response.model;
    recordSnapshot(merge, event.response);
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
  recordOutput(merge, outputIndex, attachServerToolItemId(result.item, slot.id));
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
  budget: ReturnType<typeof createHostedBufferBudget>,
): AsyncGenerator<ProtocolFrame<OpenAIResponsesStreamEventEx>> {
  let deferring = false;
  const deferredIndexes = new Set<number>();
  const pending = new Map<number, Array<{ frame: ProtocolFrame<OpenAIResponsesStreamEventEx>; bytes: number } | undefined>>();
  const flush = function* () {
    for (const [index, batch] of pending) {
      pending.delete(index);
      for (let offset = 0; offset < batch.length; offset++) {
        const { frame, bytes } = batch[offset]!;
        batch[offset] = undefined;
        budget.release(bytes);
        yield frame;
      }
    }
  };
  // A hosted item combines a call and its result. Keep subsequent assistant
  // content ahead of that result, while preserving order inside the call batch.
  // Otherwise echoing the public output loses the assistant/tool boundaries.
  for await (const frame of frames) {
    if (frame.type === 'done' || isOpenAIResponsesTerminalEvent(frame.event) || frame.event.type === 'error') {
      yield* flush();
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
      batch.push({ frame, bytes: budget.retain(event) });
      pending.set(event.output_index, batch);
    } else yield frame;
  }
  yield* flush();
};

export const consumeTurnStreaming = async function* (
  frames: AsyncIterable<ProtocolFrame<OpenAIResponsesStreamEventEx>>,
  merge: MergeState,
  isFirstTurn: boolean,
  dispatchers: ReadonlyMap<string, ServerToolDispatcher>,
  loopState: ServerToolLoopState,
  active: readonly ActiveServerTool[],
): AsyncGenerator<ProtocolFrame<OpenAIResponsesStreamEventEx>, TurnSummary> {
  const dispatchedSlots: DispatchedServerToolSlot[] = [];
  let sawServerToolCall = false;
  let sawClientToolCall = false;
  let turnUsage: MergeUsage = {};
  let terminalStatus: UpstreamTerminal | undefined = undefined;
  let errorEvent: Extract<OpenAIResponsesStreamEventEx, { type: 'error' }> | undefined;

  const openItems = new Map<number, number>();
  const openItemIds = new Map<number, string>();
  const budget = createHostedBufferBudget();
  const interceptedByUpstreamIndex = new Map<number, {
    addedItem: OpenAIResponsesOutputFunctionCallEx;
    reservedOutputIndex: number;
    bufferedEvents: OpenAIResponsesStreamEventEx[];
    retainedBytes: number;
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

  for await (const frame of deferHostedCallBatch(frames, dispatchers, budget)) {
    if (frame.type !== 'event') {
      yield frame;
      continue;
    }
    const event = frame.event;

    if (event.type === 'response.queued' || event.type === 'response.created') {
      const reportedModel = event.response.model;
      if (typeof reportedModel === 'string' && reportedModel.length > 0) merge.lastSeenModel = reportedModel;
      recordSnapshot(merge, event.response);
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
            retainedBytes: budget.retain(item),
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
        interceptedByUpstreamIndex.delete(upstreamIndex);
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
          recordOutput(merge, downstreamIndex, doneItem);
          budget.release(intercepted.retainedBytes);
          continue;
        }
        const rawBytes = budget.retain(event.item);
        const call: InterceptedFunctionCall = { functionCall: event.item, parsedArguments: parseServerToolArguments(event.item.arguments) };
        const callBytes = rawBytes + budget.retain(call.parsedArguments);
        intercepted.bufferedEvents.length = 0;
        budget.release(intercepted.retainedBytes);
        const slots = finalDispatcher({ intercepted: call, loopState });
        let remainingSlots = slots.length;
        if (remainingSlots === 0) budget.release(callBytes);
        sawServerToolCall = true;
        if (loopState.remainingToolCalls !== undefined) loopState.remainingToolCalls -= 1;
        for (const [slotIndex, slot] of slots.entries()) {
          const carrierIndex = slotIndex === 0 ? intercepted.reservedOutputIndex : merge.outputIndex++;
          const outputIndex = merge.outputIndex++;
          const carrierId = createRandomOpenAIResponsesItemId('reasoning');
          const slotBytes = budget.retain({ id: slot.id, startItem: slot.startItem, startEvents: slot.startEvents, outputIndex, carrierIndex, carrierId });
          const release = (): void => {
            budget.release(slotBytes);
            if (--remainingSlots === 0) budget.release(callBytes);
          };
          dispatchedSlots.push({ intercepted: call, slot, outputIndex, carrierIndex, carrierId, release });
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
      recordOutput(merge, downstreamIndex, doneItem);
      continue;
    }

    if (event.type === 'response.function_call_arguments.delta') {
      const intercepted = interceptedByUpstreamIndex.get(event.output_index);
      if (intercepted !== undefined) {
        intercepted.retainedBytes += budget.retain(event);
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
        intercepted.retainedBytes += budget.retain(event);
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
      pending.retainedBytes += budget.retain(event);
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
        recordOutput(merge, maybeItemEvent.output_index, maybeItemEvent.item as OpenAIResponsesOutputItemEx);
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
  dispatchedSlots: DispatchedServerToolSlot[],
  merge: MergeState,
  codec: SidecarCodec,
): AsyncGenerator<ResponsesStreamItem, HostedToolFailure | undefined> {
  dispatchedSlots.reverse();
  try {
    while (dispatchedSlots.length > 0) {
      const { intercepted, slot, outputIndex, carrierIndex, carrierId, release } = dispatchedSlots.pop()!;
      try {
        const lifecycle = slot.run();
        let step = await lifecycle.next();
        while (!step.done) {
          yield* onlyEvents([stampServerToolEvent(merge, outputIndex, slot.id, step.value)]);
          step = await lifecycle.next();
        }
        if ('failure' in step.value) return step.value.failure;
        const replayItem: OpenAIResponsesOutputItemEx = {
          type: 'reasoning', id: carrierId, summary: [],
          encrypted_content: await codec.encode({
            v: SERVER_TOOL_REPLAY_VERSION,
            type: step.value.item.type,
            functionCall: intercepted.functionCall,
            ...(step.value.replayData === undefined ? {} : { data: step.value.replayData }),
          }),
        };
        recordOutput(merge, carrierIndex, replayItem);
        yield { ok: true, value: { type: 'response.output_item.done', output_index: carrierIndex, item: replayItem, sequence_number: merge.sequenceNumber++ } };
        yield* onlyEvents(serverToolEndFrames(merge, outputIndex, slot, step.value));
      } finally {
        release();
      }
    }
  } finally {
    for (const slot of dispatchedSlots) slot.release();
    dispatchedSlots.length = 0;
  }
}

type ResponsesStream = ManagedStream<OpenAIResponsesStreamEventEx, ProtocolStreamError>;
type ResponsesStreamItem = Result<OpenAIResponsesStreamEventEx, ProtocolStreamError>;

const consumeHostedTurn = async function* (
  source: ResponsesStream,
  context: HostedToolContext,
  merge: MergeState,
  firstTurn: boolean,
  hosted: ReadonlyMap<string, ServerToolHostedDispatch['dispatcher']>,
  loop: ServerToolLoopState,
  active: readonly ActiveServerTool[],
): AsyncGenerator<ResponsesStreamItem, { turn: TurnSummary; failure?: ProtocolStreamError }> {
  let failure: ProtocolStreamError | undefined;
  const { scope } = context;
  const frames = async function* () {
    for await (const item of scope.read(source)) {
      if (item.ok) {
        yield eventFrame(item.value);
        continue;
      }

      if (firstTurn) scope.discard(source);
      failure = item.error;
      const { failed } = openAIResponsesFailureEvents(item.error);
      if (failed) yield eventFrame(failed);
      return;
    }
  };

  const dispatchers = new Map<string, ServerToolDispatcher>();
  for (const [name, dispatch] of hosted) dispatchers.set(name, args => dispatch(args, context));
  const events = consumeTurnStreaming(frames(), merge, firstTurn, dispatchers, loop, active);
  for (;;) {
    const next = await events.next();
    if (next.done) return { turn: next.value, ...(failure === undefined ? {} : { failure }) };
    if (next.value.type === 'event' && next.value.event.type !== 'error') yield { ok: true, value: next.value.event };
  }
};

const onlyEvents = function* (frames: Iterable<ProtocolFrame<OpenAIResponsesStreamEventEx>>): Generator<ResponsesStreamItem> {
  for (const frame of frames) {
    if (frame.type === 'event') yield { ok: true, value: frame.event };
  }
};

const failedResource = (state: MergeState, active: readonly ActiveServerTool[], error: OpenAIResponsesResultEx['error']) => {
  if (state.lastSeenModel === null || state.upstreamResponseSnapshot === undefined) return undefined;
  const frame = synthesizeTerminalEnvelope(state, { kind: 'failed', error }, active);
  if (frame.type !== 'event' || frame.event.type !== 'response.failed') throw new TypeError('Expected a failed Responses resource');
  return frame.event;
};

const hostedScalarFailure = (outcome: ProtocolError, state: MergeState, active: readonly ActiveServerTool[]): ProtocolStreamError => {
  const body = isJsonObject(outcome.error) ? outcome.error : {};
  const error = isJsonObject(body.error) ? body.error : body;
  const message = typeof error.message === 'string' ? error.message
    : typeof outcome.error === 'string' ? outcome.error : 'OpenAI Responses hosted tool continuation failed';
  const code = typeof error.code === 'string' ? error.code : 'server_error';
  const details = { ...error, message, code };
  const notification = {
    ...(isJsonObject(outcome.error) ? body : details),
    type: 'error' as const,
    sequence_number: state.sequenceNumber++,
  } as Extract<OpenAIResponsesStreamEventEx, { type: 'error' }>;
  const failed = failedResource(state, active, responseErrorFromEvent(notification));
  return openAIResponsesProtocolError(new Error(message, { cause: outcome.error }), { notification, ...(failed ? { failed } : {}) });
};

export const prepareOpenAIResponsesHostedTools = async (
  facts: Pick<HostedToolRequest, 'openaiResponses' | 'model' | 'chat.target'>,
  scope: HostedToolPreparation,
) => {
  const registrations = [webSearchServerTool, imageGenerationServerTool];
  const active: ActiveServerTool[] = [];
  const preparedTools: Array<Extract<ServerToolPrepareResult, { type: 'active' }>> = [];
  let payload = facts['openaiResponses'];
  for (const prepare of registrations) {
    const prepared = await prepare(facts, scope);
    if (prepared.type === 'inactive') continue;
    if (prepared.type === 'invalid-request') {
      const error = {
        error: {
          message: prepared.message,
          type: prepared.errorType ?? 'invalid_request_error',
          param: prepared.param,
          code: prepared.code === undefined ? 'invalid_request_error' : prepared.code,
        },
      };
      const http: HttpResponseFact = { status: 400, statusText: '', headers: [['content-type', 'application/json']], body: null };
      const outcome: ProtocolError = { kind: 'error', source: 'local', error };
      return { kind: 'error' as const, http, outcome };
    }
    preparedTools.push(prepared);
  }
  if (preparedTools.length === 0) return { kind: 'unchanged' as const };

  for (const prepared of preparedTools) {
    const currentTools = Array.isArray(payload.tools) ? payload.tools : [];
    const toolName = resolveServerToolName(prepared.baseToolName, currentTools, payload.input, payload.tool_choice);
    const { hosted } = prepared;
    const choice = payload.tool_choice;
    let helperFunctionChoice: { original: Exclude<OpenAIResponsesToolChoice, string>; rewritten: Exclude<OpenAIResponsesToolChoice, string> } | undefined;
    if (hosted !== undefined && toolName !== prepared.baseToolName
      && typeof choice === 'object' && choice !== null) {
      // Forced and allowed-tools selectors share the same ownership rule. A
      // bare helper spelling may be rebased only when no client owns it.
      const clientOwnsName = currentTools.some(tool =>
        (tool.type === 'function' || tool.type === 'custom') && tool.name === prepared.baseToolName
        && (!('namespace' in tool) || tool.namespace === undefined))
        || historicalClientCallableUsesName(prepared.baseToolName, payload.input);
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
      const rewrite = rewriteHostedDeclarations(payload, hosted, toolName);
      canonicalHostedTool = rewrite.canonicalTopLevelHostedTool;
      payload = rewrite.payload;
    }
    const originalToolChoice = helperFunctionChoice?.original ?? hostedToolChoiceToRestore(choice, hosted, toolName);
    if (helperFunctionChoice !== undefined) {
      payload = { ...payload, tool_choice: helperFunctionChoice.rewritten };
    }
    active.push({ ...prepared, toolName, canonicalHostedTool, originalToolChoice });
  }

  if (payload.tool_choice !== undefined) {
    const rewrittenToolChoice = rewriteHostedToolChoice(payload.tool_choice, active);
    if (rewrittenToolChoice !== payload.tool_choice) payload = { ...payload, tool_choice: rewrittenToolChoice };
  }

  const canonicalInput = payload.input;
  const replayCodec = scope.services.sidecarCodec.codecFor(SidecarDomain.OpenAIResponsesHostedToolCall);
  const nextInput = await expandServerToolHistory(canonicalInput, active, replayCodec);
  const request = nextInput === canonicalInput ? payload : { ...payload, input: nextInput };
  return { kind: 'prepared' as const, request, canonicalInput, replayCodec, active };
};

export const openAIResponsesHostedTools = defineStage({
  name: 'openaiResponses.hosted-tools',
  through: {
    request: { needs: hostedRequest, provides: ['openaiResponses'], consumes: [] },
    response: {
      needs: ['http', 'openaiResponses', 'usage?', 'usageModelKey?'],
      provides: ['openaiResponses'],
      consumes: [],
    },
  },
  return: { provides: ['http', 'openaiResponses'] },
  async execute(facts, scope) {
    const prepared = await prepareOpenAIResponsesHostedTools(facts, scope);
    if (prepared.kind === 'error') return { 'http': prepared.http, 'openaiResponses': prepared.outcome };
    if (prepared.kind === 'unchanged') return await scope.next(facts);
    const { request, canonicalInput, replayCodec, active } = prepared;

    const hosted = new Map<string, ServerToolHostedDispatch['dispatcher']>();
    for (const entry of active) {
      if (entry.hosted !== undefined) hosted.set(entry.toolName, entry.hosted.dispatcher);
    }
    const first = await scope.next({ ...facts, 'openaiResponses': request });
    const firstOutcome = first['openaiResponses'];
    // The first scalar answer still owns the original HTTP status and error source.
    if (hosted.size === 0 || firstOutcome.kind !== 'stream') return first;

    const loop = {
      iterationCount: 1,
      remainingToolCalls: typeof request.max_tool_calls === 'number' ? request.max_tool_calls : undefined,
    };
    const demoteChoice = isForcedServerToolChoice(request.tool_choice, hosted);
    const stream = scope.wrapStream(firstOutcome.stream, async function* (inner, producer): AsyncGenerator<ResponsesStreamItem> {
      const merge = createMergeState();
      let source = inner;
      let roundPayload = request;
      let closeRound: (() => void) | undefined;
      try {
        for (;;) {
          const { turn, failure } = yield* consumeHostedTurn(source, {
            facts: { ...facts, 'openaiResponses': roundPayload },
            scope: producer,
          }, merge, loop.iterationCount === 1, hosted, loop, active);
          closeRound?.();
          closeRound = undefined;
          merge.accumulatedUsage = sumUsage(merge.accumulatedUsage, turn.turnUsage);

          if (failure !== undefined) {
            const native = openAIResponsesFailureEvents(failure);
            if (failure.kind !== 'protocol' || (native.notification === undefined && native.failed === undefined)) {
              yield { ok: false, error: failure };
              return;
            }
            const error = native.failed?.response.error ?? (native.notification ? responseErrorFromEvent(native.notification) : null);
            const notification = native.notification === undefined
              ? undefined : { ...native.notification, sequence_number: merge.sequenceNumber++ };
            const failed = native.failed === undefined ? undefined : failedResource(merge, active, error) ?? native.failed;
            yield {
              ok: false,
              error: openAIResponsesProtocolError(failure.cause, {
                ...(notification === undefined ? {} : { notification }),
                ...(failed === undefined ? {} : { failed }),
              }),
            };
            return;
          }

          const ending = turn.terminalStatus;
          if (ending.kind === 'failed' || ending.kind === 'bare-error-pre-shell' || ending.kind === 'error') {
            const error = ending.kind === 'failed' ? ending.response.error : ending.kind === 'error' ? responseErrorFromEvent(ending.event) : ending.error;
            const failed = failedResource(merge, active, error);
            yield { ok: false, error: openAIResponsesProtocolError(new Error(error?.message ?? 'OpenAI Responses hosted tool stream failed'), failed ? { failed } : {}) };
            return;
          }

          if (turn.sawServerToolCall) {
            if (producer.signal.aborted) {
              yield { ok: false, error: { kind: 'abort', cause: producer.signal.reason } };
              return;
            }
            const toolFailure = yield* materializeServerToolItems(turn.dispatchedSlots, merge, replayCodec);
            if (toolFailure !== undefined) {
              yield { ok: false, error: toolFailure.kind === 'abort' ? toolFailure : hostedScalarFailure(toolFailure, merge, active) };
              return;
            }
          }
          if (ending.kind === 'incomplete') {
            const frame = synthesizeTerminalEnvelope(merge, { kind: 'incomplete', incompleteDetails: ending.response.incomplete_details }, active);
            if (frame.type === 'event') yield { ok: true, value: frame.event };
            return;
          }
          if (!turn.sawServerToolCall || turn.sawClientToolCall) {
            const frame = synthesizeTerminalEnvelope(merge, { kind: 'completed' }, active);
            if (frame.type === 'event') yield { ok: true, value: frame.event };
            return;
          }

          const input = await expandServerToolHistory([
            ...canonicalInput,
            ...materializeAccumulatedOutput(merge).map(item => item as CanonicalOpenAIResponsesInputItem),
          ], active, replayCodec);
          const { max_tool_calls: _maxToolCalls, ...base } = roundPayload;
          const choice = base.tool_choice;
          roundPayload = {
            ...base,
            input,
            ...(loop.remainingToolCalls === undefined ? {} : { max_tool_calls: Math.max(0, loop.remainingToolCalls) }),
            ...(demoteChoice ? {
              tool_choice: typeof choice === 'object' && choice?.type === 'allowed_tools'
                ? { ...choice, mode: 'auto' } : 'auto',
            } : {}),
          };
          if (producer.signal.aborted) {
            yield { ok: false, error: { kind: 'abort', cause: producer.signal.reason } };
            return;
          }
          loop.iterationCount++;
          const call = producer.next({ ...facts, 'openaiResponses': roundPayload });
          closeRound = () => producer.abort(call);
          const next = await call;
          closeRound = () => {
            producer.abort(call);
            producer.discard(next);
          };
          const outcome = next['openaiResponses'];
          if (outcome.kind === 'error') {
            const error: ProtocolStreamError = isHostedScalarAbort(outcome, next['http'], producer.signal)
              ? { kind: 'abort', cause: producer.signal.reason }
              : hostedScalarFailure(outcome, merge, active);
            yield { ok: false, error };
            return;
          }
          if (outcome.kind !== 'stream') throw new TypeError('OpenAI Responses hosted tools received a scalar generation success');
          source = outcome.stream;
        }
      } finally {
        closeRound?.();
      }
    });
    return { ...first, 'openaiResponses': { kind: 'stream', stream } };
  },
});

const responseErrorFromEvent = (
  event: Extract<OpenAIResponsesStreamEventEx, { type: 'error' }>,
): OpenAIResponsesErrorEx | null => {
  const { type: _type, sequence_number: _sequenceNumber, ...fields } = event;
  const payload = ('error' in fields && isJsonObject(fields.error) ? fields.error : fields) as OpenAIResponsesErrorPayload;
  return typeof payload.code === 'string' ? { ...payload, code: payload.code, message: payload.message } : null;
};
