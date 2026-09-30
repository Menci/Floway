import { test } from 'vitest';

import { DurableObjectExecutionCellNamespace, type ExecutionDurableObjectNamespace } from '../src/durable-object-execution-cell.ts';
import { assertEquals } from '@floway-dev/test-utils';

test('DurableObject execution cells route a stable name to the matching stub', async () => {
  const names: string[] = [];
  const requests: Request[] = [];
  const namespace: ExecutionDurableObjectNamespace = {
    idFromName(name) {
      names.push(name);
      return name;
    },
    get(_id) {
      return {
        async fetch(request) {
          requests.push(request);
          return new Response('done');
        },
      };
    },
  };

  const cells = new DurableObjectExecutionCellNamespace(namespace);
  const response = await cells.fetch('models:upstream-a:3', new Request('https://execution.do/models/refresh'));

  assertEquals(names, ['models:upstream-a:3']);
  assertEquals(requests[0].url, 'https://execution.do/models/refresh');
  assertEquals(await response.text(), 'done');
});
