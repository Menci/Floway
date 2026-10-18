import { readFileSync } from 'node:fs';

import { parse } from 'jsonc-parser';
import { expect, test } from 'vitest';

const configPath = new URL('../../../wrangler.example.jsonc', import.meta.url);
const config = parse(readFileSync(configPath, 'utf8')) as {
  observability?: {
    enabled?: boolean;
    logs?: { enabled?: boolean; head_sampling_rate?: number };
    traces?: { enabled?: boolean; head_sampling_rate?: number };
  };
  triggers?: { crons?: string[] };
};

test('Cloudflare schedules one bounded maintenance tick per minute', () => {
  expect(config.triggers?.crons).toEqual(['* * * * *']);
});

test('Cloudflare samples persisted logs and traces at one percent', () => {
  expect(config.observability).toEqual({
    enabled: true,
    logs: { enabled: true, head_sampling_rate: 0.01 },
    traces: { enabled: true, head_sampling_rate: 0.01 },
  });
});
