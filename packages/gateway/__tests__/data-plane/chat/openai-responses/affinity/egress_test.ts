import { describe, expect, test, vi } from 'vitest';

import { wrapOpenAIResponsesAffinityEgress } from '../../../../../src/data-plane/chat/openai-responses/affinity/egress.ts';
import type { AffinityCodec, AffinityIdentity } from '../../../../../src/data-plane/chat/shared/affinity/index.ts';
import { encodeBase64UrlJson } from '../../../../../src/shared/base64url-json.ts';
import { eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import type { OpenAIResponsesOutputItemEx, OpenAIResponsesOutputReasoning, OpenAIResponsesResultEx, OpenAIResponsesStreamEventEx } from '@floway-dev/protocols/openai-responses';

const affinity: AffinityIdentity = {
  upstreamId: 'up-a',
  modelId: 'model-a',
  opaqueBlobCompatibilityIdentity: { upstreamId: 'up-a', key: 'model-a' },
};
type AffinityEgressCodec = Pick<AffinityCodec, 'wrap'>;
const frames = async function* (values: ProtocolFrame<OpenAIResponsesStreamEventEx>[]) { yield* values; };
const codec: AffinityEgressCodec = { wrap: async value => `wrapped:${value}` };
const response = (output: OpenAIResponsesResultEx['output'], status: OpenAIResponsesResultEx['status'] = 'completed'): OpenAIResponsesResultEx => ({
  id: 'resp_1', object: 'response', model: 'model-a', output, status, error: null, incomplete_details: null,
});
const collect = async (values: ProtocolFrame<OpenAIResponsesStreamEventEx>[]) => {
  const output = [];
  for await (const frame of wrapOpenAIResponsesAffinityEgress(frames(values), { codec, affinity })) output.push(frame);
  return output;
};

describe('OpenAI Responses affinity egress', () => {
  test('wraps existing encrypted output in a queued snapshot', async () => {
    const item: OpenAIResponsesOutputReasoning = { type: 'reasoning', id: 'rs_queued', summary: [], encrypted_content: 'opaque' };
    expect(await collect([eventFrame({ type: 'response.queued', response: response([item], 'queued') })])).toEqual([
      eventFrame({ type: 'response.queued', response: response([{ ...item, encrypted_content: 'wrapped:opaque' }], 'queued') }),
    ]);
  });

  test('streams visible reasoning before wrapping and reuses ciphertext across item and terminal snapshots', async () => {
    const calls: Array<{ value: string | undefined; resolve: (value: string) => void }> = [];
    const delayed: AffinityEgressCodec = { wrap: value => new Promise(resolve => calls.push({ value, resolve })) };
    const item: OpenAIResponsesOutputReasoning = { type: 'reasoning', id: 'rs_1', summary: [{ type: 'summary_text', text: 'visible' }], encrypted_content: 'opaque' };
    const output = wrapOpenAIResponsesAffinityEgress(frames([
      eventFrame({ type: 'response.reasoning_summary_text.delta', item_id: 'rs_1', output_index: 0, summary_index: 0, delta: 'visible' }),
      eventFrame({ type: 'response.output_item.done', output_index: 0, item }),
      eventFrame({ type: 'response.completed', response: response([item]) }),
    ]), { codec: delayed, affinity });
    expect((await output.next()).value).toMatchObject({ event: { output_index: 0, delta: 'visible' } });
    expect(calls).toHaveLength(0);
    const pending = output.next();
    await vi.waitFor(() => expect(calls.map(call => call.value)).toEqual(['opaque']));
    calls[0].resolve('wrapped:opaque');
    expect((await pending).value).toMatchObject({ event: { item: { encrypted_content: 'wrapped:opaque' } } });
    expect((await output.next()).value).toMatchObject({ event: { response: { output: [{ encrypted_content: 'wrapped:opaque' }] } } });
    expect(calls).toHaveLength(1);
  });

  test.each(['response.completed', 'response.incomplete', 'response.failed'] as const)('preserves unsigned output items, indices and sequence numbers through %s', async terminal => {
    const message = { type: 'message' as const, id: 'msg_1', role: 'assistant' as const, status: 'completed' as const, content: [{ type: 'output_text' as const, text: 'answer', annotations: [] }] };
    const reasoning: OpenAIResponsesOutputReasoning = { type: 'reasoning', id: 'rs_empty', summary: [], encrypted_content: '' };
    const values: ProtocolFrame<OpenAIResponsesStreamEventEx>[] = [
      eventFrame({ type: 'response.output_item.added', output_index: 0, item: message, sequence_number: 2 }),
      eventFrame({ type: 'response.output_text.delta', item_id: 'msg_1', output_index: 0, content_index: 0, delta: 'answer', sequence_number: 3 }),
      eventFrame({ type: 'response.output_item.done', output_index: 0, item: message, sequence_number: 4 }),
      eventFrame({ type: terminal, response: response([message, reasoning], terminal === 'response.completed' ? 'completed' : terminal === 'response.failed' ? 'failed' : 'incomplete'), sequence_number: 5 }),
    ];
    const wrap = vi.fn(codec.wrap);
    const output = [];
    for await (const frame of wrapOpenAIResponsesAffinityEgress(frames(values), { codec: { wrap }, affinity })) output.push(frame);
    expect(output).toEqual(values);
    expect(wrap).not.toHaveBeenCalled();
  });

  test('wraps program fingerprints and nested encrypted agent content without changing other fields', async () => {
    const program = { type: 'program' as const, id: 'prog_1', call_id: 'call_1', code: 'return 1', fingerprint: 'program-opaque' };
    const agent = { type: 'agent_message' as const, id: 'agent_1', author: 'a', recipient: 'b', content: [{ type: 'input_text' as const, text: 'visible' }, { type: 'encrypted_content' as const, encrypted_content: 'agent-opaque' }] };
    const original = structuredClone([program, agent]);
    const wrap = vi.fn(codec.wrap);
    const output = [];
    for await (const frame of wrapOpenAIResponsesAffinityEgress(frames([eventFrame({ type: 'response.completed', response: response([program, agent]) })]), { codec: { wrap }, affinity })) output.push(frame);
    expect(output).toEqual([eventFrame({
      type: 'response.completed',
      response: response([
        { ...program, fingerprint: 'wrapped:program-opaque' },
        { ...agent, content: [agent.content[0], { type: 'encrypted_content', encrypted_content: 'wrapped:agent-opaque' }] },
      ]),
    })]);
    expect([program, agent]).toEqual(original);
    expect(wrap.mock.calls.map(call => call[2])).toEqual(['openai-responses.program.fingerprint', 'openai-responses.agent_message.content.1.encrypted_content']);
  });

  test('keeps gateway-owned compaction content portable without an extra carrier', async () => {
    const encrypted_content = encodeBase64UrlJson([{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'portable summary' }] }]);
    const item = { type: 'compaction' as const, id: 'cmp_shim', encrypted_content };
    const input = eventFrame<OpenAIResponsesStreamEventEx>({ type: 'response.completed', response: response([item]) });
    expect(await collect([input])).toEqual([input]);
  });

  test.each(['compaction', 'compaction_summary', 'context_compaction'])('wraps an existing %s ciphertext with its canonical affinity domain', async type => {
    const item = { type, id: 'cmp_upstream', encrypted_content: 'opaque' } as OpenAIResponsesOutputItemEx;
    const wrap = vi.fn(codec.wrap);
    const output = [];
    for await (const frame of wrapOpenAIResponsesAffinityEgress(frames([eventFrame({ type: 'response.completed', response: response([item]) })]), { codec: { wrap }, affinity })) output.push(frame);
    expect(output).toEqual([eventFrame({ type: 'response.completed', response: response([{ ...item, encrypted_content: 'wrapped:opaque' } as OpenAIResponsesOutputItemEx]) })]);
    expect(wrap).toHaveBeenCalledExactlyOnceWith('opaque', affinity, 'openai-responses.compaction.encrypted_content');
  });
});
