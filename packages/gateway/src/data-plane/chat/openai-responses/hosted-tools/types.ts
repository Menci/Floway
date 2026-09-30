import type { ChatGatewayCtx } from '../../shared/gateway-ctx.ts';
import type { OpenAIResponsesOutputItem, OpenAIResponsesResult, OpenAIResponsesTool, OpenAIResponsesHostedTool, OpenAIResponsesFunctionTool, OpenAIResponsesInputItem, OpenAIResponsesToolChoice } from '@floway-dev/protocols/openai-responses';
import type { OpenAIResponsesInvocation } from '@floway-dev/provider';

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
  accumulatedOutput: Map<number, OpenAIResponsesOutputItem>;
  accumulatedUsage: MergeUsage;
  lastSeenModel: string | null;
  synthesizedResponseId: string;
  upstreamResponseSnapshot: OpenAIResponsesResult | undefined;
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

export interface HostedToolTerminal {
  item: HostedToolOutputItem;
  endEvents: HostedToolLifecycleEvent[];
  /**
   * Optional server-only blob registered on the request's item store under
   * `slot.id` before the slot's wire item leaves materialize. The persistence
   * layer stores it in `payload.private`; the replay-side `transformItems`
   * reads it back to reconstruct the full IR.
   */
  privatePayload?: unknown;
}

export interface HostedToolResultSlot {
  id: string;
  startItem: HostedToolOutputItem;
  startEvents: readonly HostedToolLifecycleEvent[];
  // The deferred portion of a slot's lifecycle, driven at materialization
  // time. It yields any intermediate lifecycle events as they arrive — e.g.
  // progressively-rendered `image_generation_call.partial_image` frames a
  // streamed backend delivers over the course of the call — and returns the
  // terminal item plus its closing events (and an optional server-only
  // `privatePayload`). A tool with no progressive output simply yields nothing
  // and returns immediately.
  run: () => AsyncGenerator<HostedToolLifecycleEvent, HostedToolTerminal>;
}

export type HostedToolOutputItem = { type: string; id?: string; [key: string]: unknown };

export type HostedToolLifecycleEvent = { type: string; [key: string]: unknown };

export interface HostedToolLoopState {
  iterationCount: number;
  remainingToolCalls: number | undefined;
}

export interface DispatchedHostedToolSlot {
  intercepted: InterceptedFunctionCall;
  slot: HostedToolResultSlot;
  outputIndex: number;
}

export type HostedToolDispatcher = (args: {
  intercepted: InterceptedFunctionCall;
  loopState: HostedToolLoopState;
}) => HostedToolResultSlot[];

// Keep hosted matching, function injection, and dispatch atomic so a
// registration cannot silently omit part of a hosted-tool family.
export interface HostedToolRewrite {
  hostedTypes: readonly string[];
  canonicalize: (raw: OpenAIResponsesTool) => OpenAIResponsesHostedTool | undefined;
  buildFunctionTool: (canonical: OpenAIResponsesHostedTool, toolName: string) => OpenAIResponsesFunctionTool;
  dispatcher: HostedToolDispatcher;
}

export type HostedToolPrepareResult =
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
    transformItems?: (items: OpenAIResponsesInputItem[], toolName: string) => OpenAIResponsesInputItem[];
    // Present only when the request declares this hosted tool; absent for
    // replay-only activation.
    hosted?: HostedToolRewrite;
  };

export type HostedToolRegistration = (invocation: OpenAIResponsesInvocation, gatewayCtx: ChatGatewayCtx) => HostedToolPrepareResult | Promise<HostedToolPrepareResult>;

export type ActiveHostedTool = Extract<HostedToolPrepareResult, { type: 'active' }> & {
  toolName: string;
  // Hosted entries are rewritten at their input-item positions; only
  // top-level replacements participate in response.tools restoration.
  canonicalHostedTool: OpenAIResponsesHostedTool | undefined;
  // Captures the exact forced choice shape before request rewriting.
  originalToolChoice: Exclude<OpenAIResponsesToolChoice, string> | undefined;
};

// How a single upstream turn ended, as observed while consuming its
// stream. Carries the raw upstream `response` for failed/incomplete so
// the loop can lift the upstream `error` / `incomplete_details`, plus a
// `bare-error-pre-shell` variant for an `error` event that arrived
// before any `response.created` (no model known yet). Distinct from
// `SynthesizedTerminal`, which is the shim's own outgoing terminal.
export type UpstreamTerminal =
  | { kind: 'completed' }
  | { kind: 'failed'; response: OpenAIResponsesResult }
  | { kind: 'incomplete'; response: OpenAIResponsesResult }
  | { kind: 'bare-error-pre-shell'; error: { message: string; code: string } };

export interface TurnSummary {
  dispatched: Array<{ intercepted: InterceptedFunctionCall; slots: DispatchedHostedToolSlot[] }>;
  sawClientToolCall: boolean;
  turnUsage: MergeUsage;
  terminalStatus: UpstreamTerminal;
}

// The terminal the shim emits downstream. Unlike `UpstreamTerminal`
// (what we observed), this carries only the already-extracted `error` /
// `incompleteDetails` the synthesized envelope needs; the output and
// usage come from accumulated shim state. There is no pre-shell variant
// here — synthesis always runs after a model is known.
export type SynthesizedTerminal =
  | { kind: 'completed' }
  | { kind: 'failed'; error: OpenAIResponsesResult['error'] }
  | { kind: 'incomplete'; incompleteDetails: OpenAIResponsesResult['incomplete_details'] };
