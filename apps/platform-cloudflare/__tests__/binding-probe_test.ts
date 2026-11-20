import { expect, test } from 'vitest';

import { LogStreamState } from './test-utils/log-stream.ts';
import probe, { ExecutionDO, LogStreamDO } from '../../../.agents/skills/deploy-to-cloudflare/assets/binding-probe.js';

test('the first-deployment probe exercises every current platform binding', async () => {
  const observed: string[] = [];
  const execution = new ExecutionDO(new LogStreamState(), {});
  const log = new LogStreamDO(new LogStreamState(), {});
  const namespace = (name: string, actor: { fetch(): Response }) => ({
    idFromName: (id: string) => id,
    get: () => ({ fetch: async () => { observed.push(name); return actor.fetch(); } }),
  });
  const env = {
    DB: { prepare: () => ({ first: async () => { observed.push('DB'); return { value: 1 }; } }) },
    FILES: { head: async () => { observed.push('FILES'); return null; } },
    IMAGES: {
      info: async (stream: ReadableStream<Uint8Array>) => {
        expect((await new Response(stream).arrayBuffer()).byteLength).toBeGreaterThan(0);
        observed.push('IMAGES'); return { width: 1, height: 1 };
      },
    },
    KV: { get: async () => { observed.push('KV'); return null; } },
    EXECUTION_DO: namespace('EXECUTION_DO', execution),
    LOG_STREAM_DO: namespace('LOG_STREAM_DO', log),
  };
  const response = await probe.fetch(new Request('https://probe.test/api/deployment-probe'), env);
  expect(response.status).toBe(200);
  expect(await response.text()).toBe('Hello World');
  expect(response.headers.get('x-floway-binding-probe')).toBe('DB,FILES,IMAGES,KV,EXECUTION_DO,LOG_STREAM_DO');
  expect(observed.sort()).toEqual(Object.keys(env).sort());
});
