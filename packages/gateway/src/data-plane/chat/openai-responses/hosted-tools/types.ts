import type { ChatGatewayCtx } from '../../shared/gateway-ctx.ts';
import type {
  CanonicalOpenAIResponsesInputItem,
  OpenAIResponsesErrorEx,
  OpenAIResponsesFunctionCallOutputItem,
  OpenAIResponsesFunctionTool,
  OpenAIResponsesHostedTool,
  OpenAIResponsesOutputFunctionCallEx,
  OpenAIResponsesOutputItemEx,
  OpenAIResponsesResultEx,
  OpenAIResponsesStreamEventEx,
  OpenAIResponsesTool,
  OpenAIResponsesToolChoice,
} from '@floway-dev/protocols/openai-responses';
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
  accumulatedOutput: Map<number, OpenAIResponsesOutputItemEx>;
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

export interface HostedToolSlotResult {
  item: HostedToolOutputItem;
  endEvents: HostedToolLifecycleEvent[];
  replayData?: unknown;
}

export type HostedToolHistoryExpansion = (
  | { callSource: 'replay' }
  | { callSource: 'synthesized'; synthesizedCall: { callId: string; arguments: string } }
) & {
  output: OpenAIResponsesFunctionCallOutputItem['output'];
  feedback?: Array<Extract<CanonicalOpenAIResponsesInputItem, { type: 'message' }> & { role: 'user' }>;
};

export interface HostedToolResultSlot {
  id: string;
  startItem: HostedToolOutputItem;
  startEvents: readonly HostedToolLifecycleEvent[];
  // The deferred portion of a slot's lifecycle, driven at materialization
  // time. It yields any intermediate lifecycle events as they arrive — e.g.
  // progressively-rendered `image_generation_call.partial_image` frames a
  // streamed backend delivers over the course of the call — and returns the
  // terminal item plus its closing events and replay data. A tool with no
  // progressive output simply yields nothing and returns immediately.
  run: () => AsyncGenerator<HostedToolLifecycleEvent, HostedToolSlotResult>;
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
  carrierIndex: number;
  carrierId: string;
}

export type HostedToolDispatcher = (args: {
  intercepted: InterceptedFunctionCall;
  loopState: HostedToolLoopState;
}) => HostedToolResultSlot[];

// Keep hosted matching, function injection, and dispatch atomic so a
// registration cannot silently omit part of a hosted-tool family.
export interface HostedToolRewrite {
  hostedTypes: readonly string[];
  recognizeHostedTool: (raw: OpenAIResponsesTool) => OpenAIResponsesHostedTool | undefined;
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
    // Return undefined for items this tool does not own. The stage restores the
    // original call and pairs its output before appending tool-specific feedback.
    expandHistoryItem?: (item: CanonicalOpenAIResponsesInputItem, replay?: { data: unknown }) => HostedToolHistoryExpansion | undefined;
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
// the loop can lift its error and usage. Error notifications remain separate
// from a response resource, including when no resource follows. Distinct from
// `SynthesizedTerminal`, which is the stage's own outgoing terminal.
export type UpstreamTerminal =
  | { kind: 'completed' }
  | { kind: 'failed'; response: OpenAIResponsesResultEx }
  | { kind: 'incomplete'; response: OpenAIResponsesResultEx }
  | { kind: 'error'; event: Extract<OpenAIResponsesStreamEventEx, { type: 'error' }> }
  | { kind: 'bare-error-pre-shell'; error: OpenAIResponsesErrorEx };

export interface TurnSummary {
  dispatchedSlots: DispatchedHostedToolSlot[];
  sawHostedToolCall: boolean;
  sawClientToolCall: boolean;
  turnUsage: MergeUsage;
  terminalStatus: UpstreamTerminal;
}

// The terminal the stage emits downstream. Unlike `UpstreamTerminal`
// (what we observed), this carries only the already-extracted `error` /
// `incompleteDetails` the synthesized envelope needs; the output and
// usage come from accumulated merge state. There is no pre-shell variant
// here — synthesis always runs after a model is known.
export type SynthesizedTerminal =
  | { kind: 'completed' }
  | { kind: 'failed'; error: OpenAIResponsesResultEx['error'] }
  | { kind: 'incomplete'; incompleteDetails: OpenAIResponsesResultEx['incomplete_details'] };
