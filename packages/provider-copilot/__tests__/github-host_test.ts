import { test } from 'vitest';

import { githubApiOrigin, githubWebOrigin, normalizeGitHubHost } from '../src/github-host.ts';
import { assertEquals, assertThrows } from '@floway-dev/test-utils';

test('normalizeGitHubHost canonicalizes supported GitHub hosts', () => {
  assertEquals(normalizeGitHubHost(' github.com '), 'github.com');
  assertEquals(normalizeGitHubHost('Octocorp.GHE.com'), 'octocorp.ghe.com');
});

test('GitHub origins distinguish dotcom from a GHE.com tenant', () => {
  assertEquals(githubWebOrigin('github.com'), 'https://github.com');
  assertEquals(githubApiOrigin('github.com'), 'https://api.github.com');
  assertEquals(githubWebOrigin('octocorp.ghe.com'), 'https://octocorp.ghe.com');
  assertEquals(githubApiOrigin('octocorp.ghe.com'), 'https://api.octocorp.ghe.com');
});

test('normalizeGitHubHost rejects URLs, API hosts, and unrelated domains', () => {
  for (const value of [
    'https://github.com',
    'api.octocorp.ghe.com',
    'nested.octocorp.ghe.com',
    'github.example.com',
    'ghe.com',
  ]) {
    assertThrows(() => normalizeGitHubHost(value));
  }
});
