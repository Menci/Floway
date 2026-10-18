import { readFileSync } from 'node:fs';

import { parse } from 'jsonc-parser';
import { expect, test } from 'vitest';

const configPath = new URL('../../../wrangler.example.jsonc', import.meta.url);
const config = parse(readFileSync(configPath, 'utf8')) as {
  observability?: {
    enabled?: boolean;
  };
  triggers?: { crons?: string[] };
};

test('Cloudflare schedules one bounded maintenance tick per minute', () => {
  expect(config.triggers?.crons).toEqual(['* * * * *']);
});

test('Cloudflare leaves deployment-specific observability disabled by default', () => {
  expect(config.observability).toEqual({ enabled: false });
});
