import { expect, test } from 'vitest';

import { meteredStream } from './fixtures.ts';
import { computeUsage } from '../../../src/data-plane/pipeline/compute-usage.ts';
import { encode, encodedResponse, encodeStream, jsonResponse } from '../../../src/data-plane/pipeline/encode.ts';
import { compose, defineStage } from '../../../src/data-plane/pipeline/facts.ts';
import { createGatewayServices } from '../../../src/data-plane/pipeline/services.ts';
import { initRepo } from '../../../src/repo/index.ts';
import { generateServerSecret } from '../../../src/shared/server-secret.ts';
import { InMemoryRepo } from '../../repo/memory.ts';
import { run } from '@floway-dev/pipeline';

test.each([[200, 502], [429, 429]])('renders an upstream Embeddings error with HTTP %i as %i and retains its JSON media type', async (upstream, client) => {
  initRepo(new InMemoryRepo());
  const services = await createGatewayServices('TEST', { id: 'key', serverSecret: generateServerSecret(), openaiResponsesRetentionSeconds: 0 });
  const problem = { type: 'upstream-error', detail: 'The upstream response failed' };
  const terminal = defineStage({
    name: 'embeddings-error-fixture',
    request: { needs: [] },
    return: { provides: ['response.http', 'response.openaiEmbeddings'] },
    async execute() {
      return {
        'response.http': {
          status: upstream,
          statusText: '',
          headers: [['content-type', 'application/problem+json'], ['retry-after', '1']],
          body: null,
        },
        'response.openaiEmbeddings': { kind: 'error', source: 'upstream', error: problem },
      };
    },
  });
  const pipeline = compose('embeddings-encoding-fixture', {
    entry: [],
    exit: ['response.http', 'response.outcome'],
    stages: [encode('openaiEmbeddings', ({ http, outcome }) => {
      if (http === null || outcome.kind !== 'error') throw new Error('Expected the fixture HTTP error');
      return jsonResponse(http, outcome.error);
    })],
    ending: terminal,
  });
  const controller = new AbortController();
  const running = run(pipeline, {}, { services, signal: controller.signal, waitUntil() {} });
  const answer = await running.result;
  expect(await running.read(answer['response.outcome'])).toBe('upstream');
  controller.abort();
  expect(answer['response.http']).toMatchObject({
    status: client,
    headers: [['content-type', 'application/problem+json'], ['retry-after', '1']],
    body: new TextEncoder().encode(JSON.stringify(problem)),
  });
  await running.done;
});

test('a protocol source panic rejects both encoded body and recorded delivery outcome', async () => {
  initRepo(new InMemoryRepo());
  const services = await createGatewayServices('TEST', { id: 'key', serverSecret: generateServerSecret(), openaiResponsesRetentionSeconds: 0 });
  const release = Promise.withResolvers<void>();
  const pipeline = compose('encoder-source-panic-fixture', {
    entry: [],
    exit: ['response.http', 'response.outcome', 'response.usage'],
    stages: [
      encode('openaiCompletions', ({ http, outcome }, scope) => {
        if (http === null || outcome.kind !== 'stream') throw new Error('Expected the fixture stream');
        return encodedResponse(http, encodeStream(outcome.stream, scope, () => [new Uint8Array([1])]));
      }),
      computeUsage('openaiCompletions', { stream: () => ({ frame: () => undefined, done: () => [] }) }),
    ],
    ending: meteredStream({ release: release.promise }),
  });
  const controller = new AbortController();
  const running = run(pipeline, {}, { services, signal: controller.signal, waitUntil() {} });
  const answer = await running.result;
  const body = answer['response.http']?.body;
  if (!body || body instanceof Uint8Array) throw new Error('Expected a rendered HTTP stream');
  const reader = running.read(body);
  const verdict = running.read(answer['response.outcome']);
  const usage = running.read(answer['response.usage']);
  expect((await reader.next()).done).toBe(false);
  const defect = new Error('protocol stream defect');
  release.reject(defect);
  await Promise.all([
    expect(reader.next()).rejects.toBe(defect),
    expect(verdict).rejects.toBe(defect),
    expect(usage).rejects.toBe(defect),
    expect(running.done).rejects.toBe(defect),
  ]);
  controller.abort(defect);
});
