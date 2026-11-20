import { describe, it } from 'vitest';

import { missingRequiredResourceKeys } from './test-required-resource-keys.ts';
import { completeResponseResource, wrapResponseResourceCompletion } from '../../../../src/data-plane/chat/openai-responses/response-resource.ts';
import { doneFrame, eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import type { CanonicalOpenAIResponsesPayload, OpenAIResponsesResultEx, OpenAIResponsesStreamEventEx } from '@floway-dev/protocols/openai-responses';
import { assertEquals, assertExists } from '@floway-dev/test-utils';

const request = (overrides: Partial<CanonicalOpenAIResponsesPayload> = {}): CanonicalOpenAIResponsesPayload => ({
  model: 'gpt-5-mini',
  input: [{ type: 'message', role: 'user', content: 'hi' }],
  ...overrides,
});

const sources = (overrides: Partial<CanonicalOpenAIResponsesPayload> = {}) => ({
  request: request(overrides),
  createdAt: 1_700_000_000,
  stored: true,
});

// The shape a translated target hands to the client boundary: identity,
// status, output and usage, and nothing else.
const translatedResource = (): OpenAIResponsesResultEx => ({
  id: 'resp_1',
  object: 'response',
  model: 'gpt-4.1',
  output: [],
  status: 'completed',
  error: null,
  incomplete_details: null,
  usage: { input_tokens: 8, output_tokens: 10, total_tokens: 18 },
});

describe('OpenAI Responses resource completion', () => {

  it('prefers what the upstream reported over what the client asked for', () => {
    const upstream: OpenAIResponsesResultEx = {
      ...translatedResource(),
      temperature: 0.2,
      top_p: 0.5,
      parallel_tool_calls: false,
      truncation: 'auto',
      metadata: { trace: 'abc' },
      created_at: 1_600_000_000,
    };
    const completed = completeResponseResource(upstream, sources({ temperature: 1, top_p: 1, truncation: 'disabled' }), true);
    assertEquals(completed.temperature, 0.2);
    assertEquals(completed.top_p, 0.5);
    assertEquals(completed.parallel_tool_calls, false);
    assertEquals(completed.truncation, 'auto');
    assertEquals(completed.metadata, { trace: 'abc' });
    // `created_at` is gateway state: only Floway knows when it received the
    // request, so an upstream value never wins there.
    assertEquals(completed.created_at, 1_700_000_000);
  });

  it('keeps an upstream null on a slot whose schema offers null', () => {
    const upstream: OpenAIResponsesResultEx = { ...translatedResource(), max_output_tokens: null, instructions: null };
    const completed = completeResponseResource(upstream, sources({ max_output_tokens: 512, instructions: 'be terse' }), true);
    assertEquals(completed.max_output_tokens, null);
    assertEquals(completed.instructions, null);
  });

  it('resolves past an upstream null on a slot whose schema offers none', () => {
    const upstream: OpenAIResponsesResultEx = {
      ...translatedResource(),
      temperature: null,
      top_p: null,
      truncation: null,
      service_tier: null,
      metadata: null,
    };
    const completed = completeResponseResource(upstream, sources({ temperature: 0.4 }), true);
    // The client's own value is the next candidate…
    assertEquals(completed.temperature, 0.4);
    // …and the stated default ends the chain when neither side said anything.
    assertEquals(completed.top_p, 1);
    assertEquals(completed.truncation, 'disabled');
    assertEquals(completed.service_tier, 'default');
    assertEquals(completed.metadata, {});
  });

  it('completes both usage breakdowns and reports a missing usage as null', () => {
    const completed = completeResponseResource(translatedResource(), sources(), true);
    assertEquals(completed.usage, {
      input_tokens: 8,
      output_tokens: 10,
      total_tokens: 18,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens_details: { reasoning_tokens: 0 },
    });

    const { usage: _usage, ...withoutUsage } = translatedResource();
    assertEquals(completeResponseResource(withoutUsage, sources(), true).usage, null);
  });

  // The normalizers run on the resolved value, so a tool array the upstream
  // echoed — or one the hosted-tool shim reconstructed — is completed like any
  // other. Resolving first and normalizing after is what closes that path.
  it('completes a minimal function tool the upstream echoed back', () => {
    const upstream: OpenAIResponsesResultEx = {
      ...translatedResource(),
      tools: [{ type: 'function', name: 'lookup', parameters: { type: 'object' } }],
    };
    const completed = completeResponseResource(
      upstream,
      sources({ tools: [{ type: 'function', name: 'lookup', parameters: { type: 'object' }, strict: true, description: 'ignored' }] }),
      true,
    );
    assertEquals(completed.tools, [{
      type: 'function',
      name: 'lookup',
      parameters: { type: 'object' },
      description: null,
      strict: null,
    }]);
  });

  it('completes every resource-bearing frame of a stream and reports completed_at only on the terminal one', async () => {
    const source = async function* (): AsyncGenerator<ProtocolFrame<OpenAIResponsesStreamEventEx>> {
      yield eventFrame({ type: 'response.created', sequence_number: 0, response: { ...translatedResource(), status: 'in_progress' } } as OpenAIResponsesStreamEventEx);
      yield eventFrame({ type: 'response.output_text.delta', sequence_number: 1, item_id: 'msg_1', output_index: 0, content_index: 0, delta: 'hi' } as OpenAIResponsesStreamEventEx);
      yield eventFrame({ type: 'response.completed', sequence_number: 2, response: translatedResource() } as OpenAIResponsesStreamEventEx);
      yield doneFrame();
    };

    const seen: OpenAIResponsesStreamEventEx[] = [];
    for await (const frame of wrapResponseResourceCompletion(source(), sources())) {
      if (frame.type === 'event') seen.push(frame.event);
    }

    assertEquals(seen.length, 3);
    const created = seen[0];
    const terminal = seen[2];
    assertExists(created);
    assertExists(terminal);
    if (created.type !== 'response.created' || terminal.type !== 'response.completed') {
      throw new Error('expected the resource-bearing frames to survive completion unchanged in type');
    }
    assertEquals(missingRequiredResourceKeys(created.response as unknown as Record<string, unknown>), []);
    assertEquals(missingRequiredResourceKeys(terminal.response as unknown as Record<string, unknown>), []);
    assertEquals(created.response.completed_at, null);
    assertEquals(typeof terminal.response.completed_at, 'number');
    // One `created_at` per response, so a client reading any frame sees the
    // same creation time.
    assertEquals(created.response.created_at, terminal.response.created_at);
    // An event that carries no response resource is forwarded untouched.
    assertEquals(seen[1]?.type, 'response.output_text.delta');
  });
});
