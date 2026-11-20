import { test } from 'vitest';

import { normalizeGitHubHost } from '../src/github-host.ts';
import { assertThrows } from '@floway-dev/test-utils';

test('normalizeGitHubHost rejects URLs, API hosts, and unrelated domains', () => {
  for (const value of [
    'https://github.com',
    'api.octocorp.ghe.com',
    'github.example.com',
  ]) {
    assertThrows(() => normalizeGitHubHost(value));
  }
});
