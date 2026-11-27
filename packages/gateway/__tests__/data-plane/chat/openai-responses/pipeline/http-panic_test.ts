import { expect, test, vi } from 'vitest';

import { openAIResponsesHttpPanicPresentation } from '../../../../../src/data-plane/chat/openai-responses/http-panic.ts';
import { servePipelineHttp } from '../../../../../src/data-plane/shared/pipeline-http.ts';
import type { HttpResponseFact } from '@floway-dev/http';
import { asEntry, factSpace, type Deferred, type Result } from '@floway-dev/pipeline';

test('a panic before the first Responses event aborts and discards before closing the SSE response', async () => {
  const { defineStage, compose } = factSpace<object, { http: HttpResponseFact; residual: Deferred<void> }>();
  const pending = Promise.withResolvers<void>();
  const failure = new Error('panic before the first Responses event');
  let signal: AbortSignal | undefined;
  const ending = defineStage({
    name: 'responses-stream-panic-fixture',
    request: { needs: [] },
    return: { provides: ['http', 'residual'] },
    async execute(_facts, scope) {
      signal = scope.signal;
      const body = scope.createStream(async function* (): AsyncGenerator<Result<Uint8Array, never>> {
        throw failure;
      });
      return {
        http: { status: 200, statusText: '', headers: [['content-type', 'text/event-stream']], body },
        residual: scope.createDeferred(() => pending.promise),
      };
    },
  });
  const entry = asEntry(compose('responses-host-panic', { entry: [], exit: ['http', 'residual'], stages: [], ending }));
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  const work: Promise<unknown>[] = [];
  try {
    const response = await servePipelineHttp(entry, {}, {
      services: {},
      signal: new AbortController().signal,
      waitUntil(task) {
        expect(signal?.reason).toBe(failure);
        work.push(task);
      },
      panicPresentation: openAIResponsesHttpPanicPresentation,
    });
    const sse = await response.text();
    expect(sse).toContain('event: error');
    expect(sse).toContain(failure.message);
    expect(sse).not.toContain('event: response.failed');
    expect(sse.endsWith('data: [DONE]\n\n')).toBe(true);
    expect(work).toHaveLength(1);
    expect(log).toHaveBeenCalledWith('[pipeline-response]', failure);
  } finally {
    pending.resolve();
    await Promise.all(work);
    log.mockRestore();
  }
});
