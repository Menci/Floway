import { describe, it } from 'vitest';

import { completeResponsesEnvelope, wrapResponsesEnvelopeCompletion } from '../../../../src/data-plane/chat/responses/envelope.ts';
import { doneFrame, eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import type { CanonicalResponsesPayload, ResponsesResult, ResponsesStreamEvent } from '@floway-dev/protocols/responses';
import { assertEquals, assertExists } from '@floway-dev/test-utils';

// Every key `ResponseResource.required` lists.
// https://github.com/openresponses/openresponses/blob/92c12d96d7b61d6d15e2214daa5e9c6000ab6e1c/public/openapi/openapi.json#L2691-L2723
const REQUIRED_ENVELOPE_KEYS = [
  'id',
  'object',
  'created_at',
  'completed_at',
  'status',
  'incomplete_details',
  'model',
  'previous_response_id',
  'instructions',
  'output',
  'error',
  'tools',
  'tool_choice',
  'truncation',
  'parallel_tool_calls',
  'text',
  'top_p',
  'presence_penalty',
  'frequency_penalty',
  'top_logprobs',
  'temperature',
  'reasoning',
  'usage',
  'max_output_tokens',
  'max_tool_calls',
  'store',
  'background',
  'service_tier',
  'metadata',
  'safety_identifier',
  'prompt_cache_key',
] as const;

const request = (overrides: Partial<CanonicalResponsesPayload> = {}): CanonicalResponsesPayload => ({
  model: 'gpt-5-mini',
  input: [{ type: 'message', role: 'user', content: 'hi' }],
  ...overrides,
});

const sources = (overrides: Partial<CanonicalResponsesPayload> = {}) => ({
  request: request(overrides),
  createdAt: 1_700_000_000,
  stored: true,
});

// The shape a translated target hands to the client boundary: identity,
// status, output and usage, and nothing else.
const translatedEnvelope = (): ResponsesResult => ({
  id: 'resp_1',
  object: 'response',
  model: 'gpt-4.1',
  output: [],
  status: 'completed',
  error: null,
  incomplete_details: null,
  usage: { input_tokens: 8, output_tokens: 10, total_tokens: 18 },
});

const missingKeys = (envelope: Record<string, unknown>): string[] =>
  REQUIRED_ENVELOPE_KEYS.filter(key => !(key in envelope));

describe('Responses envelope completion', () => {
  it('fills every required key a translated target left out', () => {
    const completed = completeResponsesEnvelope(translatedEnvelope(), sources(), true);
    assertEquals(missingKeys(completed), []);
  });

  it('prefers what the upstream reported over what the client asked for', () => {
    const upstream: ResponsesResult = {
      ...translatedEnvelope(),
      temperature: 0.2,
      top_p: 0.5,
      parallel_tool_calls: false,
      truncation: 'auto',
      metadata: { trace: 'abc' },
      created_at: 1_600_000_000,
    };
    const completed = completeResponsesEnvelope(upstream, sources({ temperature: 1, top_p: 1, truncation: 'disabled' }), true);
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
    const upstream: ResponsesResult = { ...translatedEnvelope(), max_output_tokens: null, instructions: null };
    const completed = completeResponsesEnvelope(upstream, sources({ max_output_tokens: 512, instructions: 'be terse' }), true);
    assertEquals(completed.max_output_tokens, null);
    assertEquals(completed.instructions, null);
  });

  it('resolves past an upstream null on a slot whose schema offers none', () => {
    const upstream: ResponsesResult = {
      ...translatedEnvelope(),
      temperature: null,
      top_p: null,
      truncation: null,
      service_tier: null,
      metadata: null,
    };
    const completed = completeResponsesEnvelope(upstream, sources({ temperature: 0.4 }), true);
    // The client's own value is the next candidate…
    assertEquals(completed.temperature, 0.4);
    // …and the stated default ends the chain when neither side said anything.
    assertEquals(completed.top_p, 1);
    assertEquals(completed.truncation, 'disabled');
    assertEquals(completed.service_tier, 'default');
    assertEquals(completed.metadata, {});
  });

  it('echoes what the client sent in preference to the stated default', () => {
    const completed = completeResponsesEnvelope(translatedEnvelope(), sources({
      temperature: 0.3,
      top_p: 0.9,
      truncation: 'auto',
      background: true,
      top_logprobs: 5,
      presence_penalty: 1.5,
      frequency_penalty: -0.5,
      parallel_tool_calls: false,
      service_tier: 'priority',
      tool_choice: 'required',
      metadata: { run: '7' },
      instructions: 'be terse',
      previous_response_id: 'resp_0',
      prompt_cache_key: 'cache-1',
      safety_identifier: 'user-1',
      max_output_tokens: 512,
      max_tool_calls: 3,
    }), true);
    assertEquals(completed.temperature, 0.3);
    assertEquals(completed.top_p, 0.9);
    assertEquals(completed.truncation, 'auto');
    assertEquals(completed.background, true);
    assertEquals(completed.top_logprobs, 5);
    assertEquals(completed.presence_penalty, 1.5);
    assertEquals(completed.frequency_penalty, -0.5);
    assertEquals(completed.parallel_tool_calls, false);
    assertEquals(completed.service_tier, 'priority');
    assertEquals(completed.tool_choice, 'required');
    assertEquals(completed.metadata, { run: '7' });
    assertEquals(completed.instructions, 'be terse');
    assertEquals(completed.previous_response_id, 'resp_0');
    assertEquals(completed.prompt_cache_key, 'cache-1');
    assertEquals(completed.safety_identifier, 'user-1');
    assertEquals(completed.max_output_tokens, 512);
    assertEquals(completed.max_tool_calls, 3);
  });

  it('states the schema default for a required key neither side supplied', () => {
    const completed = completeResponsesEnvelope(translatedEnvelope(), sources(), true);
    assertEquals(completed.temperature, 1);
    assertEquals(completed.top_p, 1);
    assertEquals(completed.presence_penalty, 0);
    assertEquals(completed.frequency_penalty, 0);
    assertEquals(completed.top_logprobs, 0);
    assertEquals(completed.parallel_tool_calls, true);
    assertEquals(completed.truncation, 'disabled');
    assertEquals(completed.background, false);
    assertEquals(completed.service_tier, 'default');
    assertEquals(completed.tool_choice, 'auto');
    assertEquals(completed.tools, []);
    assertEquals(completed.metadata, {});
    assertEquals(completed.text, { format: { type: 'text' } });
  });

  it('marks an unrequested nullable key absent rather than inventing a value', () => {
    const completed = completeResponsesEnvelope(translatedEnvelope(), sources(), true);
    assertEquals(completed.previous_response_id, null);
    assertEquals(completed.instructions, null);
    assertEquals(completed.reasoning, null);
    assertEquals(completed.max_output_tokens, null);
    assertEquals(completed.max_tool_calls, null);
    assertEquals(completed.safety_identifier, null);
    assertEquals(completed.prompt_cache_key, null);
  });

  it('reports gateway state for created_at and store', () => {
    const completed = completeResponsesEnvelope(translatedEnvelope(), { ...sources({ store: true }), stored: false }, true);
    assertEquals(completed.created_at, 1_700_000_000);
    assertEquals(completed.store, false);
  });

  it('completes both usage breakdowns and reports a missing usage as null', () => {
    const completed = completeResponsesEnvelope(translatedEnvelope(), sources(), true);
    assertEquals(completed.usage, {
      input_tokens: 8,
      output_tokens: 10,
      total_tokens: 18,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens_details: { reasoning_tokens: 0 },
    });

    const { usage: _usage, ...withoutUsage } = translatedEnvelope();
    assertEquals(completeResponsesEnvelope(withoutUsage, sources(), true).usage, null);
  });

  it('keeps a usage breakdown the upstream actually reported', () => {
    const upstream: ResponsesResult = {
      ...translatedEnvelope(),
      usage: { input_tokens: 8, output_tokens: 10, total_tokens: 18, output_tokens_details: { reasoning_tokens: 7 } },
    };
    assertEquals(completeResponsesEnvelope(upstream, sources(), true).usage?.output_tokens_details, { reasoning_tokens: 7 });
  });

  it('completes a reasoning block and a text block to their own required keys', () => {
    const completed = completeResponsesEnvelope(
      translatedEnvelope(),
      sources({ reasoning: { effort: 'high' }, text: { verbosity: 'low' } }),
      true,
    );
    assertEquals(completed.reasoning, { effort: 'high', summary: null });
    assertEquals(completed.text, { verbosity: 'low', format: { type: 'text' } });
  });

  it('completes a minimal echoed function tool to every key the tool schema requires', () => {
    const completed = completeResponsesEnvelope(
      translatedEnvelope(),
      sources({ tools: [{ type: 'function', name: 'lookup' }] }),
      true,
    );
    assertEquals(completed.tools, [{ type: 'function', name: 'lookup', description: null, parameters: null, strict: null }]);
  });

  // The normalizers run on the resolved value, so a tool array the upstream
  // echoed — or one the server-tool shim reconstructed — is completed like any
  // other. Resolving first and normalizing after is what closes that path.
  it('completes a minimal function tool the upstream echoed back', () => {
    const upstream: ResponsesResult = {
      ...translatedEnvelope(),
      tools: [{ type: 'function', name: 'lookup', parameters: { type: 'object' } }],
    };
    const completed = completeResponsesEnvelope(
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

  it('leaves a non-function tool untouched', () => {
    const completed = completeResponsesEnvelope(
      translatedEnvelope(),
      sources({ tools: [{ type: 'web_search' }] }),
      true,
    );
    assertEquals(completed.tools, [{ type: 'web_search' }]);
  });

  it('completes every envelope frame of a stream and reports completed_at only on the terminal one', async () => {
    const source = async function* (): AsyncGenerator<ProtocolFrame<ResponsesStreamEvent>> {
      yield eventFrame({ type: 'response.created', sequence_number: 0, response: { ...translatedEnvelope(), status: 'in_progress' } } as ResponsesStreamEvent);
      yield eventFrame({ type: 'response.output_text.delta', sequence_number: 1, item_id: 'msg_1', output_index: 0, content_index: 0, delta: 'hi' } as ResponsesStreamEvent);
      yield eventFrame({ type: 'response.completed', sequence_number: 2, response: translatedEnvelope() } as ResponsesStreamEvent);
      yield doneFrame();
    };

    const seen: ResponsesStreamEvent[] = [];
    for await (const frame of wrapResponsesEnvelopeCompletion(source(), sources())) {
      if (frame.type === 'event') seen.push(frame.event);
    }

    assertEquals(seen.length, 3);
    const created = seen[0];
    const terminal = seen[2];
    assertExists(created);
    assertExists(terminal);
    if (created.type !== 'response.created' || terminal.type !== 'response.completed') {
      throw new Error('expected the envelope frames to survive completion unchanged in type');
    }
    assertEquals(missingKeys(created.response as unknown as Record<string, unknown>), []);
    assertEquals(missingKeys(terminal.response as unknown as Record<string, unknown>), []);
    assertEquals(created.response.completed_at, null);
    assertEquals(typeof terminal.response.completed_at, 'number');
    // One `created_at` per response, so a client reading any frame sees the
    // same creation time.
    assertEquals(created.response.created_at, terminal.response.created_at);
    // A non-envelope event is forwarded untouched.
    assertEquals(seen[1]?.type, 'response.output_text.delta');
  });
});
