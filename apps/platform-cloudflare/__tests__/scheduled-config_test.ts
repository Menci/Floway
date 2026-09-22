import { readFileSync } from 'node:fs';

import { parse } from 'jsonc-parser';
import { expect, test } from 'vitest';

const configPath = new URL('../../../wrangler.example.jsonc', import.meta.url);

test('Cloudflare schedules one bounded maintenance tick per minute', () => {
  const config = parse(readFileSync(configPath, 'utf8')) as {
    triggers?: { crons?: string[] };
  };

  expect(config.triggers?.crons).toEqual(['* * * * *']);
});
