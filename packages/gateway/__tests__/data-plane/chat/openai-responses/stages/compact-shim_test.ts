import { test, vi } from 'vitest';

import { SUMMARY_PREFIX, compactShim, expandShimCompactionItems } from '../../../../../src/data-plane/chat/openai-responses/stages/compact-shim.ts';
import { encodeBase64UrlJson } from '../../../../../src/shared/base64url-json.ts';
import { createManagedProtocolFrames, runChatStage, stubRouteCandidate } from '../../../../test-utils/chat-pipeline.ts';
import type { CanonicalOpenAIResponsesInputItem, CanonicalOpenAIResponsesPayload, OpenAIResponsesCompactionItemEx, OpenAIResponsesResultEx, OpenAIResponsesStreamEventEx } from '@floway-dev/protocols/openai-responses';
import { collectOpenAIResponsesProtocolEventsToResult } from '@floway-dev/protocols/openai-responses';
import type { FlagId, RouteCandidate } from '@floway-dev/provider';
import { assertEquals, testTelemetryModelIdentity } from '@floway-dev/test-utils';

const response = (summary: string, status: OpenAIResponsesResultEx['status'] = 'completed'): OpenAIResponsesResultEx => ({
  id: 'resp_upstream', object: 'response', model: 'upstream-model', status,
  output: [{ type: 'message', id: 'msg_1', role: 'assistant', status, content: [{ type: 'output_text', text: summary, annotations: [] }] }],
  error: null, incomplete_details: status === 'incomplete' ? { reason: 'max_output_tokens' } : null,
  usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 },
});

const upstreamEvents = (result: OpenAIResponsesResultEx): OpenAIResponsesStreamEventEx[] => [
  { type: 'response.output_item.added', sequence_number: 0, output_index: 0, item: result.output[0]! },
  { type: 'response.output_item.done', sequence_number: 1, output_index: 0, item: result.output[0]! },
  { type: 'response.completed', sequence_number: 2, response: result },
];

const candidate = (flags: Iterable<FlagId>): RouteCandidate => stubRouteCandidate({ enabledFlags: flags, endpoints: { openaiResponses: {} } });

const invoke = async (options: {
  payload: CanonicalOpenAIResponsesPayload;
  action: 'generate' | 'compact';
  flags: Iterable<FlagId>;
  run: (payload: CanonicalOpenAIResponsesPayload, action: 'generate' | 'compact', env: Parameters<Parameters<typeof runChatStage>[0]['next']>[1]) => ReturnType<Parameters<typeof runChatStage>[0]['next']>;
}) => await (await (runChatStage as any)({
  stage: compactShim,
  facts: { 'route.candidate': candidate(options.flags), 'request.payload': options.payload, 'request.action': options.action, 'route.targetApi': 'openaiResponses' },
  next: (facts: { readonly 'request.payload': CanonicalOpenAIResponsesPayload; readonly 'request.action': 'generate' | 'compact' }, env: Parameters<Parameters<typeof runChatStage>[0]['next']>[1]) => options.run(facts['request.payload'], facts['request.action'], env),
}) as Promise<{ outcome: import('../../../../../src/data-plane/chat/pipeline/index.ts').ChatAttemptOutcome<import('@floway-dev/protocols/openai-responses').OpenAIResponsesStreamEventEx>; services: import('../../../../../src/data-plane/chat/pipeline/index.ts').ChatPipelineServices }>);

const flags = (input: { shim?: boolean; decrypt?: boolean } = {}) => [
  ...(input.shim === false ? [] : ['openai-responses-compact-shim' as const]),
  ...(input.decrypt === true ? ['openai-responses-compact-decrypt' as const] : []),
];

test('foreign compaction blobs round-trip untouched', () => {
  const payload = { model: 'm', input: [{ type: 'compaction', id: 'cmp', encrypted_content: 'OPAQUE' }] } as CanonicalOpenAIResponsesPayload;
  assertEquals(expandShimCompactionItems(payload), payload);
});

test('cache-sharing compaction appends one user prompt and synthesizes a portable envelope', async () => {
  let seen: { payload: CanonicalOpenAIResponsesPayload; action: 'generate' | 'compact' } | undefined;
  const { outcome } = await invoke({
    payload: { model: 'm', input: [{ type: 'message', role: 'user', content: 'history' }] }, action: 'compact', flags: flags(),
    run: (payload, action, env) => {
      seen = { payload, action };
      return { type: 'events', events: createManagedProtocolFrames(env, upstreamEvents(response('CONDENSED SUMMARY'))), modelIdentity: testTelemetryModelIdentity };
    },
  });
  assertEquals(seen?.action, 'generate');
  assertEquals(seen?.payload.store, false);
  assertEquals(seen?.payload.input.map(item => item.type), ['message', 'message']);
  if (outcome.type !== 'events') throw new Error('expected events');
  const collected = await collectOpenAIResponsesProtocolEventsToResult(outcome.events);
  assertEquals(collected.object, 'response.compaction');
  const compaction = collected.output[0] as OpenAIResponsesCompactionItemEx;
  assertEquals(expandShimCompactionItems({ model: 'm', input: [compaction as unknown as CanonicalOpenAIResponsesInputItem] }).input, [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: `${SUMMARY_PREFIX}\nCONDENSED SUMMARY` }] }]);
});

test('textless cache-sharing output retries with the legacy prompt and combines ledger usage', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const inputs: CanonicalOpenAIResponsesInputItem[][] = [];
  let call = 0;
  const { outcome, services } = await invoke({
    payload: { model: 'm', input: [{ type: 'message', role: 'user', content: 'history' }], tools: [{ type: 'function', name: 'read', parameters: null, strict: null }] }, action: 'compact', flags: flags(),
    run: (payload, _action, env) => {
      inputs.push([...payload.input]);
      call += 1;
      const usageId = env.usageLedger.register({ modelIdentity: testTelemetryModelIdentity });
      env.usageLedger.updateBillableUsage(usageId, { input: 10, cacheRead: call === 1 ? 8 : 0, cacheWrite: 0, cacheWrite1h: 0, output: 20 });
      return { type: 'events', events: createManagedProtocolFrames(env, upstreamEvents(response(call === 1 ? '   ' : 'LEGACY SUMMARY'))), modelIdentity: testTelemetryModelIdentity, usageId };
    },
  });
  warn.mockRestore();
  assertEquals(call, 2);
  assertEquals(inputs[1]?.map(item => item.type), ['message', 'message', 'message']);
  assertEquals(inputs[1]?.[0]?.type === 'message' ? inputs[1][0].role : undefined, 'system');
  if (outcome.type !== 'events' || outcome.usageId === undefined) throw new Error('expected ledger-backed events');
  const collected = await collectOpenAIResponsesProtocolEventsToResult(outcome.events);
  assertEquals(collected.usage, { input_tokens: 20, output_tokens: 40, total_tokens: 60 });
  assertEquals(services.usageLedger.read(outcome.usageId, outcome).billableUsage, { input: 20, cacheRead: 8, cacheWrite: 0, cacheWrite1h: 0, output: 40 });
});

test('incomplete status propagates onto the synthesized envelope', async () => {
  const { outcome } = await invoke({
    payload: { model: 'm', input: [{ type: 'message', role: 'user', content: 'history' }] }, action: 'compact', flags: flags(),
    run: (_payload, _action, env) => ({ type: 'events', events: createManagedProtocolFrames(env, upstreamEvents(response('partial', 'incomplete'))), modelIdentity: testTelemetryModelIdentity }),
  });
  if (outcome.type !== 'events') throw new Error('expected events');
  const collected = await collectOpenAIResponsesProtocolEventsToResult(outcome.events);
  assertEquals(collected.status, 'incomplete');
  assertEquals(collected.incomplete_details, { reason: 'max_output_tokens' });
});

test('native decryption replays each opaque compaction item and sums ledger usage', async () => {
  const native: OpenAIResponsesResultEx = {
    ...response('ignored'), object: 'response.compaction',
    output: [
      { type: 'compaction', id: 'cmp_1', encrypted_content: 'OPAQUE_1' },
      { type: 'compaction_summary', id: 'cmp_2', encrypted_content: 'OPAQUE_2' },
    ],
    usage: { input_tokens: 100, output_tokens: 40, total_tokens: 140 },
  };
  let call = 0;
  const seenActions: string[] = [];
  const { outcome, services } = await invoke({
    payload: { model: 'm', input: [{ type: 'message', role: 'user', content: 'compact' }] }, action: 'compact', flags: flags({ shim: false, decrypt: true }),
    run: (payload, action, env) => {
      seenActions.push(action);
      call += 1;
      const usageId = env.usageLedger.register({ modelIdentity: testTelemetryModelIdentity });
      env.usageLedger.updateBillableUsage(usageId, call === 1 ? { input: 100, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, output: 40 } : { input: 10, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, output: 20 });
      if (call === 1) return { type: 'events', events: createManagedProtocolFrames(env, upstreamEvents(native)), modelIdentity: testTelemetryModelIdentity, usageId };
      assertEquals(payload.store, false);
      assertEquals(payload.input.map(item => item.type), ['message', call === 2 ? 'compaction' : 'compaction_summary', 'message']);
      return { type: 'events', events: createManagedProtocolFrames(env, upstreamEvents(response(`SUMMARY ${call - 1}`))), modelIdentity: testTelemetryModelIdentity, usageId };
    },
  });
  assertEquals(seenActions, ['compact', 'generate', 'generate']);
  if (outcome.type !== 'events' || outcome.usageId === undefined) throw new Error('expected events');
  const collected = await collectOpenAIResponsesProtocolEventsToResult(outcome.events);
  assertEquals(collected.output.map(item => item.type), ['compaction', 'compaction_summary']);
  assertEquals(collected.usage, { input_tokens: 120, output_tokens: 80, total_tokens: 200 });
  assertEquals(services.usageLedger.read(outcome.usageId, outcome).billableUsage, { input: 120, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, output: 80 });
});

test('gateway-owned compaction items expand even when the shim is disabled', async () => {
  const encoded = encodeBase64UrlJson([{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'recovered' }] }]);
  let seen: CanonicalOpenAIResponsesPayload | undefined;
  await invoke({
    payload: { model: 'm', input: [{ type: 'compaction', id: 'cmp', encrypted_content: encoded } as never] }, action: 'generate', flags: flags({ shim: false }),
    run: (payload, _action, env) => {
      seen = payload;
      return { type: 'events', events: createManagedProtocolFrames(env, upstreamEvents(response('done'))), modelIdentity: testTelemetryModelIdentity };
    },
  });
  assertEquals(seen?.input, [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'recovered' }] }]);
});
