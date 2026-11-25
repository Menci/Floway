import { expect, test } from 'vitest';

import { collectOpenAIChatCompletions, collectOpenAIChatCompletionsStreamError, encodeOpenAIChatCompletions } from '../../../../src/data-plane/chat/openai-chat-completions/encode.ts';
import { applyRoleCompatibility } from '../../../../src/data-plane/chat/openai-chat-completions/interceptors/apply-role-compatibility.ts';
import { disableReasoningOnForcedToolChoice } from '../../../../src/data-plane/chat/openai-chat-completions/interceptors/disable-reasoning-on-forced-tool-choice.ts';
import { includeUsageStreamOptions } from '../../../../src/data-plane/chat/openai-chat-completions/interceptors/include-usage-stream-options.ts';
import { normalizeEmptyToolsToolChoice } from '../../../../src/data-plane/chat/openai-chat-completions/interceptors/normalize-empty-tools-tool-choice.ts';
import { normalizeExclusiveCachedTokens } from '../../../../src/data-plane/chat/openai-chat-completions/interceptors/normalize-exclusive-cached-tokens.ts';
import { normalizeUsage } from '../../../../src/data-plane/chat/openai-chat-completions/interceptors/normalize-usage.ts';
import { stripPromptCacheKey } from '../../../../src/data-plane/chat/openai-chat-completions/interceptors/strip-prompt-cache-key.ts';
import { parseOpenAIChatCompletions, type OpenAIChatCompletionsDelivery } from '../../../../src/data-plane/chat/openai-chat-completions/parse.ts';
import { collectChat } from '../../../../src/data-plane/chat/shared/collect.ts';
import { localResponseHead } from '../../../../src/data-plane/pipeline/encode.ts';
import type { GatewayPipelineFacts } from '../../../../src/data-plane/pipeline/facts.ts';
import type { GatewayServices } from '../../../../src/data-plane/pipeline/services.ts';
import { stubChatCandidate } from '../shared/affinity/helpers.ts';
import { factSpace, run, type Result } from '@floway-dev/pipeline';
import type { OpenAIChatCompletionsPayloadEx, OpenAIChatCompletionsStreamEvent } from '@floway-dev/protocols/openai-chat-completions';
import type { FlagId, ProtocolStreamError } from '@floway-dev/provider';

type Frame = Result<OpenAIChatCompletionsStreamEvent, ProtocolStreamError>;
type Request = Omit<Partial<OpenAIChatCompletionsPayloadEx>, 'user'> & { user?: null };

const { compose, defineStage } = factSpace<GatewayPipelineFacts & { 'request.delivery': OpenAIChatCompletionsDelivery }, GatewayServices>();
const usage = { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 };
const chunk: OpenAIChatCompletionsStreamEvent = {
  id: 'chatcmpl_test', model: 'test-model', created: 1, object: 'chat.completion.chunk',
  choices: [{ index: 0, delta: { content: 'hello' }, finish_reason: null }],
  usage,
};

const serve = async (
  request: Request,
  frames: readonly Frame[] = [{ ok: true, value: chunk }],
  flags: readonly FlagId[] = [],
) => {
  let upstreamRequest: OpenAIChatCompletionsPayloadEx | undefined;
  let delivery: OpenAIChatCompletionsDelivery | undefined;
  const ending = defineStage({
    name: 'chat-completions-upstream',
    request: { needs: ['request.openaiChatCompletions', 'request.delivery'] },
    return: { provides: ['response.http', 'response.openaiChatCompletions'] },
    async execute(facts, scope) {
      upstreamRequest = facts['request.openaiChatCompletions'];
      delivery = facts['request.delivery'];
      return {
        'response.http': { ...localResponseHead(200), body: null },
        'response.openaiChatCompletions': { kind: 'stream', stream: scope.createStream(async function* () { yield* frames; }) },
      };
    },
  });
  const pipeline = compose('openai-chat-completions-test', {
    entry: ['request.http', 'provider.model', 'provider.upstream'],
    exit: ['response.http'],
    stages: [
      parseOpenAIChatCompletions, encodeOpenAIChatCompletions,
      collectChat('openaiChatCompletions', collectOpenAIChatCompletions, collectOpenAIChatCompletionsStreamError),
      includeUsageStreamOptions, disableReasoningOnForcedToolChoice, normalizeEmptyToolsToolChoice,
      applyRoleCompatibility, stripPromptCacheKey, normalizeUsage, normalizeExclusiveCachedTokens,
    ],
    ending,
  });
  const candidate = stubChatCandidate({ model: { enabledFlags: new Set(flags) } });
  const running = run(pipeline, {
    'provider.model': candidate.model,
    'provider.upstream': candidate.upstream,
    'request.http': {
      url: 'https://floway.test/v1/chat/completions',
      method: 'POST',
      headers: [],
      body: new TextEncoder().encode(JSON.stringify({ model: 'test-model', messages: [{ role: 'user', content: 'hi' }], ...request })),
    },
  }, { services: {} as GatewayServices, signal: new AbortController().signal, waitUntil: () => {} });
  const response = (await running.result)['response.http']!;
  const decoder = new TextDecoder();
  let body = '';
  if (response.body instanceof Uint8Array) body = decoder.decode(response.body);
  else if (response.body !== null) {
    for await (const item of running.read(response.body)) {
      if (!item.ok) throw new Error('Expected encoded body bytes', { cause: item.error.cause });
      body += decoder.decode(item.value, { stream: true });
    }
    body += decoder.decode();
  }
  await running.done;
  return { response, body, upstreamRequest, delivery };
};

test.each([false, true])('normal EOF succeeds with a partial choice and an upstream usage chunk (includeUsage=%s)', async includeUsage => {
  const { response, body, delivery, upstreamRequest } = await serve({ stream: true, n: 2, stream_options: { include_usage: includeUsage } });
  expect(response.status).toBe(200);
  expect(response.headers).toContainEqual(['x-accel-buffering', 'no']);
  expect(delivery).toEqual({ stream: true, includeUsageChunk: includeUsage, expectedChoices: 2 });
  expect(upstreamRequest?.stream_options?.include_usage).toBe(true);
  expect(body).toContain('hello');
  expect(body.includes('"choices":[],"usage"')).toBe(includeUsage);
  expect(body).toMatch(/data: \[DONE\]\n\n$/);
});

test('non-streaming reassembly retains usage regardless of SSE preference', async () => {
  const { body, delivery } = await serve({});
  expect(delivery).toEqual({ stream: false, includeUsageChunk: false, expectedChoices: 1 });
  expect(JSON.parse(body)).toMatchObject({ choices: [{ message: { content: 'hello' } }], usage });
});

test('a stream error emits a single upstream error and omits the success trailer', async () => {
  const event = { error: { type: 'overloaded', message: 'busy' } };
  const error = { kind: 'protocol', cause: new Error('busy'), event } as const;
  const { body } = await serve({ stream: true }, [{ ok: true, value: chunk }, { ok: false, error }]);
  expect(body).toContain('hello');
  expect(body.match(/"overloaded"/g)).toHaveLength(1);
  expect(body).not.toContain('[DONE]');
});

test('a transport read failure retains the original error chain when collecting JSON', async () => {
  const cause = new TypeError('nested');
  const error: ProtocolStreamError = { kind: 'transport', cause: new Error('broken', { cause }) };
  const { body, response } = await serve({}, [{ ok: false, error }]);
  expect(response.status).toBe(502);
  expect(JSON.parse(body)).toMatchObject({
    error: {
      message: 'broken',
      provider_specific_fields: { cause: { name: 'TypeError', message: 'nested' } },
    },
  });
});

test('a null user is rejected before the upstream stage', async () => {
  const { body, response, upstreamRequest } = await serve({ user: null });
  expect(response.status).toBe(400);
  expect(JSON.parse(body)).toMatchObject({ error: { param: 'user', code: null, type: 'invalid_request_error' } });
  expect(upstreamRequest).toBeUndefined();
});

test('ordered shaping preserves stream options, disables reasoning, and applies role and cache-key flags', async () => {
  const { upstreamRequest } = await serve({
    messages: [{ role: 'system', content: 'instructions' }, { role: 'user', content: 'hi' }],
    tool_choice: 'required',
    tools: [],
    reasoning_effort: 'high',
    prompt_cache_key: 'client-cache-key',
    stream_options: { include_usage: false, include_obfuscation: false },
  }, undefined, ['disable-reasoning-on-forced-tool-choice', 'empty-tools-tool-choice-none', 'rewrite-system-to-developer', 'strip-prompt-cache-key']);
  expect(upstreamRequest).toMatchObject({
    messages: [{ role: 'developer', content: 'instructions' }, { role: 'user', content: 'hi' }],
    tool_choice: 'none',
    reasoning_effort: 'none',
    stream_options: { include_usage: true, include_obfuscation: false },
  });
  expect(upstreamRequest).not.toHaveProperty('prompt_cache_key');
});

test('exclusive cached-token totals are normalized before the carrier is split', async () => {
  const { body } = await serve({}, [{
    ok: true, value: {
      ...chunk,
      usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 7, prompt_tokens_details: { cached_tokens: 4 } },
    },
  }]);
  expect(JSON.parse(body)).toMatchObject({ usage: { prompt_tokens: 6, completion_tokens: 1, total_tokens: 7, prompt_tokens_details: { cached_tokens: 4 } } });
});
