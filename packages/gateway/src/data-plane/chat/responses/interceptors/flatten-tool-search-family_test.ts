import { test } from 'vitest';

import { withFlattenToolSearchFamily } from './flatten-tool-search-family.ts';
import type { ResponsesInvocation } from './types.ts';
import { mockChatGatewayCtx } from '../../../../test-helpers/gateway-ctx.ts';
import { doneFrame } from '@floway-dev/protocols/common';
import { eventResult, type FlagId } from '@floway-dev/provider';
import { assert, assertEquals, stubModelCandidate, testTelemetryModelIdentity } from '@floway-dev/test-utils';
import type { CanonicalResponsesPayload } from '@floway-dev/translate/via-responses/responses-items';

const stubCtx = mockChatGatewayCtx();

const okEvents = () =>
  Promise.resolve(
    eventResult(
      (async function* () {
        yield doneFrame();
      })(),
      testTelemetryModelIdentity,
    ),
  );

const invocation = (payload: CanonicalResponsesPayload, enabledFlags: ReadonlySet<FlagId> = new Set(['flatten-tool-search-family'])): ResponsesInvocation => ({
  payload,
  candidate: stubModelCandidate({ enabledFlags }),
  targetApi: 'responses',
  headers: new Headers(),
  action: 'generate',
});

test('runs the full one-pass desugar when flag is on', async () => {
  const input = invocation({
    model: 'gpt-5.6-sol',
    input: [
      { type: 'message', role: 'user', content: 'hi' },
      {
        type: 'additional_tools',
        role: 'developer',
        tools: [
          { type: 'custom', name: 'exec' },
          {
            type: 'namespace',
            name: 'collab',
            tools: [
              { type: 'function', name: 'spawn_agent', parameters: {}, strict: false, defer_loading: true },
            ],
          },
        ],
      } as unknown as CanonicalResponsesPayload['input'][number],
      { type: 'message', role: 'user', content: 'go' },
    ],
    tools: [
      { type: 'function', name: 'keep', parameters: {}, strict: false, allowed_callers: ['programmatic'] },
      { type: 'tool_search' },
      { type: 'programmatic_tool_calling' },
    ],
  });

  await withFlattenToolSearchFamily(input, stubCtx, okEvents);

  // additional_tools item removed from input; user messages preserved in order
  const items = input.payload.input;
  assertEquals(items.length, 2);
  assertEquals(items[0].type, 'message');
  assertEquals(items[1].type, 'message');

  // tools[]: [keep (allowed_callers stripped), tool_search dropped, PTC dropped,
  // exec (from additional_tools), collab__spawn_agent (unpacked, defer_loading stripped)]
  const tools = input.payload.tools ?? [];
  assertEquals(tools.length, 3);
  const keep = tools.find(t => t.type === 'function' && (t as { name: string }).name === 'keep') as { allowed_callers?: unknown } | undefined;
  assert(keep !== undefined);
  assertEquals(keep?.allowed_callers, undefined);
  assert(tools.some(t => t.type === 'custom' && (t as { name: string }).name === 'exec'));
  const collab = tools.find(t => (t as { name?: string }).name === 'collab__spawn_agent') as { defer_loading?: boolean } | undefined;
  assert(collab !== undefined);
  assertEquals(collab?.defer_loading, undefined);
  assert(!tools.some(t => t.type === 'tool_search'));
  assert(!tools.some(t => t.type === 'programmatic_tool_calling'));
});

test('early-returns when flag is off — payload untouched', async () => {
  const originalInput = [
    {
      type: 'additional_tools',
      role: 'developer',
      tools: [{ type: 'function', name: 'spawn_agent', parameters: {}, strict: false }],
    },
    { type: 'message', role: 'user', content: 'hi' },
  ];
  const originalTools = [
    { type: 'namespace', name: 'collab', tools: [{ type: 'function', name: 'foo', parameters: {}, strict: false }] },
  ];
  const input = invocation(
    {
      model: 'gpt-5.6-sol',
      input: originalInput as unknown as CanonicalResponsesPayload['input'],
      tools: originalTools as unknown as CanonicalResponsesPayload['tools'],
    },
    new Set(),
  );

  await withFlattenToolSearchFamily(input, stubCtx, okEvents);

  assertEquals(input.payload.input, originalInput);
  assertEquals(input.payload.tools, originalTools);
});

test('no-op when flag is on but payload carries no tool_search family artifacts', async () => {
  const input = invocation({
    model: 'gpt-5.6-sol',
    input: [{ type: 'message', role: 'user', content: 'hi' }],
    tools: [{ type: 'function', name: 'plain', parameters: {}, strict: false }],
  });
  const originalInput = input.payload.input;
  const originalTools = input.payload.tools;

  await withFlattenToolSearchFamily(input, stubCtx, okEvents);

  // Reference-identity preserved when the interceptor decides there's nothing to change.
  assertEquals(input.payload.input, originalInput);
  assertEquals(input.payload.tools, originalTools);
});
