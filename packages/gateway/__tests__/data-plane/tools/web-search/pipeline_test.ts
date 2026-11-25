import { expect, test } from 'vitest';

import { createGatewayServices, type GatewayServices } from '../../../../src/data-plane/pipeline/services.ts';
import { runWebSearchSubrequest } from '../../../../src/data-plane/tools/web-search/pipeline.ts';
import type { WebSearchProvider } from '../../../../src/data-plane/tools/web-search/types.ts';
import { setupAppTest } from '../../../test-utils/app.ts';
import { run, type Pipeline } from '@floway-dev/pipeline';

test('web-search subrequest completes for an ordinary error and panics for a provider defect', async () => {
  const { apiKey } = await setupAppTest();
  const services = createGatewayServices({ requestBody: null, runtimeLocation: 'TEST', serverSecret: 'test-secret' });
  let done: Promise<void> | undefined;
  const runner = {
    run<I, O>(pipeline: Pipeline<I, O, GatewayServices>, facts: NoInfer<I>): Promise<O> {
      const handle = run(pipeline, facts, { services });
      done = handle.done;
      void handle.done.catch(() => {});
      return handle.result;
    },
  };
  const expected = { type: 'error', errorCode: 'unavailable' } as const;
  const provider: WebSearchProvider = {
    search: () => Promise.resolve(expected),
    fetchPage: () => Promise.reject(new Error('Unexpected page fetch')),
  };
  const args = { provider, providerName: 'tavily' as const, keyId: apiKey.key, request: { query: 'example' } };
  await expect(runWebSearchSubrequest(runner, args)).resolves.toEqual(expected);
  await expect(done).resolves.toBeUndefined();

  const defect = new TypeError('unexpected search failure');
  provider.search = () => Promise.reject(defect);
  await expect(runWebSearchSubrequest(runner, args)).rejects.toBe(defect);
  await expect(done).rejects.toBe(defect);
});
