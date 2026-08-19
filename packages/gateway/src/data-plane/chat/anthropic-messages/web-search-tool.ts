// Anthropic's web-search server tool, as a stage.
//
// Anthropic exposes `web_search_*` as native server tools. An upstream that cannot serve them —
// every non-Anthropic-Messages target, and a native one whose operator says so — gets the tool
// rewritten into an ordinary client tool on the way down, each search the model issues executed
// by this gateway, and the answer rewritten back into Anthropic's own
// `server_tool_use` / `web_search_tool_result` shape on the way up.
//
// One descent, unlike the OpenAI Responses shim: Anthropic's protocol carries the tool result
// inside the same turn, so there is nothing to ask again for. What this stage is, then, is a
// request rewrite and a response rewrite around one dial.

import {
  anthropicMessagesWebSearchInvalidRequestBody,
  prepareAnthropicMessagesWebSearchInvocation,
  resolveActiveAnthropicMessagesWebSearchProvider,
  rewriteAnthropicMessagesWebSearchEventsToNative,
} from './web-search-shim.ts';
import type { Failure } from '../../pipeline/facts.ts';
import { isFailure } from '../../pipeline/facts.ts';
import type { ChatAnswer, ChatFacts } from '../facts.ts';
import type { ChatServices } from '../stages.ts';
import { defineStage, move } from '@floway-dev/pipeline';
import type { AnthropicMessagesPayload, AnthropicMessagesStreamEvent } from '@floway-dev/protocols/anthropic-messages';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { ChatTargetApi, ModelCandidate } from '@floway-dev/provider';

type M<K extends keyof ChatFacts> = { [P in K]: ChatFacts[P] };

type Answered = M<'response.chat.anthropicMessages' | 'response.usage.billable' | 'response.http.headers'> & Record<string, unknown>;

/** The gateway's own refusal, in Anthropic's words. It is written here rather than dialled,
 *  because a tool declaration this shim cannot execute would reach the upstream as a body this
 *  gateway wrote. The envelope is stated as itself: a refusal this gateway authored has no
 *  upstream bytes behind it, so there is nothing to serialize and read back. */
const refusal = (message: string): Failure => ({
  status: 400,
  message,
  envelope: anthropicMessagesWebSearchInvalidRequestBody(message),
});

/** What the stage is told rather than reaching for: which wire this candidate is reachable on,
 *  which is what decides whether the upstream can carry Anthropic's server tools at all. */
export interface WebSearchWiring {
  readonly targetOf: (candidate: ModelCandidate) => ChatTargetApi;
}

export const runAnthropicMessagesWebSearchTool = (wiring: WebSearchWiring) => defineStage<
  M<'request.chat.anthropicMessages' | 'route.attempt'>,
  M<'request.chat.anthropicMessages' | 'route.attempt'>,
  Answered,
  Answered,
  Answered,
  ChatServices
>({
  name: 'runAnthropicMessagesWebSearchTool',
  through: {
    request: {
      needs: ['request.chat.anthropicMessages', 'route.attempt'],
      consumes: [],
      provides: ['request.chat.anthropicMessages'],
    },
    response: {
      needs: ['response.chat.anthropicMessages'],
      consumes: [],
      provides: ['response.chat.anthropicMessages'],
    },
  },
  // A declaration this gateway cannot execute, and a search backend the operator has not
  // configured, are both answered here: neither is a body an upstream should be asked about.
  return: {
    provides: ['response.chat.anthropicMessages', 'response.usage.billable', 'response.http.headers'],
  },
  execute: async (facts, next, use) => {
    const candidate = use.resolveAttempt(facts['route.attempt']);
    // The stage's own view of the turn, which is what the preparation reads and shapes. It is
    // built here and handed nowhere, so the payload it ends up holding is what descends.
    const invocation = {
      payload: facts['request.chat.anthropicMessages'],
      candidate,
      targetApi: wiring.targetOf(candidate),
      headers: new Headers(),
    };

    const prepared = prepareAnthropicMessagesWebSearchInvocation(invocation);
    if (prepared.type === 'inactive') return await next(facts);
    if (prepared.type === 'invalid-request') {
      use.log.debug('refusing a web-search declaration this gateway cannot execute');
      return move({
        ...facts,
        'response.chat.anthropicMessages': refusal(prepared.message),
        'response.usage.billable': [],
        'response.http.headers': [],
      }) as never;
    }

    // A search that will actually run needs a backend; one the operator never configured
    // raises, because a turn nobody can answer is this gateway's own fault to surface.
    const backend = prepared.state.mode === 'active'
      ? await resolveActiveAnthropicMessagesWebSearchProvider(use.gateway.apiKeyId)
      : undefined;

    const back = await next(move({
      ...facts,
      'request.chat.anthropicMessages': move(invocation.payload as AnthropicMessagesPayload),
    })) as Answered;

    const answer = back['response.chat.anthropicMessages'] as ChatAnswer;
    if (isFailure(answer) || answer.kind !== 'stream') return back as never;
    return {
      ...back,
      'response.chat.anthropicMessages': move({
        kind: 'stream' as const,
        frames: {
          [Symbol.asyncIterator]: () => rewriteAnthropicMessagesWebSearchEventsToNative(
            answer.frames as AsyncIterable<ProtocolFrame<AnthropicMessagesStreamEvent>>,
            prepared.state,
            backend,
          ),
        },
      }),
    } as never;
  },
});
