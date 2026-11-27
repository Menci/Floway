import { expect, test } from 'vitest';

import { kimiCodePipelines, kimiCodeUpstreamModule } from '../../src/index.ts';
import { config, rawModel, record, speedCatalog } from '../fixtures.ts';
import { asEntry, run } from '@floway-dev/pipeline';
import { priceRequest } from '@floway-dev/protocols/common';
import { toUpstreamModelSnapshot, toUpstreamSnapshot, type FetchInit, type Fetcher } from '@floway-dev/upstream';

const upstream = record();
const http = { method: 'POST', url: 'https://floway.test', body: null, headers: [] };
const factsFor = async (id: string, catalog = speedCatalog()) => {
  const models = await kimiCodeUpstreamModule.getModels(upstream, async url => {
    expect(url).toBe('https://api.kimi.com/coding/v1/models');
    return Response.json({ data: catalog });
  });
  const model = models.find(model => model.id === id);
  if (model === undefined) throw new Error(`Fixture catalog has no ${id}`);
  return { http, model: toUpstreamModelSnapshot(model), upstream: toUpstreamSnapshot(upstream) };
};
const optionsFor = (fetcher: Fetcher) => ({
  services: { fetcher: () => fetcher, kimiCode: { refreshProbes: async () => {} } },
  signal: new AbortController().signal,
  waitUntil: (work: Promise<unknown>) => { void work.catch(() => {}); },
});
const sse = (body: string) => new Response(body, { headers: { 'content-type': 'text/event-stream', 'x-upstream': 'kept' } });
const messages = 'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":1,"output_tokens":0}}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n';
const jsonBody = (init: FetchInit): unknown => {
  if (typeof init.body !== 'string') throw new Error('Expected Kimi Code JSON');
  return JSON.parse(init.body);
};
const unexpectedDial = async () => { throw new Error('Unexpected dial'); };

for (const protocol of ['chat', 'responses'] as const) {
  test.each([
    ['kimi-k3.1-pro', 'fast', 'k3.1-pro-highspeed', 'priority'],
    ['kimi-k3', 'priority', 'k3', 'default'],
    ['kimi-k3.1-pro', 'future-tier', 'k3.1-pro', 'future-tier'],
  ])(`${protocol} selects %s at %s using %s and reports %s`, async (id, tier, wireModel, wireTier) => {
    const facts = await factsFor(id);
    const path = protocol === 'chat' ? 'chat/completions' : 'responses';
    const upstreamTier = tier === 'future-tier' ? tier : 'default';
    const options = optionsFor(async (url, init) => {
      expect(url).toBe(`https://api.kimi.com/coding/v1/${path}`);
      expect(new Headers(init.headers).get('authorization')).toBe(`Bearer ${config.apiKey}`);
      expect(jsonBody(init)).toMatchObject({ model: wireModel, stream: true, service_tier: wireTier, vendor_extension: 'kept' });
      if (protocol === 'chat') {
        return sse(`data: ${JSON.stringify({ model: wireModel, choices: [], service_tier: upstreamTier })}\n\ndata: [DONE]\n\n`);
      }
      const completed = { type: 'response.completed', response: { id: 'turn', model: wireModel, service_tier: upstreamTier, status: 'completed', output: [] } };
      return sse(`event: response.completed\ndata: ${JSON.stringify(completed)}\n\n`);
    });
    const request = { model: id, service_tier: tier, vendor_extension: 'kept' };
    if (protocol === 'chat') {
      const execution = run(asEntry(kimiCodePipelines.openaiChatCompletions), { ...facts, openaiChatCompletions: { ...request, messages: [] } }, options);
      const answer = await execution.result;
      expect(answer.usageModelKey ?? facts.model.upstreamModelId).toBe(wireModel);
      expect(answer.http?.headers).toContainEqual(['x-upstream', 'kept']);
      if (answer.openaiChatCompletions.kind !== 'stream') throw new Error('Expected Chat Completions stream');
      const events = await Array.fromAsync(execution.read(answer.openaiChatCompletions.stream));
      expect(events).toEqual([{ ok: true, value: expect.objectContaining({ model: wireModel, service_tier: wireTier }) }]);
    } else {
      const execution = run(asEntry(kimiCodePipelines.openaiResponses), { ...facts, openaiResponses: { ...request, input: [] } }, options);
      const answer = await execution.result;
      expect(answer.usageModelKey ?? facts.model.upstreamModelId).toBe(wireModel);
      expect(answer.http?.headers).toContainEqual(['x-upstream', 'kept']);
      if (answer.openaiResponses.kind !== 'stream') throw new Error('Expected Responses stream');
      const events = await Array.fromAsync(execution.read(answer.openaiResponses.stream));
      expect(events.at(-1)).toMatchObject({ ok: true, value: { type: 'response.completed', response: { model: wireModel, service_tier: wireTier } } });
    }
    if (wireTier === 'priority') {
      expect(priceRequest(facts.model.pricing!, { serviceTier: wireTier }).rates?.input_tokens).toBe('0.000004');
    }
  });
}

test.each([
  ['fast', 'k3.1-pro-highspeed'],
  ['future-speed', 'k3.1-pro'],
])('Messages selects the requested %s lane (%s)', async (speed, wireModel) => {
  const facts = await factsFor('kimi-k3.1-pro');
  const request = { model: facts.model.id, messages: [], max_tokens: 64, speed, vendor_extension: 'kept' };
  const execution = run(asEntry(kimiCodePipelines.anthropicMessages), {
    ...facts, anthropicMessages: request,
  }, optionsFor(async (_url, init) => {
    const body = jsonBody(init);
    expect(body).toMatchObject({ model: wireModel, stream: true, vendor_extension: 'kept' });
    if (speed === 'fast') expect(body).not.toHaveProperty('speed');
    else expect(body).toMatchObject({ speed });
    return sse(messages);
  }));
  const answer = await execution.result;
  expect(answer.usageModelKey ?? facts.model.upstreamModelId).toBe(wireModel);
  if (answer.anthropicMessages.kind !== 'stream') throw new Error('Expected Messages stream');
  const events = await Array.fromAsync(execution.read(answer.anthropicMessages.stream));
  expect(events.at(-1)).toMatchObject({ ok: true, value: { type: 'message_stop' } });
  const start = events[0];
  if (!start?.ok || start.value.type !== 'message_start') throw new Error('Expected message_start');
  if (speed === 'fast') {
    expect(start.value.message.usage.speed).toBe(speed);
    expect(priceRequest(facts.model.pricing!, { serviceTier: start.value.message.usage.speed }).rates?.input_tokens).toBe('0.000004');
  } else {
    expect(start.value.message.usage).not.toHaveProperty('speed');
  }
});

test('Messages uses the catalog wire ID for a matching opaque family', async () => {
  const facts = await factsFor('kimi-k9.9-code', [
    rawModel({ id: 'kimi-for-coding', display_name: 'K9.9 Code' }),
    rawModel({ id: 'kimi-for-coding-highspeed', display_name: 'K9.9 Code Highspeed' }),
  ]);
  const execution = run(asEntry(kimiCodePipelines.anthropicMessages), {
    ...facts, anthropicMessages: { model: facts.model.id, messages: [], max_tokens: 64, speed: 'fast' },
  }, optionsFor(async (_url, init) => {
    expect(jsonBody(init)).toMatchObject({ model: 'kimi-for-coding-highspeed' });
    return sse(messages);
  }));
  const answer = await execution.result;
  expect(answer.usageModelKey).toBe('kimi-for-coding-highspeed');
  if (answer.anthropicMessages.kind !== 'stream') throw new Error('Expected Messages stream');
  expect(await Array.fromAsync(execution.read(answer.anthropicMessages.stream))).toHaveLength(2);
});

test('a standard selection refuses the fast-only family before dialing Chat Completions or Messages', async () => {
  const facts = await factsFor('kimi-k2.7-code');
  const options = optionsFor(unexpectedDial);
  const chat = run(asEntry(kimiCodePipelines.openaiChatCompletions), {
    ...facts, openaiChatCompletions: { model: facts.model.id, messages: [], service_tier: 'standard' },
  }, options);
  const anthropic = run(asEntry(kimiCodePipelines.anthropicMessages), {
    ...facts, anthropicMessages: { model: facts.model.id, messages: [], max_tokens: 64, speed: 'standard' },
  }, options);
  await expect(chat.result).resolves.toMatchObject({ http: { status: 400 }, openaiChatCompletions: { kind: 'error', source: 'local' } });
  await expect(anthropic.result).resolves.toMatchObject({ http: { status: 400 }, anthropicMessages: { kind: 'error', source: 'local' } });
});

test.each(['standard', 'fast'])('count_tokens handles %s for the fast-only family', async speed => {
  const facts = await factsFor('kimi-k2.7-code');
  const fetcher: Fetcher = speed === 'fast' ? async (url, init) => {
    expect(url).toBe('https://api.kimi.com/coding/v1/messages/count_tokens');
    expect(jsonBody(init)).toMatchObject({ model: 'kimi-for-coding-highspeed' });
    return Response.json({ input_tokens: 7 });
  } : unexpectedDial;
  const execution = run(asEntry(kimiCodePipelines.anthropicMessagesCountTokens), {
    ...facts, anthropicMessagesCountTokens: { model: facts.model.id, messages: [], speed },
  }, optionsFor(fetcher));
  const expected = speed === 'fast'
    ? { http: { status: 200 }, anthropicMessagesCountTokens: { kind: 'result', result: { input_tokens: 7 } } }
    : { http: { status: 400 }, anthropicMessagesCountTokens: { kind: 'error', source: 'local' } };
  await expect(execution.result).resolves.toMatchObject(expected);
});
