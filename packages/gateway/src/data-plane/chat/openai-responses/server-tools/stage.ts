// The server-tool shim, as a stage.
//
// A hosted tool the upstream does not implement is emulated here: the tool is rewritten into a
// function tool on the way down, the model's call to it is executed by this gateway, its result
// is fed back, and the upstream is asked again — until the model stops calling it. What the
// client sees is one turn, with the hosted tool's own item and lifecycle events in it.
//
// That is a **fork the stage merges**, and it is why this is one stage rather than several. It
// descends more than once, and every descent after the first is asked with the previous turn's
// output folded back into the input; the frames of all of them are spliced into one stream
// under one synthesized response id. Nothing above sees the repetition — which is exactly what
// `writeSettlement` means when it says repetition passes through the stage that observes usage.
//
// Position: directly above the dial, below the fork. So a descent re-dials the *same* candidate,
// and an upstream that refuses mid-loop rides up to `failover`, which re-runs the whole loop
// against the next candidate rather than resuming a half-finished one.
//
// What every descent is billable for travels up separately and is concatenated, not summed:
// each turn is its own upstream call with its own pricing facts — a service tier and an input
// size that a later turn need not share — so the run settles one row per call rather than one
// row whose rate is a guess.

import {
  buildErrorFromRefusal,
  consumeTurnStreaming,
  createMergeState,
  materializeAccumulatedOutput,
  materializeServerToolItems,
  resolveServerToolName,
  rewriteHostedToolChoice,
  rewriteToolsForHostedShim,
  sumUsage,
  synthesizeTerminalEnvelope,
  transformServerToolItems,
  type ActiveServerTool,
  type MergeState,
  type ServerToolDispatcher,
  type ServerToolHostedDispatch,
  type ServerToolLoopState,
  type ServerToolRegistration,
  type TurnSummary,
} from './shim.ts';
import type { BillableEntity, Failure } from '../../../pipeline/facts.ts';
import { isFailure } from '../../../pipeline/facts.ts';
import type { StreamOutcome } from '../../../pipeline/serve.ts';
import type { ChatAnswer, ChatFacts } from '../../facts.ts';
import type { ChatServices } from '../../stages.ts';
import { defer, defineStage, move, type Deferred } from '@floway-dev/pipeline';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type {
  CanonicalOpenAIResponsesPayload,
  OpenAIResponsesInputItem,
  OpenAIResponsesResult,
  OpenAIResponsesStreamEvent,
} from '@floway-dev/protocols/openai-responses';
import type { ChatTargetApi, ModelCandidate, OpenAIResponsesInvocation } from '@floway-dev/provider';

type R<K extends keyof ChatFacts> = { [P in K]: ChatFacts[P] };

/** What comes back through here. The streamed-usage key is the *source* family's rather than
 *  this protocol's — the same reason a wire is told it — so the slice is open at that one key
 *  and closed everywhere else. */
type Answered = R<'response.chat.openaiResponses' | 'response.usage.billable' | 'response.http.headers'>
  & { 'response.chat.openaiResponses.streamedUsage': Deferred<StreamOutcome> | null }
  & Record<string, unknown>;

/** One descent, as the loop reads it: the frames it is to splice, and what that call will turn
 *  out to have been billable for once they run out. */
interface Turn {
  readonly frames: AsyncIterable<ProtocolFrame<OpenAIResponsesStreamEvent>>;
  readonly usage: Deferred<StreamOutcome> | null;
}

/** What the gateway answers a request its own tool declaration cannot accept. It is this
 *  gateway's refusal rather than an upstream's, so it carries the envelope a client reads and
 *  the 400 that goes with it. */
const invalidRequest = (
  message: string,
  param: string | null,
  code: string | null | undefined,
  errorType = 'invalid_request_error',
): Failure => {
  const envelope = {
    error: { message, type: errorType, param, code: code === undefined ? 'invalid_request_error' : code },
  };
  return { status: 400, message, envelope };
};

/**
 * Prepares every registered tool over the payload this attempt is about to send.
 *
 * The registrations are handed an invocation rather than facts, because what they read is the
 * body and the candidate and nothing else — and the object they read it through is the stage's
 * own, built here and never handed anywhere, so shaping it in place shapes nothing shared.
 */
const prepareServerTools = async (
  registrations: readonly ServerToolRegistration[],
  invocation: OpenAIResponsesInvocation,
  gateway: ChatServices['gateway'],
): Promise<{ readonly active: readonly ActiveServerTool[] } | { readonly refused: Failure }> => {
  const active: ActiveServerTool[] = [];
  for (const prepareServerTool of registrations) {
    const prepared = await prepareServerTool(invocation, gateway);
    if (prepared.type === 'inactive') continue;
    if (prepared.type === 'invalid-request') {
      return { refused: invalidRequest(prepared.message, prepared.param, prepared.code, prepared.errorType) };
    }
    const currentTools = Array.isArray(invocation.payload.tools) ? invocation.payload.tools : [];
    const toolName = resolveServerToolName(prepared.baseToolName, currentTools);
    const { hosted } = prepared;
    let canonicalHostedTool;
    if (hosted !== undefined) {
      const rewrite = rewriteToolsForHostedShim(currentTools, hosted, toolName);
      canonicalHostedTool = rewrite.canonicalHostedTool;
      invocation.payload = { ...invocation.payload, tools: rewrite.rewritten };
    }
    const originalToolChoice = hosted !== undefined
      && typeof invocation.payload.tool_choice === 'object'
      && invocation.payload.tool_choice !== null
      && hosted.hostedTypes.includes(invocation.payload.tool_choice.type)
      ? invocation.payload.tool_choice
      : undefined;
    active.push({ ...prepared, toolName, canonicalHostedTool, originalToolChoice });
  }
  return { active };
};

/** What the stage is told rather than reaching for, because reaching for it would be this
 *  module importing the chain that composes it. `streamedUsage` is the family's own reading key;
 *  `targetOf` says which wire this candidate is reachable on, which is the one thing a
 *  registration reads about the dial it is preparing for. */
export interface ServerToolWiring {
  readonly streamedUsage: string;
  readonly targetOf: (candidate: ModelCandidate) => ChatTargetApi;
}

export const runOpenAIResponsesServerTools = (
  registrations: readonly ServerToolRegistration[],
  wiring: ServerToolWiring,
) => defineStage<
  R<'request.chat.openaiResponses' | 'route.attempt' | 'ingress.http.headers'>,
  R<'request.chat.openaiResponses' | 'route.attempt' | 'ingress.http.headers'>,
  Answered,
  Answered,
  Answered,
  ChatServices
>({
  name: 'runOpenAIResponsesServerTools',
  through: {
    request: {
      needs: ['request.chat.openaiResponses', 'route.attempt', 'ingress.http.headers'],
      consumes: [],
      provides: ['request.chat.openaiResponses'],
    },
    response: {
      needs: ['response.chat.openaiResponses', wiring.streamedUsage, 'response.usage.billable', 'response.http.headers'],
      consumes: [],
      provides: ['response.chat.openaiResponses', wiring.streamedUsage, 'response.usage.billable'],
    },
  },
  // A tool declaration this gateway cannot accept is answered here rather than dialled: the
  // upstream would have been asked for a tool it does not implement, on a body the shim wrote.
  return: {
    provides: ['response.chat.openaiResponses', wiring.streamedUsage, 'response.usage.billable', 'response.http.headers'],
  },
  execute: async (facts, next, use) => {
    const candidate = use.resolveAttempt(facts['route.attempt']);
    // The stage's own view of the turn, which is what a registration reads and shapes. It is
    // built here and handed nowhere, so the payload it ends up holding is what descends.
    const invocation: OpenAIResponsesInvocation = {
      payload: facts['request.chat.openaiResponses'] as CanonicalOpenAIResponsesPayload,
      candidate,
      targetApi: wiring.targetOf(candidate),
      headers: new Headers(facts['ingress.http.headers'].map(([name, value]): [string, string] => [name, value])),
      action: 'generate',
    };

    const prepared = await prepareServerTools(registrations, invocation, use.gateway);
    if ('refused' in prepared) {
      use.log.debug('refusing a server-tool declaration this gateway cannot accept');
      return move({
        ...facts,
        'response.chat.openaiResponses': prepared.refused,
        [wiring.streamedUsage]: null,
        'response.usage.billable': [],
        'response.http.headers': [],
      }) as never;
    }
    const { active } = prepared;
    if (active.length === 0) return await next(facts);

    const rewrittenToolChoice = rewriteHostedToolChoice(invocation.payload.tool_choice, active);
    if (rewrittenToolChoice !== invocation.payload.tool_choice) {
      invocation.payload = { ...invocation.payload, tool_choice: rewrittenToolChoice };
    }
    const canonicalInput = invocation.payload.input;
    const nextInput = transformServerToolItems(canonicalInput, active);
    if (nextInput !== canonicalInput) invocation.payload = { ...invocation.payload, input: nextInput };

    const hostedActive = active.filter(
      (entry): entry is ActiveServerTool & { hosted: ServerToolHostedDispatch } => entry.hosted !== undefined,
    );
    // A registration that only rewrote history has nothing to execute, so the turn is an
    // ordinary one — dialled with the body it wrote and read by nobody here.
    if (hostedActive.length === 0) return await descend(next, facts, invocation.payload);

    const dispatchers = new Map<string, ServerToolDispatcher>();
    for (const entry of hostedActive) dispatchers.set(entry.toolName, entry.hosted.dispatcher);
    const loopState: ServerToolLoopState = {
      iterationCount: 1,
      remainingToolCalls: typeof invocation.payload.max_tool_calls === 'number' ? invocation.payload.max_tool_calls : undefined,
    };
    const finalToolChoice = invocation.payload.tool_choice;
    const demoteForcedServerToolChoiceAfterFirstTurn = finalToolChoice === 'required'
      || (typeof finalToolChoice === 'object'
        && finalToolChoice !== null
        && finalToolChoice.type === 'function'
        && dispatchers.has(finalToolChoice.name));
    const back = await descend(next, facts, invocation.payload) as Answered & Record<string, unknown>;
    const first = turnOf(back, wiring.streamedUsage);
    // An upstream that refused, or a compaction, is not a turn the loop can splice: it rides up
    // as it came, and the tools this turn declared were simply never called.
    if (first === null) return back as never;

    const merge = createMergeState();
    const billed: BillableEntity[] = [];
    let settle!: (outcome: StreamOutcome) => void;
    // Every descent's reading is awaited inside the loop, so this is complete by the time the
    // spliced stream ends — which is the moment the run is answerable for what it billed.
    const usage = defer(new Promise<StreamOutcome>(resolve => { settle = resolve; }));

    return {
      ...back,
      'response.chat.openaiResponses': move({
        kind: 'stream' as const,
        frames: {
          [Symbol.asyncIterator]: () => spliceTurns({
            next,
            facts,
            invocation,
            merge,
            loopState,
            demoteForcedServerToolChoiceAfterFirstTurn,
            first,
            dispatchers,
            store: use.gateway.store,
            canonicalInput,
            active,
            billed,
            settle,
            streamedUsage: wiring.streamedUsage,
          }),
        },
      }),
      [wiring.streamedUsage]: move(usage),
      // What was known when this stage handed up, which is what the first call reported. The
      // figure every call turned out to cost arrives with the stream, through the reading above.
      'response.usage.billable': back['response.usage.billable'],
    } as never;
  },
});

/** One descent, asked with the payload the shim wrote. */
const descend = async (
  next: (facts: R<'request.chat.openaiResponses' | 'route.attempt' | 'ingress.http.headers'>) => Promise<Answered>,
  facts: R<'request.chat.openaiResponses' | 'route.attempt' | 'ingress.http.headers'>,
  payload: CanonicalOpenAIResponsesPayload,
): Promise<Answered> => await next(move({ ...facts, 'request.chat.openaiResponses': move(payload) }));

/** The descent's answer as a turn, or `null` where it was not one the loop can splice. The
 *  reading is read at the key the wire was told, which is the source family's own. */
const turnOf = (back: Answered, streamedUsage: string): Turn | null => {
  const answer = back['response.chat.openaiResponses'] as ChatAnswer;
  if (isFailure(answer) || answer.kind !== 'stream') return null;
  return {
    frames: answer.frames as AsyncIterable<ProtocolFrame<OpenAIResponsesStreamEvent>>,
    usage: back[streamedUsage] as Deferred<StreamOutcome> | null,
  };
};

/** What a turn cost, once its own frames have run out. The loop reads them one at a time, so
 *  the running total is complete when the spliced stream reaches its terminal. */
const accumulate = async (billed: BillableEntity[], turn: Turn): Promise<boolean> => {
  if (turn.usage === null) return false;
  const outcome = await turn.usage;
  billed.push(...outcome.billable);
  return outcome.failed;
};

async function* spliceTurns(args: {
  next: (facts: R<'request.chat.openaiResponses' | 'route.attempt' | 'ingress.http.headers'>) => Promise<Answered>;
  facts: R<'request.chat.openaiResponses' | 'route.attempt' | 'ingress.http.headers'>;
  invocation: OpenAIResponsesInvocation;
  merge: MergeState;
  loopState: ServerToolLoopState;
  demoteForcedServerToolChoiceAfterFirstTurn: boolean;
  first: Turn;
  dispatchers: ReadonlyMap<string, ServerToolDispatcher>;
  store: ChatServices['gateway']['store'];
  canonicalInput: OpenAIResponsesInputItem[];
  active: readonly ActiveServerTool[];
  billed: BillableEntity[];
  settle: (outcome: StreamOutcome) => void;
  streamedUsage: string;
}): AsyncGenerator<ProtocolFrame<OpenAIResponsesStreamEvent>> {
  const { invocation, merge, loopState, demoteForcedServerToolChoiceAfterFirstTurn, dispatchers, store, active, billed, settle } = args;
  const baseInput = args.canonicalInput;
  let failed = false;
  let midStreamError: unknown = undefined;
  try {
    let currentTurn: TurnSummary = yield* consumeTurnStreaming(args.first.frames, merge, true, dispatchers, loopState, active);
    failed = await accumulate(billed, args.first) || failed;
    merge.accumulatedUsage = sumUsage(merge.accumulatedUsage, currentTurn.turnUsage);
    for (;;) {
      const turn = currentTurn;
      const executedShim = turn.dispatched.length > 0;

      if (turn.terminalStatus.kind === 'failed') {
        if (executedShim) yield* materializeServerToolItems(turn.dispatched, merge, store);
        yield synthesizeTerminalEnvelope(merge, { kind: 'failed', error: turn.terminalStatus.response.error }, active);
        return;
      }
      if (turn.terminalStatus.kind === 'incomplete') {
        if (executedShim) yield* materializeServerToolItems(turn.dispatched, merge, store);
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

      yield* materializeServerToolItems(turn.dispatched, merge, store);
      if (turn.sawClientToolCall) {
        yield synthesizeTerminalEnvelope(merge, { kind: 'completed' }, active);
        return;
      }

      // Accumulated output items are fed back as the next turn's input. An OpenAI Responses
      // output item is a structural superset of the matching input item for every shape emitted
      // here — messages, reasoning, function_call / function_call_output, and the server-tool
      // items the dispatchers produce — so the reuse is sound; the cast only bridges the
      // output/input naming.
      const nextCanonicalInput = [
        ...baseInput,
        ...materializeAccumulatedOutput(merge).map(item => item as OpenAIResponsesInputItem),
      ];
      const { max_tool_calls: _spent, ...withoutCap } = invocation.payload;
      invocation.payload = {
        ...withoutCap,
        input: transformServerToolItems(nextCanonicalInput, active),
        ...(loopState.remainingToolCalls === undefined ? {} : { max_tool_calls: Math.max(0, loopState.remainingToolCalls) }),
        ...(demoteForcedServerToolChoiceAfterFirstTurn ? { tool_choice: 'auto' as const } : {}),
      };
      loopState.iterationCount += 1;

      const back = await descend(args.next, args.facts, invocation.payload);
      const nextTurn = turnOf(back, args.streamedUsage);
      if (nextTurn === null) {
        yield synthesizeTerminalEnvelope(merge, { kind: 'failed', error: errorOf(back) }, active);
        return;
      }
      failed = await accumulate(billed, nextTurn) || failed;
      currentTurn = yield* consumeTurnStreaming(nextTurn.frames, merge, false, dispatchers, loopState, active);
      merge.accumulatedUsage = sumUsage(merge.accumulatedUsage, currentTurn.turnUsage);
    }
  } catch (error) {
    if (merge.lastSeenModel === null) {
      midStreamError = error;
      throw error;
    }
    failed = true;
    yield synthesizeTerminalEnvelope(merge, {
      kind: 'failed',
      error: {
        code: 'server_error',
        message: `Upstream stream failed mid-response: ${error instanceof Error ? error.message : String(error)}`,
      },
    }, active);
  } finally {
    // A run that threw before a model was known has no answer to settle from; every other way
    // out of the loop leaves what each call billed, and whether the turn got where it said.
    if (midStreamError === undefined) settle({ billable: billed, failed });
  }
}

/** A descent that did not answer with a stream, as the error the synthesized envelope carries.
 *  A compaction reaches here only if a client asked one to run tools, which no client does. */
const errorOf = (back: Answered): NonNullable<OpenAIResponsesResult['error']> => {
  const answer = back['response.chat.openaiResponses'] as ChatAnswer;
  return isFailure(answer)
    ? buildErrorFromRefusal(answer.status, answer.message)
    : { code: 'server_error', message: 'the upstream answered a server-tool turn with a compaction' };
};
