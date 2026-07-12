// Response-side inverse of `withFlattenToolSearchFamily`'s namespace-name
// prefixing. When the request-side flag is on, `unpackNamespaceTools`
// rewrites each namespaced sub-tool's `name` to `<namespace>__<name>`; the
// model, seeing that prefix, will emit tool_call events under the prefixed
// name too. This interceptor scans the downstream event stream and rewrites
// `function_call` / `custom_tool_call` output items back to their bare names
// (and, for `custom_tool_call`, populates the `namespace` field from the
// stripped prefix) so downstream clients (Codex / SDK consumers) can match
// against their originally-declared tool registry.
//
// Applied to:
//  - `response.output_item.added`
//  - `response.output_item.done`
//  - `response.completed` / `.incomplete` / `.failed` — the terminal
//    envelope's `response.output[]` list.
//
// Function-call vs custom-tool-call asymmetry:
//  - `function_call` has no `namespace` field in the Responses schema
//    (`ResponsesFunctionToolCallItem`/`ResponsesOutputFunctionCall`). Prefix
//    is stripped from `name`; namespace context is lost, but the client's
//    tool registry is keyed by bare name so routing still works.
//  - `custom_tool_call` has `namespace` (see `ResponsesCustomToolCallItem`).
//    Prefix is moved from `name` into `namespace`, fully round-tripped.

import type { ResponsesInterceptor } from './types.ts';
import { eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import { unprefixNamespaceToolCall, type ResponsesOutputItem, type ResponsesStreamEvent } from '@floway-dev/protocols/responses';
import { type ExecuteResult, eventResult } from '@floway-dev/provider';
import { providerModelOf } from '@floway-dev/provider';

const unprefixOutputItem = (item: ResponsesOutputItem): ResponsesOutputItem => {
  if (item.type !== 'function_call' && item.type !== 'custom_tool_call') return item;
  const name = (item as { name?: unknown }).name;
  if (typeof name !== 'string') return item;
  const split = unprefixNamespaceToolCall(name);
  if (split === null) return item;
  if (item.type === 'custom_tool_call') {
    return { ...item, name: split.name, namespace: split.namespace };
  }
  return { ...item, name: split.name };
};

const unprefixNamespaceToolCalls = async function* (
  frames: AsyncIterable<ProtocolFrame<ResponsesStreamEvent>>,
): AsyncGenerator<ProtocolFrame<ResponsesStreamEvent>> {
  for await (const frame of frames) {
    if (frame.type !== 'event') {
      yield frame;
      continue;
    }
    const event = frame.event;

    if (event.type === 'response.output_item.added' || event.type === 'response.output_item.done') {
      const rewritten = unprefixOutputItem(event.item);
      if (rewritten !== event.item) {
        yield eventFrame({ ...event, item: rewritten });
        continue;
      }
    } else if (event.type === 'response.completed' || event.type === 'response.incomplete' || event.type === 'response.failed') {
      const originalOutput = event.response.output;
      let any = false;
      const output = originalOutput.map(item => {
        const rewritten = unprefixOutputItem(item);
        if (rewritten !== item) any = true;
        return rewritten;
      });
      if (any) {
        yield eventFrame({ ...event, response: { ...event.response, output } });
        continue;
      }
    }

    yield frame;
  }
};

export const withUnprefixNamespaceToolCalls: ResponsesInterceptor = async (ctx, _request, run) => {
  if (!providerModelOf(ctx.candidate).enabledFlags.has('flatten-tool-search-family')) return await run();
  const result: ExecuteResult<ProtocolFrame<ResponsesStreamEvent>> = await run();
  if (result.type !== 'events') return result;

  return eventResult(unprefixNamespaceToolCalls(result.events), result.modelIdentity, {
    performance: result.performance,
    finalMetadata: result.finalMetadata,
    headers: result.headers,
  });
};
